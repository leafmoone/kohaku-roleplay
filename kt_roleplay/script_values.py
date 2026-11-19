"""Validate the data exchanged with card JavaScript without importing KT or its I/O."""

from pydantic import JsonValue

from .mvu import MvuChange, _kind, apply_changes
from .mvu_patch import json_equal


class CardScriptError(ValueError):
    pass


def assert_js_numbers(value: JsonValue) -> None:
    if type(value) is int and abs(value) > 2**53 - 1:
        raise CardScriptError("Scripts cannot receive integers outside JavaScript's exact range")
    if isinstance(value, (list, dict)):
        for part in value if isinstance(value, list) else value.values():
            assert_js_numbers(part)


def validated_script_values(values: dict[str, JsonValue], proposed: JsonValue) -> dict[str, JsonValue]:
    changes = []

    def gather(before: JsonValue, after: JsonValue, path: list[str]) -> None:
        if _kind(before) is not _kind(after):
            raise CardScriptError("Card script changed the type of a declared variable")
        if isinstance(before, dict):
            if before.keys() != after.keys():
                raise CardScriptError("Card scripts can only change declared variable paths")
            for key, value in before.items():
                gather(value, after[key], [*path, key])
        elif not json_equal(before, after):
            if len(changes) == 32:
                raise CardScriptError("Too many card script changes in one batch")
            changes.append(MvuChange(path=path, op="set", value=after))

    assert_js_numbers(proposed)
    gather(values, proposed, [])
    return apply_changes(values, changes) if changes else values
