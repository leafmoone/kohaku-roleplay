"""Read MVU initial variables as data and apply a restricted set of typed changes."""

import json
from collections import Counter
from collections.abc import Callable
from copy import deepcopy
from math import isfinite
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, JsonValue
from yaml.events import AliasEvent
from yaml.nodes import MappingNode


class MvuInit(BaseModel):
    model_config = ConfigDict(strict=True)
    values: dict[str, JsonValue] = Field(default_factory=dict)
    issues: dict[str, int] = Field(default_factory=dict)


class _DataLoader(yaml.SafeLoader):
    def construct_mapping(self, node: MappingNode, deep: bool = False) -> dict:
        result = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str) or not key or key in result:
                raise ValueError("MVU initial data needs unique string keys")
            result[key] = self.construct_object(value_node, deep=deep)
        return result


def _json_mapping(pairs: list[tuple[str, JsonValue]]) -> dict[str, JsonValue]:
    result = dict(pairs)
    if len(result) != len(pairs) or "" in result:
        raise ValueError("MVU initial data needs unique string keys")
    return result


def _yaml_data(text: str) -> object:
    for event in yaml.parse(text, Loader=_DataLoader):
        if isinstance(event, AliasEvent) or getattr(event, "anchor", None) or getattr(event, "tag", None):
            raise ValueError("MVU initializer uses non-data YAML syntax")
    return yaml.load(text, Loader=_DataLoader)


def _data(text: str) -> dict[str, JsonValue]:
    if "<%" in text:
        raise ValueError("MVU initializer requires static JSON or YAML")
    try:
        raw = json.loads(text, object_pairs_hook=_json_mapping)
    except json.JSONDecodeError:
        raw = _yaml_data(text)
    if not isinstance(raw, dict):
        raise ValueError("MVU initializer needs an object")
    return validate_updated_values(MvuInit.model_validate({"values": raw}).values)


def _overlay(base: dict[str, JsonValue], more: dict[str, JsonValue]) -> dict[str, JsonValue]:
    merged = dict(base)
    for key, value in more.items():
        previous = merged.get(key)
        merged[key] = _overlay(previous, value) if isinstance(previous, dict) and isinstance(value, dict) else value
    return merged


def is_initializer(*labels: object) -> bool:
    return any(isinstance(label, str) and "[initvar]" in label.casefold() for label in labels)


def inspect_initializers(book: dict[str, object] | None) -> MvuInit | None:
    entries = book.get("entries", []) if book else []
    if isinstance(entries, dict):
        entries = list(entries.values())
    if not isinstance(entries, list):
        return None
    values: dict[str, JsonValue] = {}
    issues: Counter[str] = Counter()
    detected = False
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if not is_initializer(entry.get("comment"), entry.get("name")):
            continue
        # MVU initializers are identified by their marker, not by lore activation.
        detected = True
        content = entry.get("content")
        try:
            if not isinstance(content, str):
                raise ValueError("MVU initializer has no text")
            merged = _overlay(values, _data(content))
        except (ValueError, yaml.YAMLError, RecursionError):
            issues["invalid_initializer"] += 1
            continue
        values = merged
    return MvuInit(values=values, issues=dict(issues)) if detected else None


class MvuChange(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    path: list[str] = Field(min_length=1)
    op: Literal["set", "add"]
    value: JsonValue


def _leaves(node: dict[str, JsonValue], prefix: tuple[str, ...] = ()):
    for key, value in node.items():
        path = (*prefix, key)
        if isinstance(value, dict):
            yield from _leaves(value, path)
        else:
            yield {"id": json.dumps(path, ensure_ascii=False), "label": " / ".join(path)}, value


def public_options(values: dict[str, JsonValue]) -> list[dict[str, str]]:
    return [option for option, _ in _leaves(values)]


def public_values(values: dict[str, JsonValue], selections: list[str]) -> list[dict[str, JsonValue]]:
    chosen = set(selections)
    return [{**option, "value": value} for option, value in _leaves(values) if option["id"] in chosen]


def _kind(value: JsonValue) -> type:
    return float if type(value) in (int, float) else type(value)


MvuObserver = Callable[[dict[str, JsonValue], list[str], JsonValue, JsonValue], dict[str, JsonValue]]


def apply_changes(values: dict[str, JsonValue], changes: list[MvuChange], *, observe: MvuObserver | None = None,
                  guard: Callable[[tuple[str, ...], JsonValue], None] | None = None,
                  legacy_descriptions: bool = False) -> dict[str, JsonValue]:
    """Validate a batch before replacing the current session snapshot."""
    updated = deepcopy(values)
    seen = set()
    for change in changes:
        path = tuple(change.path)
        parent = updated
        for part in path[:-1]:
            parent = parent[existing_key(parent, part)]
        key = existing_key(parent, path[-1])
        slot = parent[key]
        # Legacy scalar _.set addresses the value of a [value, description] pair.
        # Explicit array replacements and JSON Pointer / typed writes retain their old meaning.
        described = (legacy_descriptions and change.op == 'set' and isinstance(slot, list) and len(slot) == 2
                     and isinstance(slot[1], str) and not isinstance(slot[0], (dict, list))
                     and not isinstance(change.value, (dict, list)))
        target = (*path, '0') if described else path
        if path in seen or target in seen:
            raise ValueError('Repeated MVU variable in one batch')
        seen.update((path, target))
        if described:
            parent, key = slot, 0
        original = parent[key]
        if _kind(change.value) != _kind(original):
            raise ValueError('Unknown or incompatible MVU variable')
        if guard is not None:
            guard(path, original)
        if change.op == "add" and type(original) in (int, float) and type(change.value) in (int, float):
            value = original + change.value
        elif change.op == "set" and not isinstance(original, dict):
            value = change.value
        else:
            raise ValueError("Unsupported MVU update")
        if isinstance(value, float) and not isfinite(value):
            raise ValueError("MVU numbers must be finite")
        parent[key] = value
        if observe is not None:
            updated = observe(updated, change.path, original, value)
    return validate_updated_values(updated)


def array_index(token: str, length: int, *, inserting: bool = False) -> int:
    if inserting and token == "-":
        return length
    if (not token or len(token) > len(str(length)) or (len(token) > 1 and token[0] == "0")
            or not token.isascii() or not token.isdecimal()):
        raise ValueError("Invalid MVU array index")
    index = int(token)
    if index >= length + int(inserting):
        raise ValueError("MVU array index out of bounds")
    return index


def existing_key(parent: JsonValue, token: str) -> str | int:
    if isinstance(parent, list):
        return array_index(token, len(parent))
    if isinstance(parent, dict) and token in parent:
        return token
    raise ValueError("Unknown MVU variable path")


def validate_updated_values(values: dict[str, JsonValue]) -> dict[str, JsonValue]:
    json.dumps(values, ensure_ascii=False, allow_nan=False).encode("utf-8")
    return values
