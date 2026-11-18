"""Author controls and static/selected portraits in the reusable card library."""

from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from .card_editor import updated_card
from .cards import MAX_CARD_BYTES, require_editable
from .errors import CardError
from .library import CardSummary, get_card, import_card, original_card
from .portraits import PortraitAsset, read_portraits


class PortraitCopy(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    id: str = Field(min_length=1)
    portraits: list[PortraitAsset]


def portrait_draft(directory: Path, key: str) -> dict[str, object]:
    card = get_card(directory, key)
    require_editable(card.source_format)
    return {"portraits": [a.model_dump(exclude_none=True) for a in card.portraits]}


def save_portraits_copy(directory: Path, request: PortraitCopy) -> CardSummary:
    original = original_card(directory, request.id)
    card = get_card(directory, request.id)
    require_editable(card.source_format)
    clean = read_portraits(request.portraits, card.state_fields, MAX_CARD_BYTES)
    encoded = [a.model_dump(exclude_none=True) for a in clean]

    def edit(data: dict) -> None:
        if not encoded and not card.portraits:
            return
        ext = data.setdefault("extensions", {})
        if not isinstance(ext, dict):
            raise CardError("Cannot save portraits to non-object extensions")
        namespace = ext.setdefault("kohaku-roleplay", {})
        if not isinstance(namespace, dict):
            raise CardError("extensions.kohaku-roleplay must be an object")
        if encoded:
            namespace["portraits"] = encoded
        else:
            namespace.pop("portraits", None)

    return import_card(directory, updated_card(original, edit))
