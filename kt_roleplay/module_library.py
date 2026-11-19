"""Store reviewed module snapshots separately from character card originals."""

from pathlib import Path, PurePosixPath
from posixpath import normpath
from typing import TypedDict

from .charx import _member, is_charx, open_charx
from .errors import CardError
from .library import CardNotFound, _open, get_card
from .module_download import MAX_MODULE_BYTES, download_module
from .script_dependencies import script_dependencies

MAX_CARD_MODULES = 6
_MAX_TOTAL_BYTES = 3 * 1024 * 1024


class ModuleSnapshot(TypedDict):
    url: str
    size: int


def read_packaged_module(original: bytes, referring_member: str, specifier: str) -> tuple[str, bytes]:
    if not specifier.startswith(("./", "../")) or any(mark in specifier for mark in ("\\", ":", "?", "#", "%")):
        raise CardError("Use a plain relative path for a packaged module")
    member = normpath(str(PurePosixPath(referring_member).parent / specifier))
    if member.startswith(("/", "../")) or PurePosixPath(member).suffix not in (".js", ".mjs"):
        raise CardError("A packaged module must be a JavaScript file inside the CHARX archive")
    if not is_charx(original):
        raise CardError("Relative module is missing: only CHARX can carry separate files")
    with open_charx(original) as (archive, index):
        item = index.get(member)
        if item is None:
            raise CardError(f"Relative module is missing from the CHARX archive: {member}")
        if item.file_size > MAX_MODULE_BYTES:
            raise CardError("The packaged module exceeds 1 MiB")
        data = _member(archive, item)
    try:
        data.decode("utf-8-sig")
    except UnicodeError as exc:
        raise CardError("The packaged module is not UTF-8 JavaScript") from exc
    return member, data


def saved_modules(directory: Path, card_id: str) -> list[ModuleSnapshot]:
    with _open(directory) as db:
        rows = db.execute("SELECT url,length(source) FROM card_modules WHERE card_id=? ORDER BY url", (card_id,))
        return [ModuleSnapshot(url=url, size=size) for url, size in rows]


def module_sources(directory: Path, card_id: str) -> dict[str, bytes]:
    with _open(directory) as db:
        return dict(db.execute("SELECT url,source FROM card_modules WHERE card_id=?", (card_id,)))


def _validate_sources(directory: Path, card_id: str, urls: list[str]) -> None:
    if not 1 <= len(urls) <= MAX_CARD_MODULES or len(set(urls)) != len(urls):
        raise CardError("Confirm one to six distinct module sources")
    card = get_card(directory, card_id, with_scripts=True)
    declared = {ref["specifier"] for script in script_dependencies(card.scripts)
                if script["enabled"] and not script["syntaxError"] and not script["truncated"]
                for ref in script["references"] if ref["kind"] == "https"}
    if not set(urls) <= declared:
        raise CardError("Only literal HTTPS modules declared by this card's enabled scripts can be downloaded")


def snapshot_modules(directory: Path, card_id: str, urls: list[str]) -> list[ModuleSnapshot]:
    _validate_sources(directory, card_id, urls)
    installed = {row["url"]: row["size"] for row in saved_modules(directory, card_id)}
    if len(set(installed) | set(urls)) > MAX_CARD_MODULES:
        raise CardError("A card may have at most six saved modules")
    staged = {}
    total = sum(installed.values())
    for url in urls:
        if url in installed:
            continue
        content = download_module(url)
        total += len(content)
        if total > _MAX_TOTAL_BYTES:
            raise CardError("Saved modules for one card may not exceed 3 MiB")
        staged[url] = content
    with _open(directory) as db:
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT 1 FROM cards WHERE id=?", (card_id,)).fetchone() is None:
            raise CardNotFound(card_id)
        db.executemany("INSERT INTO card_modules(card_id, url, source) VALUES (?,?,?) ON CONFLICT DO NOTHING",
                       ((card_id, url, content) for url, content in staged.items()))
        rows = list(db.execute("SELECT url,length(source) FROM card_modules WHERE card_id=? ORDER BY url", (card_id,)))
        if len(rows) > MAX_CARD_MODULES or sum(size for _, size in rows) > _MAX_TOTAL_BYTES:
            raise CardError("Saved modules for one card may not exceed six modules or 3 MiB")
    return [ModuleSnapshot(url=url, size=size) for url, size in rows]
