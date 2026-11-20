"""Select enabled world-info entries for a roleplay request."""

import re
from collections.abc import Callable, Mapping, Sequence
from random import random
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .lore_regex import MatchBudget, is_regex_key
from .lore_timing import LoreTiming


SecondaryLogic = Literal["and_any", "not_all", "not_any", "and_all"]
LorePosition = Literal["before_char", "after_char", "before_notes", "after_notes", "at_depth", "outlet"]


class LoreEntry(BaseModel):
    model_config = ConfigDict(strict=True)
    keys: list[str]
    content: str
    content_template: bool = False
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
    probability: float = Field(default=100, ge=0, le=100, allow_inf_nan=False)
    group: str = ""
    group_override: bool = False
    group_weight: int = Field(default=100, ge=1, le=10_000)
    group_scoring: bool | None = None
    delay_messages: int = Field(default=0, ge=0)
    sticky_messages: int = Field(default=0, ge=0)
    cooldown_messages: int = Field(default=0, ge=0)
    outlet_name: str = Field(default="", max_length=120, pattern=r"^[^{}\r\n]*$")

    def matches(self, text: str) -> bool:
        try:
            return self.match_score(text) is not None
        except TimeoutError:
            return False

    def match_score(self, text: str, regex_budget: MatchBudget | None = None) -> int | None:
        if not self.enabled:
            return None
        if self.constant:
            return 0
        haystack = text if self.case_sensitive else text.casefold()

        def found(key: str) -> bool:
            if not key:
                return False
            if is_regex_key(key):
                return (regex_budget if regex_budget is not None else MatchBudget()).found(key, text)
            key = key if self.case_sensitive else key.casefold()
            if self.match_whole_words and len(key.split()) == 1:
                return re.search(r"(?<!\w)" + re.escape(key) + r"(?!\w)", haystack) is not None
            return key in haystack

        primary = sum(found(key) for key in self.keys)
        if not primary:
            return None
        secondary = [found(key) for key in self.secondary_keys if key] if self.selective else []
        if not secondary:
            return primary
        match self.secondary_logic:
            case "and_all":
                return primary + len(secondary) if all(secondary) else None
            case "not_all":
                return primary if not all(secondary) else None
            case "not_any":
                return primary if not any(secondary) else None
            case "and_any":
                return primary + 1 if any(secondary) else None


class LoreBook(BaseModel):
    model_config = ConfigDict(strict=True)
    entries: list[LoreEntry]
    scan_depth: int = Field(default=4, ge=0)
    token_budget: int = Field(default=512, ge=0)
    recursive_scanning: bool = False
    group_scoring: bool = False
    issues: dict[str, int] = Field(default_factory=dict)

    def diagnostics(self) -> dict[str, object]:
        supported = len(self.entries)
        return {
            "totalEntries": supported + sum(self.issues.values()),
            "supportedEntries": supported,
            "issues": [{"code": key, "count": count} for key, count in sorted(self.issues.items())],
        }


def _weighted_winner(group: list[tuple[int, LoreEntry]]) -> int:
    if len(group) == 1:
        return group[0][0]
    roll = random() * sum(e.group_weight for _, e in group)
    for index, entry in group:
        roll -= entry.group_weight
        if roll < 0:
            return index
    return group[-1][0]


