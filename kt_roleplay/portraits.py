"""Portable PNG portraits selected by public, committed session values."""

import base64
import binascii
from io import BytesIO
from typing import TypeAlias

from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, TypeAdapter, ValidationError

from .card_state import FieldKey, StateField, Value
from .errors import CardError

MatchValue: TypeAlias = str | int | float


class PortraitRule(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    key: FieldKey
    field: FieldKey | None = None
    equals: MatchValue | None = None


class PortraitAsset(PortraitRule):
    data: str


def _display_png(encoded: str) -> str:
    try:
        raw = base64.b64decode(encoded, validate=True)
        if not raw.endswith(b"\x00\x00\x00\x00IEND\xaeB`\x82"):
            raise CardError("Portrait PNG does not end with a complete IEND chunk")
        with Image.open(BytesIO(raw), formats=("PNG",)) as image:
            if image.width * image.height > 16_000_000 or image.is_animated:
                raise CardError("Use a still portrait PNG of at most 16 megapixels")
            image.verify()
        with Image.open(BytesIO(raw), formats=("PNG",)) as image:
            image.thumbnail((480, 640))
            clean = image.convert("RGBA")
            clean.info.clear()
            target = BytesIO()
            clean.save(target, format="PNG")
            return base64.b64encode(target.getvalue()).decode("ascii")
    except CardError:
        raise
    except (OSError, SyntaxError, ValueError, binascii.Error, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise CardError("Portrait data must be a complete Base64-encoded PNG") from exc


def read_portraits(value: object, definitions: list[StateField], byte_limit: int) -> list[PortraitAsset]:
    try:
        assets = TypeAdapter(list[PortraitAsset]).validate_python(value, strict=True)
    except ValidationError as exc:
        issue = exc.errors(include_input=False)[0]
        raise CardError(f"Invalid portrait at {issue['loc']}: {issue['msg']}") from exc
    public = {f.key: f for f in definitions if f.visibility == "public"}
    keys = set()
    conditions = set()
    clean = []
    size = 0
    for asset in assets:
        size += len(asset.data)
        if size > 4 * ((byte_limit + 2) // 3):
            raise CardError("Combined portrait data exceeds the card size limit")
        if asset.key in keys or (asset.field, asset.equals) in conditions:
            raise CardError("Portrait keys and conditions (including default) must be unique")
        if asset.field is None:
            if asset.equals is not None:
                raise CardError("A portrait condition needs both a public field and a value")
        else:
            field = public.get(asset.field)
            if field is None or field.type not in ("text", "number", "enum") or asset.equals is None:
                raise CardError("Select a public text, enum or number field for a portrait condition")
            try:
                field.check(asset.equals)
            except ValueError as exc:
                raise CardError(str(exc)) from exc
        keys.add(asset.key)
        conditions.add((asset.field, asset.equals))
        clean.append(asset.model_copy(update={"data": _display_png(asset.data)}))
    return clean


def rules_for(assets: list[PortraitAsset]) -> list[PortraitRule]:
    return [PortraitRule(key=a.key, field=a.field, equals=a.equals) for a in assets]


def chosen_key(rules: list[PortraitRule], definitions: list[StateField], values: dict[str, Value]) -> str | None:
    public = {f.key: values.get(f.key, f.initial) for f in definitions if f.visibility == "public"}
    default = None
    for rule in rules:
        if rule.field is None:
            default = rule.key
        elif rule.field in public and public[rule.field] == rule.equals:
            return rule.key
    return default
