"""Cache a confirmed legacy opening entry and prepare it for an isolated session."""
from html.parser import HTMLParser
from pathlib import Path
import re
from typing import Literal, TypedDict

from .card_web import WebPanel, _MAX_HTML
from .errors import CardError
from .legacy_web import LegacyRemoteOpening
from .library import CardNotFound, _open, get_card
from .module_download import download_opening_html
from .script_dependencies import scan_modules

OpeningPageIssue = Literal['entry_unconfirmed', 'entry_needs_resources', 'entry_unsupported']
_RESOURCES = {'src', 'srcset', 'href', 'xlink:href', 'poster', 'action', 'formaction', 'data'}
_CSS_REFERENCE = re.compile(r'@import\b|\burl\s*\(', re.I)
_JS_TYPES = {'', 'module', 'text/javascript', 'application/javascript'}


class _EntryResources(HTMLParser):
    """Availability check for declared resources, not a replacement for the browser sandbox."""

    def __init__(self) -> None:
        super().__init__()
        self.needs_resources = False
        self.unsupported = False
        self.inline = ''

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        def attr(name: str) -> str:
            # HTML uses the first occurrence of a repeated attribute.
            return (next((value for key, value in attrs if key == name), None) or '').strip().lower()

        if tag in {'base', 'frame', 'iframe', 'embed', 'object'} or (tag == 'meta' and attr('http-equiv') == 'refresh'):
            self.unsupported = True
        for name, value in attrs:
            if name in _RESOURCES and value and value.strip():
                if name not in {'href', 'xlink:href'} or not value.lstrip().startswith('#'):
                    self.needs_resources = True
            if name == 'style' and value and _CSS_REFERENCE.search(value):
                self.needs_resources = True
        if tag == 'script' and attr('type') in _JS_TYPES:
            self.inline = 'script'
        elif tag == 'style':
            self.inline = 'style'
        else:
            self.inline = ''

    def handle_endtag(self, tag: str) -> None:
        self.inline = ''

    def unknown_decl(self, data: str) -> None:
        self.unsupported = True

    def handle_data(self, data: str) -> None:
        if self.unsupported or self.needs_resources:
            return
        if self.inline == 'style' and _CSS_REFERENCE.search(data):
            self.needs_resources = True
        elif self.inline == 'script' and data.strip():
            references, invalid, truncated = scan_modules(data)
            self.needs_resources = bool(references)
            self.unsupported = invalid or truncated


def cached_opening_panel(directory: Path, card_id: str, declared: LegacyRemoteOpening) -> tuple[WebPanel | None, OpeningPageIssue | None]:
    with _open(directory) as db:
        row = db.execute('SELECT source FROM card_opening_pages WHERE card_id=? AND url=?',
                         (card_id, declared.url)).fetchone()
    if row is None:
        return None, 'entry_unconfirmed'
    checker = _EntryResources()
    try:
        html = row[0].decode('utf-8-sig')
        checker.feed(html)
        checker.close()
    except (AssertionError, ValueError):
        # The parser can reject malformed declarations or oversized numeric character references.
        return None, 'entry_unsupported'
    if checker.unsupported or checker.inline:
        return None, 'entry_unsupported'
    if checker.needs_resources:
        return None, 'entry_needs_resources'
    return WebPanel(title=declared.title, html=html), None


class OpeningPageSnapshot(TypedDict):
    url: str
    size: int


def opening_page_snapshot(directory: Path, card_id: str) -> OpeningPageSnapshot | None:
    with _open(directory) as db:
        row = db.execute('SELECT url,length(source) FROM card_opening_pages WHERE card_id=?', (card_id,)).fetchone()
    return OpeningPageSnapshot(url=row[0], size=row[1]) if row else None


def snapshot_opening_page(directory: Path, card_id: str, url: str) -> OpeningPageSnapshot:
    declared = get_card(directory, card_id).legacy_remote_opening
    if declared is None or declared.url != url:
        raise CardError('Confirm the exact external opening page declared by this card')
    if saved := opening_page_snapshot(directory, card_id):
        return saved
    source = download_opening_html(url, _MAX_HTML)
    if not source.decode('utf-8-sig').strip():
        raise CardError('The external opening page contains no HTML')
    with _open(directory) as db:
        db.execute('BEGIN IMMEDIATE')
        if db.execute('SELECT 1 FROM cards WHERE id=?', (card_id,)).fetchone() is None:
            raise CardNotFound(card_id)
        db.execute('INSERT INTO card_opening_pages(card_id,url,source) VALUES (?,?,?) ON CONFLICT DO NOTHING',
                   (card_id, url, source))
        saved_url, size = db.execute('SELECT url,length(source) FROM card_opening_pages WHERE card_id=?', (card_id,)).fetchone()
    return OpeningPageSnapshot(url=saved_url, size=size)
