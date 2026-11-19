"""Read MVU initial variables as data and apply a restricted set of typed changes."""

import json
from collections import Counter
from collections.abc import Callable
from copy import deepcopy
from math import isfinite
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, JsonValue
from yaml.events import AliasEvent, CollectionEndEvent, CollectionStartEvent
from yaml.nodes import MappingNode


_MAX_INIT_BYTES = 64 * 1024
_MAX_DEPTH = 16
_MAX_NODES = 2048


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


def _budget(value: JsonValue, depth: int = 0) -> int:
    if depth > _MAX_DEPTH:
        raise ValueError("MVU value exceeds its nesting limit")
    if isinstance(value, float) and not isfinite(value):
        raise ValueError("MVU numbers must be finite")
    if isinstance(value, dict):
        return 1 + sum(_budget(child, depth + 1) for child in value.values())
    if isinstance(value, list):
        return 1 + sum(_budget(child, depth + 1) for child in value)
    return 1


def _json_mapping(pairs: list[tuple[str, JsonValue]]) -> dict[str, JsonValue]:
    result = dict(pairs)
    if len(result) != len(pairs) or "" in result:
        raise ValueError("MVU initial data needs unique string keys")
    return result


def _yaml_data(text: str) -> object:
    depth = 0
    for i, event in enumerate(yaml.parse(text, Loader=_DataLoader)):
        if i > _MAX_NODES * 3 or isinstance(event, AliasEvent) or getattr(event, "anchor", None) or getattr(event, "tag", None):
            raise ValueError("MVU initializer uses non-data YAML syntax or exceeds its size limit")
        if isinstance(event, CollectionStartEvent):
            depth += 1
            if depth > _MAX_DEPTH:
                raise ValueError("MVU initializer exceeds its nesting limit")
        elif isinstance(event, CollectionEndEvent):
            depth -= 1
    return yaml.load(text, Loader=_DataLoader)


def _data(text: str) -> dict[str, JsonValue]:
    if len(text.encode("utf-8")) > _MAX_INIT_BYTES or "<%" in text:
        raise ValueError("MVU initializer requires static JSON or YAML")
    try:
        raw = json.loads(text, object_pairs_hook=_json_mapping)
    except json.JSONDecodeError:
        raw = _yaml_data(text)
    if not isinstance(raw, dict):
        raise ValueError("MVU initializer needs an object")
    if _budget(raw) > _MAX_NODES:
        raise ValueError("MVU initializer exceeds its value limit")
    return MvuInit.model_validate({"values": raw}).values


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
            if _budget(merged) > _MAX_NODES or len(json.dumps(merged, ensure_ascii=False).encode("utf-8")) > _MAX_INIT_BYTES:
                raise ValueError("Merged MVU initializer exceeds its value limit")
        except (ValueError, yaml.YAMLError, RecursionError):
            issues["invalid_initializer"] += 1
            continue
        values = merged
    return MvuInit(values=values, issues=dict(issues)) if detected else None


class MvuChange(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    path: list[str] = Field(min_length=1, max_length=_MAX_DEPTH)
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
                  guard: Callable[[tuple[str, ...], JsonValue], None] | None = None) -> dict[str, JsonValue]:
    """Validate a batch before replacing the current session snapshot."""
    updated = deepcopy(values)
    seen = set()
    for change in changes:
        path = tuple(change.path)
        if path in seen:
            raise ValueError("Repeated MVU variable in one batch")
        seen.add(path)
        parent = updated
        for part in path[:-1]:
            parent = parent[existing_key(parent, part)]
        key = existing_key(parent, path[-1])
        if _kind(change.value) != _kind(parent[key]):
            raise ValueError("Unknown or incompatible MVU variable")
        original = parent[key]
        if guard is not None:
            guard(path, original)
        if change.op == "add" and type(original) in (int, float) and type(change.value) in (int, float):
            value = original + change.value
        elif change.op == "set" and not isinstance(original, dict):
            value = change.value
        else:
            raise ValueError("Unsupported MVU update")
        _budget(value)
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
    if _budget(values) > _MAX_NODES or len(json.dumps(values, ensure_ascii=False).encode("utf-8")) > _MAX_INIT_BYTES:
        raise ValueError("MVU session exceeds its value limit")
    return values
