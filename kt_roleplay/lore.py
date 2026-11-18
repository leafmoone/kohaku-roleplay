"""Select enabled world-info entries for a roleplay request."""

import re
from collections.abc import Callable, Sequence
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


SecondaryLogic = Literal["and_any", "not_all", "not_any", "and_all"]
LorePosition = Literal["before_char", "after_char", "before_notes", "after_notes", "at_depth"]


class LoreEntry(BaseModel):
    model_config = ConfigDict(strict=True)
    keys: list[str]
    content: str
    enabled: bool
    insertion_order: int
    name: str = ""
    comment: str = ""
    secondary_keys: list[str] = Field(default_factory=list)
    selective: bool = False
    secondary_logic: SecondaryLogic = "and_any"
    constant: bool = False
    case_sensitive: bool = False
    match_whole_words: bool = False
    scan_depth: int | None = Field(default=None, ge=0)
    priority: int = 0
    position: str = "after_char"
    depth: int = Field(default=4, ge=0)
    exclude_recursion: bool = False
    prevent_recursion: bool = False
    delay_until_recursion: bool = False

    def matches(self, text: str) -> bool:
        if not self.enabled:
            return False
        if self.constant:
            return True
        haystack = text if self.case_sensitive else text.casefold()

        def found(key: str) -> bool:
            if not key:
                return False
            key = key if self.case_sensitive else key.casefold()
            if self.match_whole_words and len(key.split()) == 1:
                return re.search(r"(?<!\w)" + re.escape(key) + r"(?!\w)", haystack) is not None
            return key in haystack

        if not any(found(key) for key in self.keys):
            return False
        secondary = [found(key) for key in self.secondary_keys if key]
        if not self.selective or not secondary:
            return True
        match self.secondary_logic:
            case "and_all":
                return all(secondary)
            case "not_all":
                return not all(secondary)
            case "not_any":
                return not any(secondary)
            case "and_any":
                return any(secondary)


class LoreBook(BaseModel):
    model_config = ConfigDict(strict=True)
    entries: list[LoreEntry]
    scan_depth: int = Field(default=4, ge=0)
    token_budget: int = Field(default=512, ge=0)
    recursive_scanning: bool = False
    issues: dict[str, int] = Field(default_factory=dict)

    def diagnostics(self) -> dict[str, object]:
        supported = len(self.entries)
        return {
            "totalEntries": supported + sum(self.issues.values()),
            "supportedEntries": supported,
            "issues": [{"code": key, "count": count} for key, count in sorted(self.issues.items())],
        }


def active_entries(book: LoreBook, history: Sequence[str], cost: Callable[[str], int], allowance: int) -> list[LoreEntry]:
    budget = min(book.token_budget, allowance)
    scan_text = {}
    recursive_text = []
    chosen = []
    selected = set()
    ordered = sorted(enumerate(book.entries), key=lambda row: -row[1].priority)
    # Bound the number of scans even when an imported book contains a long chain.
    for level in range(8 if book.recursive_scanning else 1):
        context = "\n".join(recursive_text)
        added = []
        for index, entry in ordered:
            if index in selected or (level and entry.exclude_recursion) or (not level and entry.delay_until_recursion):
                continue
            depth = book.scan_depth if entry.scan_depth is None else entry.scan_depth
            if depth not in scan_text:
                scan_text[depth] = "\n".join(history[-depth:]) if depth else ""
            visible = scan_text[depth]
            if context:
                visible += "\n" + context
            if not entry.matches(visible):
                continue
            size = cost(entry.content)
            if size <= budget:
                chosen.append(entry)
                selected.add(index)
                budget -= size
                if not entry.prevent_recursion and entry.content:
                    added.append(entry.content)
        if not added or not budget:
            break
        recursive_text.extend(added)
    return sorted(chosen, key=lambda item: item.insertion_order)
