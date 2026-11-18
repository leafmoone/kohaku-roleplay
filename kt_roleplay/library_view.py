"""Read-only card views shared by library and session owners."""

import base64
from pathlib import Path

from .library import get_card, list_cards
from .lore import load_book


def cards_view(directory: Path) -> dict:
    return {"cards": list_cards(directory)}


def card_detail(directory: Path, key: str) -> dict:
    card = get_card(directory, key)
    book = load_book(card.book) if card.book is not None else None
    return {"id": key, "version": card.version, "fields": card.fields.model_dump(), "warnings": card.warnings, "hasPortrait": card.portrait is not None, "hasWorldbook": book is not None, "bookSummary": {"entryCount": len(book.entries), "scanDepth": book.scan_depth, "tokenBudget": book.token_budget} if book is not None else None}


def portrait_view(directory: Path, key: str) -> dict:
    content = get_card(directory, key).portrait
    return {"url": "data:image/png;base64," + base64.b64encode(content).decode("ascii") if content else None}
