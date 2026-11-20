"""Store reviewed module snapshots separately from character card originals."""

from contextlib import ExitStack, contextmanager
from pathlib import Path, PurePosixPath
from posixpath import normpath
from threading import Lock
from typing import TypedDict
from weakref import WeakValueDictionary

from .charx import _member, is_charx, open_charx
from .errors import CardError
from .library import CardNotFound, _open, get_card
from .module_download import download_module
from .script_dependencies import script_dependencies

_module_locks = WeakValueDictionary()
_module_locks_guard = Lock()


class ModuleSnapshot(TypedDict):
    url: str
    size: int


class PackagedModuleMissing(CardError):
    """A valid relative module path has no source file in this card."""


def read_packaged_module(original: bytes, referring_member: str, specifier: str) -> tuple[str, bytes]:
    if not specifier.startswith(("./", "../")) or any(mark in specifier for mark in ("\\", ":", "?", "#", "%")):
        raise CardError("Use a plain relative path for a packaged module")
    member = normpath(str(PurePosixPath(referring_member).parent / specifier))
    if member.startswith(("/", "../")) or PurePosixPath(member).suffix not in (".js", ".mjs"):
        raise CardError("A packaged module must be a JavaScript file inside the CHARX archive")
    if not is_charx(original):
        raise PackagedModuleMissing("Relative module is missing: only CHARX can carry separate files")
    with open_charx(original) as (archive, index):
        item = index.get(member)
        if item is None:
            raise PackagedModuleMissing(f"Relative module is missing from the CHARX archive: {member}")
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
    if not urls:
        raise CardError("Confirm at least one module source")
    card = get_card(directory, card_id, with_scripts=True)
    declared = {ref["specifier"] for script in script_dependencies(card.scripts)
                if script["enabled"] and not script["syntaxError"] and not script["truncated"]
                for ref in script["references"] if ref["kind"] == "https"}
    if not set(urls) <= declared:
        raise CardError("Only literal HTTPS modules declared by this card's enabled scripts can be downloaded")


@contextmanager
def module_snapshot_locks(directory: Path, urls: list[str]):
    """Coalesce simultaneous confirmations of the same exact URL within a library."""
    directory = directory.resolve()
    with _module_locks_guard:
        locks = [_module_locks.setdefault((directory, url), Lock()) for url in sorted(set(urls))]
    # Acquire in stable order so overlapping batches cannot deadlock.
    with ExitStack() as stack:
        for lock in locks:
            stack.enter_context(lock)
        yield


def confirmed_module_bytes(directory: Path, url: str) -> bytes:
    """Reuse bytes only after the calling path has verified this card's approval."""
    with _open(directory) as db:
        for table in ("card_modules", "card_opening_modules"):
            row = db.execute(f"SELECT source FROM {table} WHERE url=? ORDER BY card_id LIMIT 1", (url,)).fetchone()
            if row is not None:
                return row[0]
    return download_module(url)


def snapshot_modules(directory: Path, card_id: str, urls: list[str]) -> list[ModuleSnapshot]:
    _validate_sources(directory, card_id, urls)
    with module_snapshot_locks(directory, urls):
        installed = {row["url"] for row in saved_modules(directory, card_id)}
        staged = {url: confirmed_module_bytes(directory, url) for url in dict.fromkeys(urls) if url not in installed}
        if staged:
            with _open(directory) as db:
                db.execute("BEGIN IMMEDIATE")
                if db.execute("SELECT 1 FROM cards WHERE id=?", (card_id,)).fetchone() is None:
                    raise CardNotFound(card_id)
                db.executemany("INSERT INTO card_modules(card_id, url, source) VALUES (?,?,?) ON CONFLICT DO NOTHING",
                               ((card_id, url, content) for url, content in staged.items()))
        return saved_modules(directory, card_id)
