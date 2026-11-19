"""Recognize self-contained HTML replacements used by legacy display-only card rules."""

import json
import re
from collections.abc import Callable, Iterator

from kohakuterrarium.modules.output.base import BaseOutputModule
from kohakuterrarium.modules.output.event import OutputEvent
from pydantic import BaseModel, ConfigDict, JsonValue

from .card_web import WebPanel, _MAX_HTML
from .mvu import public_values

_MARKER = re.compile(r'<[A-Za-z][A-Za-z0-9_-]{0,79}\s*/>')
_FENCE = re.compile(r'```(?:html)?[ \t]*\r?\n(?P<html>.+?)\r?\n```', re.S | re.I)
_DOCUMENT = re.compile(r'(?:<!doctype\s+html\s*>\s*)?<html(?:\s|>)', re.I)


class LegacyWebRule(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    marker: str
    panel: WebPanel


def opening_web_rules(extensions: object, openings: list[str]) -> Iterator[LegacyWebRule]:
    """Find literal assistant-only, display-only replacements for card openings."""
    rules = extensions.get('regex_scripts') if isinstance(extensions, dict) else None
    if not isinstance(rules, list):
        return
    for rule in rules:
        if (not isinstance(rule, dict) or rule.get('disabled') or rule.get('markdownOnly') is not True
                or rule.get('promptOnly') or rule.get('placement') != [2] or rule.get('trimStrings')
                or rule.get('substituteRegex') not in (None, 0)
                or rule.get('minDepth') not in (None, 0)
                or (rule.get('maxDepth') is not None and (type(rule['maxDepth']) is not int or rule['maxDepth'] < 0))):
            continue
        marker = rule.get('findRegex')
        name = rule.get('scriptName')
        replacement = rule.get('replaceString')
        if (not isinstance(marker, str) or not _MARKER.fullmatch(marker) or not any(marker in opening for opening in openings)
                or not isinstance(name, str) or not 1 <= len(name.strip()) <= 100
                or not isinstance(replacement, str) or len(replacement) > _MAX_HTML):
            continue
        # With a literal marker there are no captures. JS replacements with any token
        # expansion would not produce the same document after extraction.
        if re.search(r"\$(?:[0-9&`'$]|<)|\{\{", replacement):
            continue
        match = _FENCE.fullmatch(replacement.strip())
        if match is None:
            continue
        html = match['html']
        if not _DOCUMENT.match(html.lstrip()) or not html.rstrip().lower().endswith('</html>'):
            continue
        try:
            name.encode('utf-8')
            if len(html.encode('utf-8')) > _MAX_HTML:
                continue
        except UnicodeEncodeError:
            continue
        yield LegacyWebRule(marker=marker, panel=WebPanel(title=name.strip(), html=html))


class LegacyReplyCapture(BaseOutputModule):
    """Receive the canonical assistant reply, not streamed, tool, or replay text."""

    def __init__(self, capture: Callable[[str], None]) -> None:
        super().__init__()
        self.capture: Callable[[str], None] | None = capture

    def detach(self) -> None:
        self.capture = None

    async def write(self, content: str) -> None:
        pass

    async def emit(self, event: OutputEvent) -> None:
        capture = self.capture
        if capture is None or event.type != 'assistant_message':
            return
        message = event.payload.get('message')
        if not isinstance(message, dict) or message.get('role') != 'assistant' or message.get('tool_calls'):
            return
        content = message.get('content')
        if isinstance(content, list):
            content = '\n'.join(part['text'] for part in content if isinstance(part, dict)
                                and part.get('type') == 'text' and isinstance(part.get('text'), str))
        if isinstance(content, str) and 0 < len(content) <= 32 * 1024:
            capture(content)


class LegacyReplyState(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    turn: int
    text: str
    values: dict[str, JsonValue]


class LegacyOpeningState(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    marker: str
    values: dict[str, JsonValue]


def selected_message_values(values: dict[str, JsonValue], selected: list[str]) -> dict[str, JsonValue]:
    projected = {}
    for row in public_values(values, selected):
        *prefix, key = json.loads(row['id'])
        parent = projected
        for part in prefix:
            parent = parent.setdefault(part, {})
        parent[key] = row['value']
    return projected


def legacy_web_message(index: int, text: str, values: dict[str, JsonValue], selected: list[str]) -> dict[str, JsonValue]:
    return {'message_id': index, 'role': 'assistant', 'message': text, 'is_hidden': False,
            'data': {'stat_data': selected_message_values(values, selected)}}
