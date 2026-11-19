"""Adapt standalone Tavern world info and embedded character books."""

import re
from collections import Counter

from pydantic import ValidationError

from .errors import CardError
from .lore import LoreBook, LoreEntry, LorePosition, SecondaryLogic
from .lore_regex import is_regex_key, valid_regex_key


_POSITIONS: dict[int, LorePosition] = {
    0: "before_char", 1: "after_char", 2: "before_notes", 3: "after_notes", 4: "at_depth", 7: "outlet",
}
_LOGIC: dict[int, SecondaryLogic] = {0: "and_any", 1: "not_all", 2: "not_any", 3: "and_all"}
_SCRIPT_CONTENT = re.compile(r"<%|<\s*(?:script|iframe)\b", re.IGNORECASE)
_UNSUPPORTED_TRIGGERS = (
    "vectorized", "ignoreBudget", "ignore_budget",
    "characterFilter", "character_filter", "automationId", "automation_id", "triggers",
    "matchCharacterDepthPrompt", "matchCharacterDescription", "matchCharacterPersonality",
    "matchCreatorNotes", "matchPersonaDescription", "matchScenario",
    "match_character_depth_prompt", "match_character_description", "match_character_personality",
    "match_creator_notes", "match_persona_description", "match_scenario",
)


class _SkippedEntry(Exception):
    pass


def _read_entry(item: object, *, standalone: bool) -> LoreEntry:
    if not isinstance(item, dict) or not isinstance(item.get("extensions", {}), dict):
        raise _SkippedEntry("invalid_entry")
    ext = item.get("extensions", {})
    fields = {**ext, **item}
    position = item.get("position", 0) if standalone else ext.get("position", item.get("position", "after_char"))
    if type(position) is int:
        position = _POSITIONS.get(position)
    if not isinstance(position, str) or position not in _POSITIONS.values():
        raise _SkippedEntry("unsupported_position")
    outlet = fields.get("outletName", fields.get("outlet_name", "")) if position == "outlet" else ""
    if not isinstance(outlet, str) or (position == "outlet" and not outlet.strip()):
        raise _SkippedEntry("invalid_entry")
    keys = item.get("key" if standalone else "keys", [])
    secondary = item.get("keysecondary" if standalone else "secondary_keys", [])
    if not isinstance(keys, list) or not isinstance(secondary, list):
        raise _SkippedEntry("invalid_entry")
    if any(isinstance(key, str) and is_regex_key(key) and not valid_regex_key(key) for key in (*keys, *secondary)):
        raise _SkippedEntry("unsupported_key")
    text = item.get("content")
    if isinstance(text, str) and _SCRIPT_CONTENT.search(text):
        raise _SkippedEntry("script_content")
    if any(fields.get(key) for key in _UNSUPPORTED_TRIGGERS):
        raise _SkippedEntry("unsupported_trigger")
    use_probability = fields.get("useProbability", fields.get("use_probability"))
    probability = fields.get("probability")
    if use_probability is not None and type(use_probability) is not bool:
        raise _SkippedEntry("invalid_entry")
    if use_probability is False or probability is None:
        probability = 100
    group = fields.get("group")
    if group is None:
        group = ""
    if not isinstance(group, str):
        raise _SkippedEntry("invalid_entry")
    group = ",".join(dict.fromkeys(name.strip() for name in group.split(",") if name.strip()))
    delay = fields.get("delayUntilRecursion", fields.get("delay_until_recursion", False))
    if delay not in (False, True, 0, 1):
        raise _SkippedEntry("unsupported_trigger")
    logic = fields.get("selectiveLogic", fields.get("secondary_logic", 0))
    if logic is None:
        logic = 0
    if type(logic) is int:
        logic = _LOGIC.get(logic)
    if logic not in _LOGIC.values():
        if item.get("selective") and secondary:
            raise _SkippedEntry("unsupported_trigger")
        logic = "and_any"
    if standalone and type(item.get("disable", False)) is not bool:
        raise _SkippedEntry("invalid_entry")
    order = item.get("order" if standalone else "insertion_order", 100)
    try:
        return LoreEntry.model_validate({
            "keys": keys, "secondary_keys": secondary, "content": text, "position": position, "outlet_name": outlet.strip(),
            "enabled": not item.get("disable", False) if standalone else item.get("enabled"),
            "insertion_order": order,
            "priority": item.get("priority", order if standalone else 0),
            "name": item.get("name", item.get("comment", "") if standalone else ""),
            "comment": item.get("comment", ""),
            "selective": item.get("selective", False), "secondary_logic": logic,
            "constant": item.get("constant", False),
            "case_sensitive": fields.get("caseSensitive", fields.get("case_sensitive")) or False,
            "match_whole_words": fields.get("matchWholeWords", fields.get("match_whole_words")) or False,
            "scan_depth": fields.get("scanDepth", fields.get("scan_depth")),
            "depth": fields.get("depth") if position == "at_depth" and fields.get("depth") is not None else 4,
            "exclude_recursion": fields.get("excludeRecursion", fields.get("exclude_recursion")) or False,
            "prevent_recursion": fields.get("preventRecursion", fields.get("prevent_recursion")) or False,
            "delay_until_recursion": bool(delay),
            "probability": probability,
            "group": group,
            "group_override": fields.get("groupOverride", fields.get("group_override", False)) if group else False,
            "group_weight": fields.get("groupWeight", fields.get("group_weight", 100)) if group else 100,
            "group_scoring": fields.get("useGroupScoring", fields.get("use_group_scoring")),
            "delay_messages": fields.get("delay") if fields.get("delay") is not None else 0,
            "sticky_messages": fields.get("sticky") if fields.get("sticky") is not None else 0,
            "cooldown_messages": fields.get("cooldown") if fields.get("cooldown") is not None else 0,
        })
    except ValidationError as exc:
        raise _SkippedEntry("invalid_entry") from exc


def read_worldbook(source: dict[str, object]) -> LoreBook:
    entries = source.get("entries")
    standalone = isinstance(entries, dict)
    if standalone:
        entries = entries.values()
    elif not isinstance(entries, list):
        raise CardError("World info needs an entries list or an entries object keyed by entry ID")
    rows = []
    skipped = Counter()
    for item in entries:
        try:
            rows.append(_read_entry(item, standalone=standalone))
        except _SkippedEntry as exc:
            skipped[str(exc)] += 1
    try:
        return LoreBook.model_validate({
            "entries": rows, "issues": dict(skipped),
            "scan_depth": source.get("scan_depth", source.get("scanDepth", 4)),
            "token_budget": source.get("token_budget", source.get("tokenBudget", 512)),
            "recursive_scanning": source.get("recursive_scanning", source.get("recursiveScanning", False)),
            "group_scoring": source.get("use_group_scoring", source.get("useGroupScoring")) or False,
        })
    except ValidationError as exc:
        labels = ", ".join(str(error["loc"][0]) for error in exc.errors(include_input=False))
        raise CardError(f"Invalid world-info settings: {labels}") from exc
