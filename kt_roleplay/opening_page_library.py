"""Explicitly cache the static HTML entry declared by a legacy opening. Never execute it."""
from pathlib import Path
from typing import TypedDict

from .card_web import _MAX_HTML
from .errors import CardError
from .library import CardNotFound, _open, get_card
from .module_download import download_opening_html


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