def active_entries(book: LoreBook, history: Sequence[str], cost: Callable[[str], int], allowance: int,
                   *, chat_messages: int | None = None, regex_budget: MatchBudget | None = None,
                   outlets: frozenset[str] = frozenset(), timing: LoreTiming | None = None,
                   rendered_templates: Mapping[str, str] | None = None) -> list[LoreEntry]:
    if regex_budget is None:
        regex_budget = MatchBudget()
    budget = min(book.token_budget, allowance)
    message_count = len(history) if chat_messages is None else chat_messages
    scan_text = {}
    recursive_text = []
    chosen = []
    selected = set()
    blocked = set()
    accepted_groups = set()
    rendered = rendered_templates or {}
    # Keep snapshot indexes stable for timers, even when conditional content is absent.
    ready = ((index, entry.model_copy(update={'content': rendered[entry.content]}) if entry.content_template else entry)
             for index, entry in enumerate(book.entries) if not entry.content_template or entry.content in rendered)
    ordered = sorted(ready, key=lambda row: -row[1].priority)
    memberships = {index: set(entry.group.split(',')) if entry.group else set() for index, entry in ordered}
    effects = {index: timing.status(index, entry.sticky_messages, entry.cooldown_messages)
               for index, entry in enumerate(book.entries)
               if timing is not None and entry.enabled and (entry.sticky_messages or entry.cooldown_messages)}
    # Bound the number of scans even when an imported book contains a long chain.
    for level in range(8 if book.recursive_scanning else 1):
        context = "\n".join(recursive_text)
        added = []
        candidates = []
        groups = {}
        scores = {}
        for index, entry in ordered:
            if (index in selected or index in blocked or memberships[index] & accepted_groups
                    or entry.delay_messages > message_count
                    or (entry.position == "outlet" and entry.outlet_name not in outlets)):
                continue
            effect = effects.get(index)
            if effect == "cooldown":
                continue
            if effect == "active":
                scores[index] = 0
                candidates.append((index, entry))
                for name in sorted(memberships[index]):
                    groups.setdefault(name, []).append((index, entry))
                continue
            if (level and entry.exclude_recursion) or (not level and entry.delay_until_recursion):
                continue
            depth = book.scan_depth if entry.scan_depth is None else entry.scan_depth
            if depth not in scan_text:
                scan_text[depth] = "\n".join(history[-depth:]) if depth else ""
            visible = scan_text[depth]
            if context:
                visible += "\n" + context
            try:
                score = entry.match_score(visible, regex_budget)
            except TimeoutError:
                blocked.add(index)
                continue
            if score is None:
                continue
            scores[index] = score
            candidates.append((index, entry))
            for name in sorted(memberships[index]):
                groups.setdefault(name, []).append((index, entry))
        excluded = set()
        for items in groups.values():
            # Scoring applies to entries opting in (or inheriting it from the book).
            high = max(scores[index] for index, _ in items)
            excluded.update(index for index, entry in items if effects.get(index) != "active"
                            and (book.group_scoring if entry.group_scoring is None else entry.group_scoring) and scores[index] < high)
        winners = set()
        reserved = set()
        for index, _ in candidates:
            if effects.get(index) == "active" and not memberships[index] & reserved:
                winners.add(index)
                reserved.update(memberships[index])
        # Resolve all explicit priorities before an ordinary draw can claim a shared group.
        overrides = sorted((row for row in candidates if row[0] not in excluded and row[1].group and row[1].group_override),
                           key=lambda row: (-row[1].insertion_order, row[0]))
        for index, _ in overrides:
            if not memberships[index] & reserved:
                winners.add(index)
                reserved.update(memberships[index])
        for name, items in groups.items():
            if name in reserved:
                continue
            eligible = [row for row in items if row[0] not in excluded and not memberships[row[0]] & reserved]
            if eligible:
                winner = _weighted_winner(eligible)
                winners.add(winner)
                reserved.update(memberships[winner])
        for index, entry in sorted(candidates, key=lambda row: effects.get(row[0]) != "active"):
            if entry.group and index not in winners:
                blocked.add(index)
                continue
            # Match ST's group selection before trigger chance; never re-roll a failed entry in recursion.
            if effects.get(index) != "active" and entry.probability < 100 and (entry.probability == 0 or random() * 100 >= entry.probability):
                blocked.add(index)
                continue
            size = cost(entry.content)
            if size <= budget:
                chosen.append(entry)
                selected.add(index)
                accepted_groups.update(memberships[index])
                budget -= size
                if timing is not None:
                    timing.activate(index, entry.sticky_messages, entry.cooldown_messages)
                if not entry.prevent_recursion and entry.content:
                    added.append(entry.content)
        if not added or not budget:
            break
        recursive_text.extend(added)
    return sorted(chosen, key=lambda item: item.insertion_order)
