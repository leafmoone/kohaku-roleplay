"""Recognize self-contained HTML replacements used by legacy display-only card rules."""

import json
import re
from collections.abc import Iterator

from pydantic import BaseModel, ConfigDict, JsonValue

from .mvu import public_values
from .card_web import WebPanel, _MAX_HTML

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


class LegacyOpeningState(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    marker: str
    values: dict[str, JsonValue]


def selected_opening_values(values: dict[str, JsonValue], selected: list[str]) -> dict[str, JsonValue]:
    projected = {}
    for row in public_values(values, selected):
        *prefix, key = json.loads(row['id'])
        parent = projected
        for part in prefix:
            parent = parent.setdefault(part, {})
        parent[key] = row['value']
    return projected
