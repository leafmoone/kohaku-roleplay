"""Store immutable imported cards and portraits separately from session history."""

from contextlib import closing, contextmanager
from pathlib import Path
import sqlite3
from collections.abc import Iterator
from typing import TypedDict
from uuid import uuid4

from .cards import ParsedCard, card_format, parse_card


class CardSummary(TypedDict):
    id: str
    name: str
    version: int
    hasPortrait: bool


class CardNotFound(KeyError):
    """No imported character has this library identifier."""


@contextmanager
def _open(directory: Path) -> Iterator[sqlite3.Connection]:
    directory.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(directory / "cards.sqlite3")) as database, database:
        database.execute("PRAGMA foreign_keys = ON")
        database.execute("CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL, original BLOB NOT NULL, portrait BLOB, card TEXT NOT NULL)")
        database.execute("CREATE TABLE IF NOT EXISTS worldbooks (id TEXT PRIMARY KEY, name TEXT NOT NULL, original BLOB NOT NULL, entry_count INTEGER NOT NULL, supported_count INTEGER NOT NULL)")
        database.execute("CREATE TABLE IF NOT EXISTS card_worldbooks (card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE, worldbook_id TEXT NOT NULL REFERENCES worldbooks(id) ON DELETE CASCADE)")
        database.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)))")
        yield database


def card_scripts_default(directory: Path) -> bool:
    with _open(directory) as db:
        row = db.execute("SELECT enabled FROM settings WHERE key=?", ("card_scripts_default",)).fetchone()
    return row is None or bool(row[0])


def set_card_scripts_default(directory: Path, enabled: bool) -> None:
    with _open(directory) as db:
        db.execute("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET enabled=excluded.enabled",
                   ("card_scripts_default", int(enabled)))


def import_card(directory: Path, original: bytes) -> CardSummary:
    card = parse_card(original)
    key = uuid4().hex
    with _open(directory) as db:
        db.execute("INSERT INTO cards VALUES (?,?,?,?,?,?)", (key, card.fields.name, card.version, original, card.portrait, card.model_dump_json(exclude={"portrait"})))
    return CardSummary(id=key, name=card.fields.name, version=card.version, hasPortrait=card.portrait is not None)


def list_cards(directory: Path) -> list[CardSummary]:
    with _open(directory) as db:
        return [CardSummary(id=k, name=n, version=v, hasPortrait=bool(p)) for k,n,v,p in db.execute("SELECT id,name,version,portrait IS NOT NULL FROM cards ORDER BY name COLLATE NOCASE,id")]


def get_card(directory: Path, key: str, *, with_scripts: bool = False) -> ParsedCard:
    with _open(directory) as db:
        row = db.execute("SELECT card,portrait,substr(original,1,8) FROM cards WHERE id=?", (key,)).fetchone()
    if row is None:
        raise CardNotFound(key)
    card = ParsedCard.model_validate_json(row[0])
    if with_scripts and "scripts" not in card.model_fields_set:
        # Older imports retain the original card, so no re-import or mutation is necessary.
        card = card.model_copy(update={"scripts": parse_card(original_card(directory, key)).scripts})
    return card.model_copy(update={"portrait": row[1], "source_format": card.source_format or card_format(row[2])})


def remove_card(directory: Path, key: str) -> None:
    with _open(directory) as db:
        if db.execute("DELETE FROM cards WHERE id=?", (key,)).rowcount != 1:
            raise CardNotFound(key)


def original_card(directory: Path, key: str) -> bytes:
    with _open(directory) as db:
        row = db.execute("SELECT original FROM cards WHERE id=?", (key,)).fetchone()
    if row is None:
        raise CardNotFound(key)
    return row[0]
