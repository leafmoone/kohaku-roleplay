"""Recognize self-contained HTML replacements used by legacy display-only card rules."""

import json
import re
from collections.abc import Callable
from typing import TypedDict
from urllib.parse import urlsplit

from kohakuterrarium.modules.output.base import BaseOutputModule
from kohakuterrarium.modules.output.event import OutputEvent
from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from .card_scripts import CardScript
from .card_web import WebPanel, _MAX_HTML
from .errors import CardError
from .module_download import opening_html_target
from .mvu import public_values
from .script_dependencies import script_dependencies

_MARKER = re.compile(r'<[A-Za-z][A-Za-z0-9_-]{0,79}\s*/>')
_FENCE = re.compile(r'```(?:html)?[ \t]*\r?\n(?P<html>.+?)\r?\n```', re.S | re.I)
_DOCUMENT = re.compile(r'(?:<!doctype\s+html\s*>\s*)?<html(?:\s|>)', re.I)
_REMOTE_BODY_LOAD = re.compile(
    r"""<body>\s*<script>\s*\$\(\s*(?P<target>['"])body(?P=target)\s*\)\.load\(\s*"""
    r"""(?P<source>['"])(?P<url>https://[^\s'"<>\\]+)(?P=source)\s*\)\s*(?:;\s*)?</script>\s*</body>"""
)
_REMOTE_PAGE_WARNING = 'A legacy opening page loads external HTML. KT retains the card but does not load this page.'
_MVU_STATUS_MARKER = '<StatusPlaceHolderImpl/>'
_MVU_BETA_CDN_PATH = '/gh/MagicalAstrogy/MagVarUpdate@beta/artifact/bundle.js'
_MVU_BETA_RAW_PATH = '/MagicalAstrogy/MagVarUpdate/beta/artifact/bundle.js'
_JSDELIVR_HOSTS = frozenset({'cdn.jsdelivr.net', 'testingcf.jsdelivr.net', 'gcore.jsdelivr.net'})


