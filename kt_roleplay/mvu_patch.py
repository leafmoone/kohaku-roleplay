"""Apply the data-only MVU JSON Patch subset to an isolated session copy."""

import json
import re
from copy import deepcopy

from pydantic import JsonValue

from .mvu import MvuObserver, _json_mapping, _kind, array_index, existing_key, validate_updated_values


def json_equal(left: JsonValue, right: JsonValue) -> bool:
    if _kind(left) is not _kind(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(json_equal(value, right[key]) for key, value in left.items())
    if isinstance(left, list):
        return len(left) == len(right) and all(json_equal(a, b) for a, b in zip(left, right))
    return left == right


def apply_json_patch(values: dict[str, JsonValue], text: str, limit: int, *, observe: MvuObserver | None = None) -> dict[str, JsonValue]:
    try:
        commands = json.loads(text, object_pairs_hook=_json_mapping)
    except (ValueError, RecursionError) as exc:
        raise ValueError("Invalid MVU JSON Patch array") from exc
    if not isinstance(commands, list) or not 1 <= len(commands) <= limit:
        raise ValueError("Expected a nonempty bounded MVU JSON Patch array")
    updated = deepcopy(values)
    for command in commands:
        if not isinstance(command, dict):
            raise ValueError("An MVU JSON Patch operation must be an object")
        op, path = command.get("op"), command.get("path")
        if op not in ("replace", "test", "add", "remove"):
            raise ValueError("Unsupported MVU JSON Patch operation")
        keys = {"op", "path"} if op == "remove" else {"op", "path", "value"}
        if command.keys() != keys or not isinstance(path, str) or not path.startswith("/") or re.search(r"~(?![01])", path):
            raise ValueError("Invalid MVU JSON Patch operation or JSON Pointer")
        parts = [part.replace("~1", "/").replace("~0", "~") for part in path[1:].split("/")]
        if not 1 <= len(parts) <= 16 or any(not part for part in parts):
            raise ValueError("Invalid MVU JSON Patch path depth or segment")
        parent = updated
        for token in parts[:-1]:
            parent = parent[existing_key(parent, token)]
        if op in ("add", "remove"):
            if not isinstance(parent, list):
                raise ValueError("MVU JSON Patch add and remove only support arrays")
            index = array_index(parts[-1], len(parent), inserting=op == "add")
            previous = list(parent) if observe is not None else None
            if op == "add":
                parent.insert(index, command["value"])
            else:
                parent.pop(index)
            if observe is not None:
                updated = observe(updated, parts[:-1], previous, parent)
            continue
        key = existing_key(parent, parts[-1])
        current, value = parent[key], command["value"]
        if op == "test":
            if not json_equal(current, value):
                raise ValueError("MVU JSON Patch test does not match current state")
        elif isinstance(current, dict) or _kind(current) is not _kind(value):
            raise ValueError("MVU JSON Patch can only replace a non-object with the same type")
        else:
            parent[key] = value
            if observe is not None:
                updated = observe(updated, parts, current, value)
    return validate_updated_values(updated)
