"""Cache a confirmed legacy opening entry and prepare it for an isolated session."""
from html.parser import HTMLParser
from pathlib import Path
import re
from sqlite3 import Connection
from typing import Literal, TypedDict

from .card_web import WebPanel, _MAX_HTML
from .errors import CardError
from .legacy_web import LegacyRemoteOpening
from .library import CardNotFound, _open, get_card
from .module_download import download_module, download_opening_html
from .script_dependencies import ModuleReference, scan_modules

OpeningPageIssue = Literal['entry_unconfirmed', 'entry_needs_resources', 'entry_unsupported']
_RESOURCES = {'src', 'srcset', 'href', 'xlink:href', 'poster', 'action', 'formaction', 'data'}
_CSS_REFERENCE = re.compile(r'@import\b|\burl\s*\(', re.I)
# The HTML script types include legacy JavaScript MIME type essences.
_JS_TYPES = {
    '', 'module', 'application/ecmascript', 'application/javascript',
    'application/x-ecmascript', 'application/x-javascript', 'text/ecmascript',
    'text/javascript', 'text/javascript1.0', 'text/javascript1.1',
    'text/javascript1.2', 'text/javascript1.3', 'text/javascript1.4',
    'text/javascript1.5', 'text/jscript', 'text/livescript',
    'text/x-ecmascript', 'text/x-javascript',
}
_MAX_PAGE_REFERENCES = 32
_MAX_OPENING_MODULES = 16
_MAX_OPENING_MODULE_BYTES = 4 * 1024 * 1024


class _EntryResources(HTMLParser):
    """Availability check for declared resources, not a replacement for the browser sandbox."""

    def __init__(self, *, preview: bool = False) -> None:
        super().__init__()
        self.preview = preview
        self.other_resources = False
        self.needs_resources = False
        self.unsupported = False
        self.truncated = False
        self.references: list[ModuleReference] = []
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
                    self.other_resources = self.needs_resources = True
            if name == 'style' and value and _CSS_REFERENCE.search(value):
                self.other_resources = self.needs_resources = True
        if tag == 'script' and attr('type') in _JS_TYPES and not any(name == 'src' for name, _ in attrs):
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
        if not self.preview and (self.unsupported or self.needs_resources):
            return
        if self.inline == 'style' and _CSS_REFERENCE.search(data):
            self.other_resources = self.needs_resources = True
        elif self.inline == 'script' and data.strip():
            references, invalid, truncated = scan_modules(data)
            self.needs_resources |= bool(references)
            self.unsupported |= invalid
            # Cap the returned references without suppressing syntax checks of later blocks.
            if self.preview and not self.truncated:
                for ref in references:
                    if ref in self.references:
                        continue
                    if len(self.references) >= _MAX_PAGE_REFERENCES:
                        truncated = True
                        break
                    self.references.append(ref)
            self.truncated |= truncated


class _OpeningModuleDeclarations(HTMLParser):
    """A narrow authorization grammar, separate from resource diagnostics."""

    CDATA_CONTENT_ELEMENTS = (*HTMLParser.CDATA_CONTENT_ELEMENTS, 'title', 'textarea', 'xmp',
                              'noscript', 'noembed', 'noframes', 'iframe')
    _void = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
             'param', 'source', 'track', 'wbr'}
    _script_parents = {(), ('html',), ('head',), ('body',), ('html', 'head'), ('html', 'body')}

    def __init__(self) -> None:
        super().__init__()
        self.valid = True
        self.tags: list[str] = []
        self.sections: set[str] = set()
        self.script: list[str] | None = None
        self.urls: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if not self.valid:
            return
        if tag in {'base', 'frame', 'frameset', 'plaintext'}:
            self.valid = False
            return
        parents = tuple(self.tags)
        if tag in {'html', 'head', 'body'}:
            if (tag in self.sections or parents not in ((), ('html',)) or (tag == 'html' and self.sections)
                    or (tag == 'head' and 'body' in self.sections)):
                self.valid = False
                return
            self.sections.add(tag)
        if tag == 'script':
            types = [(value or '').lower() for key, value in attrs if key == 'type']
            if any(kind.strip() == 'importmap' for kind in types):
                self.valid = False
                return
            if parents in self._script_parents and types == ['module'] and not any(
                key in {'src', 'nomodule'} for key, _ in attrs
            ):
                self.script = []
        if tag not in self._void:
            self.tags.append(tag)

    def handle_endtag(self, tag: str) -> None:
        if not self.valid:
            return
        if not self.tags or self.tags[-1] != tag:
            self.valid = False
            return
        self.tags.pop()
        if tag == 'script' and self.script is not None:
            references, invalid, truncated = scan_modules(''.join(self.script), top_level_only=True)
            self.script = None
            self.urls.update(ref['specifier'] for ref in references
                             if ref['kind'] == 'https' and ref['specifier'] is not None)
            self.valid = not (invalid or truncated or len(self.urls) > _MAX_PAGE_REFERENCES)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag not in self._void:
            self.valid = False
        else:
            self.handle_starttag(tag, attrs)

    def handle_data(self, data: str) -> None:
        # HTMLParser lacks the browser's escaped script-data state. Refuse its
        # opening marker in any script, not in ordinary HTML comments.
        if self.tags and self.tags[-1] == 'script' and '<!--' in data:
            self.valid = False
            return
        if self.valid and self.script is not None:
            self.script.append(data)

    def handle_decl(self, decl: str) -> None:
        if decl.lower() != 'doctype html' or self.tags or self.sections:
            self.valid = False

    def handle_pi(self, data: str) -> None:
        self.valid = False

    def unknown_decl(self, data: str) -> None:
        self.valid = False


