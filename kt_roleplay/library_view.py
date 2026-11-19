"""Read-only card views shared by library and session owners."""

import base64
from pathlib import Path

from .charx import CardMedia, read_charx_image
from .errors import CardError
from .library import get_card, list_cards, original_card
from .module_library import saved_modules
from .script_dependencies import script_dependencies


def cards_view(directory: Path) -> dict:
    return {"cards": list_cards(directory)}


def card_detail(directory: Path, key: str) -> dict:
    card = get_card(directory, key, with_scripts=True)
    book = card.lore
    summary = None
    if book is not None:
        diagnostics = book.diagnostics()
        summary = {"entryCount": diagnostics["totalEntries"], "scanDepth": book.scan_depth,
                   "tokenBudget": book.token_budget, "diagnostics": diagnostics}
    return {"id": key, "version": card.version, "fields": card.fields.model_dump(), "warnings": card.warnings,
            "gameplayPack": card.gameplay_pack.model_dump(exclude={'settings'}) if card.gameplay_pack else None,
            "hasPortrait": card.portrait is not None, "hasWorldbook": book is not None, "bookSummary": summary,
            "sourceFormat": card.source_format, "media": media_summary(card.media), "mediaIssues": card.media_issues,
            "cardScripts": [item.view() for item in card.scripts],
            "scriptDependencies": script_dependencies(card.scripts), "scriptModules": saved_modules(directory, key)}


def media_summary(assets: list[CardMedia]) -> list[dict[str, str]]:
    return [{"key": item.key, "name": item.name, "kind": item.kind} for item in assets]


def media_view(directory: Path, card_id: str, key: str) -> dict[str, str]:
    card = get_card(directory, card_id)
    asset = next((item for item in card.media if item.key == key), None)
    if asset is None or card.source_format != "charx":
        raise CardError("The card has no local image with that key")
    image = read_charx_image(original_card(directory, card_id), asset.member)
    return {"url": "data:image/png;base64," + base64.b64encode(image).decode("ascii")}


def portrait_view(directory: Path, key: str, variant: str | None) -> dict:
    card = get_card(directory, key)
    if variant is not None:
        for asset in card.portraits:
            if asset.key == variant:
                return {"url": "data:image/png;base64," + asset.data}
        raise CardError("No such portrait on this card")
    content = card.portrait
    return {"url": "data:image/png;base64," + base64.b64encode(content).decode("ascii") if content else None}
