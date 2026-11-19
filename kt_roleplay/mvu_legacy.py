"""Translate a data-only subset of MagVarUpdate commands, without executing JS."""

import json
import re
from ast import literal_eval
from dataclasses import dataclass

from pydantic import JsonValue

from .mvu import MvuChange, MvuObserver, apply_changes
from .mvu_patch import apply_json_patch, json_equal

_BLOCK = re.compile(r"<UpdateVariable>\s*(.*?)\s*</UpdateVariable>\s*\Z", re.S)
_ANALYSIS = re.compile(r"\s*<Analysis>.*?</Analysis>\s*", re.S)
_PATCH = re.compile(r"<JSONPatch>\s*(.*?)\s*</JSONPatch>\s*\Z", re.S)
_PATH_SEGMENT = re.compile(r"([^.[\]]+)((?:\[(?:0|[1-9][0-9]*)\])*)")
_COMMAND = re.compile(r"\s*_\.(set|add)\s*\(")
_SINGLE_STRING = re.compile(r"'(?:[^'\\\r\n]|\\['\\nrt])*'")
_TERMINATOR = re.compile(r"\s*\)\s*;?\s*(?://[^\r\n]*)?\Z")
_MAX_BYTES = 16 * 1024
_MAX_COMMANDS = 32
_JSON = json.JSONDecoder()
_UNCHECKED = object()


@dataclass(frozen=True)
class LiteralUpdate:
    change: MvuChange
    expected: object = _UNCHECKED


def split_opening(text: str) -> tuple[str, str | None]:
    start = text.find("<UpdateVariable>")
    if start < 0 or _BLOCK.fullmatch(text[start:]) is None:
        return text, None
    return text[:start].rstrip(), text[start:]


def _literal(line: str, pos: int) -> tuple[JsonValue, int]:
    while pos < len(line) and line[pos].isspace():
        pos += 1
    if match := _SINGLE_STRING.match(line, pos):
        return literal_eval(match[0]), match.end()
    try:
        return _JSON.raw_decode(line, pos)
    except (ValueError, RecursionError) as exc:
        raise ValueError("MVU commands require literal arguments") from exc


def _body(text: str) -> str:
    if len(text.encode("utf-8")) > _MAX_BYTES:
        raise ValueError("MVU update block is too large")
    block = _BLOCK.fullmatch(text.strip())
    if not block:
        raise ValueError("Expected exactly one <UpdateVariable> block")
    return _ANALYSIS.sub("", block[1], count=1) if _ANALYSIS.match(block[1]) else block[1]


def _legacy_path(path: str) -> list[str]:
    tokens = []
    for part in path.split("."):
        match = _PATH_SEGMENT.fullmatch(part)
        if not match:
            raise ValueError("MVU requires a dot-separated path with optional numeric indices")
        tokens.append(match[1])
        tokens.extend(re.findall(r"\[([0-9]+)\]", match[2]))
    return tokens


def read_update(body: str) -> list[LiteralUpdate]:
    result = []
    for line in body.splitlines():
        if not line.strip() or line.lstrip().startswith("//"):
            continue
        match = _COMMAND.match(line)
        if match is None or len(result) >= _MAX_COMMANDS:
            raise ValueError("Only literal _.set and _.add commands are supported")
        path, pos = _literal(line, match.end())
        if not isinstance(path, str):
            raise ValueError("MVU requires a literal path")
        args = []
        while comma := re.match(r"\s*,", line[pos:]):
            value, pos = _literal(line, pos + comma.end())
            args.append(value)
            if len(args) > 2:
                raise ValueError("Too many MVU command arguments")
        op = match[1]
        if not _TERMINATOR.fullmatch(line, pos) or len(args) not in ((1, 2) if op == "set" else (1,)):
            raise ValueError("Invalid MVU command arguments or trailing code")
        result.append(LiteralUpdate(MvuChange(path=_legacy_path(path), op=op, value=args[-1]),
                                    args[0] if len(args) == 2 else _UNCHECKED))
    if not result:
        raise ValueError("MVU update block is empty")
    return result


def apply_literal_update(values: dict[str, JsonValue], text: str, *, observe: MvuObserver | None = None) -> dict[str, JsonValue]:
    body = _body(text)
    if patch := _PATCH.fullmatch(body):
        return apply_json_patch(values, patch[1], _MAX_COMMANDS, observe=observe)
    updates = read_update(body)
    expected = {tuple(item.change.path): item.expected for item in updates if item.expected is not _UNCHECKED}
    def guard(path, current):
        if path in expected and not json_equal(current, expected[path]):
            raise ValueError('MVU update has a stale expected value')
    return apply_changes(values, [item.change for item in updates], observe=observe, guard=guard)
