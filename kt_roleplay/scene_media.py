"""Resolve declared local scene-image rules to existing public-state selectors."""

from collections import Counter

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .card_state import FieldKey, StateField
from .charx import CardMedia
from .portraits import MatchValue, PortraitRule


class SceneImage(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    asset: str = Field(min_length=1)
    field: FieldKey | None = None
    equals: MatchValue | None = None


def read_scene_media(value: object, media: list[CardMedia], fields: list[StateField]) -> tuple[list[PortraitRule], int]:
    if not isinstance(value, list):
        return [], 1
    public = {field.key: field for field in fields if field.visibility == "public" and field.type != "list"}
    counts = Counter(asset.name for asset in media)
    keys = {asset.name: asset.key for asset in media if counts[asset.name] == 1}
    rules = []
    seen = set()
    invalid = 0
    for raw in value:
        try:
            spec = SceneImage.model_validate(raw)
            key = keys.get(spec.asset)
            condition = (spec.field, spec.equals)
            if key is None or condition in seen or (spec.field is None) != (spec.equals is None):
                raise ValueError("Scene image rule must reference a unique local asset and have a distinct valid condition")
            if spec.field is not None:
                field = public.get(spec.field)
                if field is None:
                    raise ValueError("Scene image rules may only use a public scalar field")
                field.check(spec.equals)
        except (ValidationError, ValueError):
            invalid += 1
            continue
        seen.add(condition)
        rules.append(PortraitRule(key=key, field=spec.field, equals=spec.equals))
    return rules, invalid