def _cached_page_bytes(directory: Path, card_id: str, url: str) -> bytes | None:
    with _open(directory) as db:
        row = db.execute('SELECT source FROM card_opening_pages WHERE card_id=? AND url=?', (card_id, url)).fetchone()
    return row[0] if row else None


def cached_opening_panel(directory: Path, card_id: str, declared: LegacyRemoteOpening) -> tuple[WebPanel | None, OpeningPageIssue | None]:
    source = _cached_page_bytes(directory, card_id, declared.url)
    if source is None:
        return None, 'entry_unconfirmed'
    checker = _EntryResources()
    try:
        html = source.decode('utf-8-sig')
        checker.feed(html)
        checker.close()
    except (AssertionError, ValueError):
        # The parser can reject malformed declarations or oversized numeric character references.
        return None, 'entry_unsupported'
    if checker.unsupported or checker.truncated or checker.inline:
        return None, 'entry_unsupported'
    if checker.needs_resources:
        return None, 'entry_needs_resources'
    return WebPanel(title=declared.title, html=html), None


class OpeningPageDependencies(TypedDict):
    url: str
    references: list[ModuleReference]
    otherResources: bool
    unsupported: bool
    truncated: bool


def _saved_opening_entry(directory: Path, card_id: str) -> tuple[str, bytes]:
    declared = get_card(directory, card_id).legacy_remote_opening
    if declared is None:
        raise CardError('This card has no declared external opening page')
    source = _cached_page_bytes(directory, card_id, declared.url)
    if source is None:
        raise CardError('Confirm the opening page before inspecting its dependencies')
    return declared.url, source


def opening_page_dependencies(directory: Path, card_id: str) -> OpeningPageDependencies:
    """Describe inline JS imports in an explicitly saved entry; do not fetch or evaluate them."""
    url, source = _saved_opening_entry(directory, card_id)
    checker = _EntryResources(preview=True)
    try:
        checker.feed(source.decode('utf-8-sig'))
        checker.close()
    except (AssertionError, ValueError):
        checker.unsupported = True
    return OpeningPageDependencies(url=url, references=checker.references,
                                   otherResources=checker.other_resources,
                                   unsupported=bool(checker.unsupported or checker.inline),
                                   truncated=checker.truncated)


class OpeningPageSnapshot(TypedDict):
    url: str
    size: int


def _saved_opening_modules(db: Connection, card_id: str) -> dict[str, int]:
    return dict(db.execute('SELECT url,length(source) FROM card_opening_modules WHERE card_id=?', (card_id,)))


def _check_opening_module_size(saved: dict[str, int], new_bytes: int) -> None:
    if len(saved) >= _MAX_OPENING_MODULES or sum(saved.values()) + new_bytes > _MAX_OPENING_MODULE_BYTES:
        raise CardError('A saved opening page may keep at most sixteen modules or 4 MiB')


def snapshot_opening_module(directory: Path, card_id: str, url: str) -> OpeningPageSnapshot:
    """Save one explicitly confirmed static import of the cached entry, without following it."""
    entry_url, entry = _saved_opening_entry(directory, card_id)
    declarations = _OpeningModuleDeclarations()
    try:
        declarations.feed(entry.decode('utf-8-sig'))
        declarations.close()
    except (AssertionError, ValueError):
        declarations.valid = False
    if not declarations.valid or declarations.tags or url not in declarations.urls:
        raise CardError('Confirm a literal HTTPS import from an inline module in the saved opening page')
    with _open(directory) as db:
        saved = _saved_opening_modules(db, card_id)
    if url in saved:
        return OpeningPageSnapshot(url=url, size=saved[url])
    _check_opening_module_size(saved, 1)  # The downloader rejects empty modules.
    source = download_module(url)
    with _open(directory) as db:
        db.execute('BEGIN IMMEDIATE')
        if db.execute('SELECT 1 FROM card_opening_pages WHERE card_id=? AND url=?', (card_id, entry_url)).fetchone() is None:
            raise CardError('The saved opening page changed before the module was stored')
        saved = _saved_opening_modules(db, card_id)
        if url in saved:
            return OpeningPageSnapshot(url=url, size=saved[url])
        _check_opening_module_size(saved, len(source))
        db.execute('INSERT INTO card_opening_modules(card_id,url,source) VALUES (?,?,?)', (card_id, url, source))
    return OpeningPageSnapshot(url=url, size=len(source))


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