class LegacyWebRule(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    marker: str
    panel: WebPanel


class LegacyRemoteOpening(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    marker: str
    title: str
    url: str


def _remote_body_loader_url(html: str) -> str | None:
    match = _REMOTE_BODY_LOAD.fullmatch(html.strip())
    if match is None:
        return None
    url = match['url']
    try:
        return url if urlsplit(url).hostname else None
    except ValueError:
        return None


def opening_web_rules(extensions: object, openings: list[str], warnings: list[str]) -> tuple[list[LegacyWebRule], LegacyRemoteOpening | None]:
    """Find self-contained opening pages and one declared external source; never load it here."""
    rules = extensions.get('regex_scripts') if isinstance(extensions, dict) else None
    matches: list[LegacyWebRule] = []
    remote = None
    if not isinstance(rules, list):
        return matches, remote
    for rule in rules:
        if len(matches) >= 4 and remote is not None:
            break
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
            if remote is None and (url := _remote_body_loader_url(html)) is not None:
                if _REMOTE_PAGE_WARNING not in warnings:
                    warnings.append(_REMOTE_PAGE_WARNING)
                try:
                    opening_html_target(url)
                    name.encode('utf-8')
                except (CardError, UnicodeEncodeError):
                    continue
                remote = LegacyRemoteOpening(marker=marker, title=name.strip(), url=url)
            continue
        if len(matches) >= 4:
            continue
        try:
            name.encode('utf-8')
            if len(html.encode('utf-8')) > _MAX_HTML:
                continue
        except UnicodeEncodeError:
            continue
        matches.append(LegacyWebRule(marker=marker, panel=WebPanel(title=name.strip(), html=html)))
    return matches, remote


def has_mvu_status_adapter(marker: str, scripts: list[CardScript]) -> bool:
    if marker != _MVU_STATUS_MARKER:
        return False
    for script in script_dependencies([s for s in scripts if s.enabled and s.content]):
        if script['syntaxError'] or script['truncated']:
            continue
        for reference in script['references']:
            if reference['kind'] != 'https' or not reference['specifier']:
                continue
            url = urlsplit(reference['specifier'])
            if url.query or url.fragment:
                continue
            if url.netloc in _JSDELIVR_HOSTS and url.path == _MVU_BETA_CDN_PATH:
                return True
            if url.netloc == 'raw.githubusercontent.com' and url.path == _MVU_BETA_RAW_PATH:
                return True
    return False


def mvu_reply_has_body(text: str) -> bool:
    # The upstream short-reply guard counts JavaScript UTF-16 code units.
    return len(text) >= 5 or len(text.encode('utf-16-le', errors='surrogatepass')) >= 10


def _assistant_reply_text(message: object) -> str | None:
    if not isinstance(message, dict) or message.get('role') != 'assistant' or message.get('tool_calls'):
        return None
    content = message.get('content')
    if isinstance(content, list):
        content = '\n'.join(part['text'] for part in content if isinstance(part, dict)
                            and part.get('type') == 'text' and isinstance(part.get('text'), str))
    return content if isinstance(content, str) and 0 < len(content) <= 32 * 1024 else None


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
        if (content := _assistant_reply_text(event.payload.get('message'))) is not None:
            capture(content)


class LegacyReplyState(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    turn: int
    text: str
    values: dict[str, JsonValue]
    branch: int | None = None


class LegacyMessageAnchor(TypedDict):
    turn: int
    branchId: int
    eventId: int
    roundStartEventId: int


LEGACY_MESSAGE_EVENT_LIMIT = 128
LEGACY_MESSAGE_SLOT = 'mes-text-v1'


class LegacyMessageLocator(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    turn: int = Field(ge=1, le=2**53 - 1)
    branchId: int = Field(ge=1, le=2**53 - 1)
    eventId: int = Field(ge=1, le=2**53 - 1)
    roundStartEventId: int = Field(ge=1, le=2**53 - 1)

    @model_validator(mode='after')
    def _physical_order(self) -> 'LegacyMessageLocator':
        if self.roundStartEventId >= self.eventId:
            raise ValueError('The message must follow its physical round start')
        return self


def _legacy_slot_block(text: str) -> str | None:
    # The public adapter targets an explicit author options block, never generic prose.
    prefix, start, tail = text.partition('<roleplay_options>')
    content, end, suffix = tail.partition('</roleplay_options>')
    if (not start or not end or '<roleplay_options>' in content or '<roleplay_options>' in suffix
            or '</roleplay_options>' in prefix or '</roleplay_options>' in suffix):
        return None
    return content.strip() or None


def has_legacy_message_slot(text: str) -> bool:
    return _legacy_slot_block(text) is not None


def legacy_slot_options(text: str) -> list[dict[str, str]]:
    block = _legacy_slot_block(text)
    if block is None:
        return []
    lines = block.splitlines()
    if lines[0].startswith('```'):
        if lines[-1] != '```' or len(lines) < 3:
            return []
        lines = lines[1:-1]
    options: list[dict[str, str]] = []
    seen: set[str] = set()
    for line in lines:
        if not line.strip():
            continue
        parts = re.split(r'[:：]', line, maxsplit=1)
        if len(parts) != 2 or len(options) >= 8:
            return []
        label, draft = (part.strip() for part in parts)
        if draft.startswith('${') and draft.endswith('}'):
            draft = draft[2:-1].strip()
        elif draft.startswith('「') and draft.endswith('」'):
            draft = draft[1:-1].strip()
        if not 0 < len(label) <= 80 or label in seen or not 0 < len(draft) <= 1000:
            return []
        seen.add(label)
        options.append({'label': label, 'text': draft})
    return options


def completed_legacy_message_anchor(reply: LegacyReplyState, events: list[dict]) -> LegacyMessageAnchor | None:
    """Match success, canonical message and round start in one namespace-local window."""
    branch = reply.branch
    if branch is None or branch < 1 or reply.turn < 1:
        return None
    ended = False
    anchor = None
    for event in events[:LEGACY_MESSAGE_EVENT_LIMIT]:
        if event.get('turn_index') != reply.turn or event.get('branch_id') != branch:
            continue
        kind = event.get('type')
        if kind == 'processing_end':
            if ended or event.get('completed') is not True:
                return None
            ended = True
        elif kind == 'assistant_message':
            key, start = event.get('event_id'), event.get('round_start_event_id')
            if (not ended or anchor or _assistant_reply_text(event.get('message')) != reply.text
                    or type(key) is not int or type(start) is not int or not 0 < start < key):
                return None
            anchor = LegacyMessageAnchor(turn=reply.turn, branchId=branch, eventId=key, roundStartEventId=start)
        elif kind == 'assistant_round_start':
            return anchor if anchor and event.get('event_id') == anchor['roundStartEventId'] else None
        elif kind in ('processing_start', 'user_message', 'processing_error', 'interrupt'):
            return None
    return None


class OpeningCounterGrant(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    path: list[str] = Field(min_length=1, max_length=16)
    minimum: int = Field(ge=-(2**53 - 1), le=2**53 - 1)
    maximum: int = Field(ge=-(2**53 - 1), le=2**53 - 1)

    @model_validator(mode='after')
    def _counter_range(self) -> 'OpeningCounterGrant':
        if self.minimum >= self.maximum or any(not part or len(part) > 160 for part in self.path):
            raise ValueError('Choose an existing counter path and increasing integer bounds')
        return self

    def public_id(self) -> str:
        return json.dumps(self.path, ensure_ascii=False)

    def current(self, values: dict[str, JsonValue]) -> int | None:
        rows = public_values(values, [self.public_id()])
        value = rows[0]['value'] if rows else None
        return value if type(value) is int and self.minimum <= value <= self.maximum else None


class OpeningCounterWrite(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    messageId: int = Field(ge=0, le=0)
    revision: int = Field(ge=0, le=2**53 - 1)
    expected: int = Field(ge=-(2**53 - 1), le=2**53 - 1)
    value: int = Field(ge=-(2**53 - 1), le=2**53 - 1)


class LegacyOpeningState(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    marker: str
    values: dict[str, JsonValue]
    mvu_status_adapter: bool = False
    mvu_read_enabled: bool = False
    counter: OpeningCounterGrant | None = None
    counter_revision: int = 0
    message_slot_enabled: bool = False


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
