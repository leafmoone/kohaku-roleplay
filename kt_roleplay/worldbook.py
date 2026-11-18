"""Normalize a standalone Tavern world-info export for one session."""

from .errors import CardError
from .lore import LoreBook, load_book


def read_worldbook(source: dict[str, object]) -> LoreBook:
    entries = source.get("entries")
    if isinstance(entries, list):
        return load_book(source)
    if not isinstance(entries, dict):
        raise CardError("World info needs an entries list or an entries object keyed by entry ID")
    rows = []
    for uid, item in entries.items():
        if not isinstance(item, dict):
            raise CardError(f"World-info entry {uid} is not an object")
        if type(item.get("disable", False)) is not bool:
            raise CardError(f"World-info entry {uid}: disable must be a boolean")
        if item.get("selectiveLogic", 0) != 0 and item.get("selective"):
            raise CardError(f"World-info entry {uid} uses unsupported secondary-key logic")
        position = item.get("position", 0)
        if position not in (0, 1):
            raise CardError(f"World-info entry {uid}: only before/after character positions are supported")
        rows.append({
            "keys": item.get("key", []), "secondary_keys": item.get("keysecondary", []),
            "content": item.get("content"), "enabled": not item.get("disable", False),
            "insertion_order": item.get("order", 100), "case_sensitive": item.get("caseSensitive") or False,
            "selective": item.get("selective", False) and bool(item.get("keysecondary")),
            "constant": item.get("constant", False), "name": item.get("comment", ""),
            "position": "before_char" if position == 0 else "after_char",
        })
    return load_book({**source, "entries": rows})
