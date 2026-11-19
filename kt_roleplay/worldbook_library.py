"""Reusable world-info documents and card defaults, separate from play snapshots."""

import json
from pathlib import Path
from uuid import uuid4

from typing_extensions import TypedDict

from .errors import CardError
from .library import CardNotFound, _open, get_card
from .lore import LoreBook
from .worldbook import read_worldbook

MAX_WORLDBOOK_BYTES = 2 * 1024 * 1024
_MAX_ENTRIES = 4_096


class WorldbookReference(TypedDict):
    id: str
    name: str


class WorldbookSummary(WorldbookReference):
    totalEntries: int
    supportedEntries: int


class WorldbookNotFound(KeyError):
    """The worldbook is not in the current library."""


def _document(original: bytes) -> dict:
    if not 0 < len(original) <= MAX_WORLDBOOK_BYTES:
        raise CardError("Choose a non-empty JSON worldbook no larger than 2 MiB")
    try:
        value = json.loads(original.decode("utf-8-sig"))
        # Reject lone JSON surrogates and non-standard numbers before building display or prompt text.
        json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise CardError("Worldbook data must be a UTF-8 JSON document") from exc
    if not isinstance(value, dict):
        raise CardError("Worldbook root must be an object")
    if isinstance(entries := value.get("entries"), (dict, list)) and len(entries) > _MAX_ENTRIES:
        raise CardError(f"A library worldbook can contain at most {_MAX_ENTRIES} entries")
    return value


def _name(name: str) -> str:
    name = name.strip()
    if name.lower().endswith(".json"):
        name = name[:-5].rstrip()
    if not name or len(name) > 120 or any(ord(c) < 32 or 0xD800 <= ord(c) <= 0xDFFF for c in name):
        raise CardError("Worldbook name must contain 1–120 visible characters")
    return name


def _detail(name: str, source: dict) -> dict:
    entries = []
    book = read_worldbook(source, preview=entries)
    return {"name": name, "diagnostics": book.diagnostics(), "entries": entries}


def snapshot_detail(name: str, book: LoreBook) -> dict:
    entries = [{"index": index, "name": entry.name or entry.comment, "content": entry.content,
                "keys": entry.keys, "secondaryKeys": entry.secondary_keys, "position": entry.position,
                "enabled": entry.enabled, "issue": None} for index, entry in enumerate(book.entries)]
    return {"name": name, "diagnostics": book.diagnostics(), "entries": entries}


def preview_worldbook(original: bytes, name: str) -> dict:
    return _detail(_name(name), _document(original))


def import_worldbook(directory: Path, original: bytes, name: str) -> WorldbookSummary:
    name = _name(name)
    stats = read_worldbook(_document(original)).diagnostics()
    key = uuid4().hex
    with _open(directory) as db:
        db.execute("INSERT INTO worldbooks VALUES (?,?,?,?,?)",
                   (key, name, original, stats["totalEntries"], stats["supportedEntries"]))
    return WorldbookSummary(id=key, name=name, totalEntries=stats["totalEntries"], supportedEntries=stats["supportedEntries"])


def list_worldbooks(directory: Path) -> tuple[list[WorldbookSummary], dict[str, str]]:
    with _open(directory) as db:
        rows = db.execute("SELECT id,name,entry_count,supported_count FROM worldbooks ORDER BY name COLLATE NOCASE,id")
        summaries = [WorldbookSummary(id=key, name=name, totalEntries=n, supportedEntries=ok) for key, name, n, ok in rows]
        defaults = dict(db.execute("SELECT card_id,worldbook_id FROM card_worldbooks"))
    return summaries, defaults


def original_worldbook(directory: Path, key: str) -> tuple[WorldbookReference, bytes]:
    with _open(directory) as db:
        row = db.execute("SELECT name,original FROM worldbooks WHERE id=?", (key,)).fetchone()
    if row is None:
        raise WorldbookNotFound(key)
    return WorldbookReference(id=key, name=row[0]), row[1]


def embedded_worldbook(directory: Path, key: str) -> dict | None:
    card = get_card(directory, key)
    if card.book is None:
        return None
    return _detail(card.fields.name, card.book)


def worldbook_detail(directory: Path, key: str) -> dict:
    ref, original = original_worldbook(directory, key)
    return _detail(ref["name"], _document(original))


def worldbook_for_play(directory: Path, key: str) -> tuple[WorldbookReference, LoreBook]:
    ref, original = original_worldbook(directory, key)
    return ref, read_worldbook(_document(original))


def remove_worldbook(directory: Path, key: str) -> None:
    with _open(directory) as db:
        if db.execute("DELETE FROM worldbooks WHERE id=?", (key,)).rowcount != 1:
            raise WorldbookNotFound(key)


def default_worldbook(directory: Path, card_id: str) -> str | None:
    with _open(directory) as db:
        row = db.execute("SELECT worldbook_id FROM card_worldbooks WHERE card_id=?", (card_id,)).fetchone()
    return row[0] if row else None


def set_default_worldbook(directory: Path, card_id: str, book_id: str | None) -> None:
    with _open(directory) as db:
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT 1 FROM cards WHERE id=?", (card_id,)).fetchone() is None:
            raise CardNotFound(card_id)
        if book_id is None:
            db.execute("DELETE FROM card_worldbooks WHERE card_id=?", (card_id,))
        elif db.execute("SELECT 1 FROM worldbooks WHERE id=?", (book_id,)).fetchone() is None:
            raise WorldbookNotFound(book_id)
        else:
            db.execute("INSERT INTO card_worldbooks VALUES (?,?) ON CONFLICT(card_id) DO UPDATE SET worldbook_id=excluded.worldbook_id",
                       (card_id, book_id))
