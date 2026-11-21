"""Prepare the authored default portrait for the fixed, read-only status panel."""
from base64 import b64encode
from pathlib import Path
from sqlite3 import Error as SQLiteError
from typing import TYPE_CHECKING

from .charx import _image
from .errors import CardError
from .library import CardNotFound, _open, _open_readonly
from .module_download import download_status_image
from .module_library import module_snapshot_locks
from .mvu import inspect_initializers
from .pinned_mvu_status import has_status_portrait

if TYPE_CHECKING:
    from .cards import ParsedCard


def declared_status_portrait(card: 'ParsedCard') -> str | None:
    if not card.legacy_mvu_status or not has_status_portrait(card.legacy_mvu_status):
        return None
    initial = inspect_initializers(card.book)
    main = initial.values.get('Mainchar') if initial else None
    image = main.get('Image') if isinstance(main, dict) else None
    if isinstance(image, list) and len(image) == 2:
        image = image[0]
    return image if isinstance(image, str) and image.startswith('https://') else None


def prepare_status_portrait(directory: Path, card_id: str, url: str) -> bytes:
    with module_snapshot_locks(directory, [url]):
        with _open(directory) as db:
            row = db.execute('SELECT card_id,png FROM card_status_portraits WHERE url=? ORDER BY card_id!=? LIMIT 1',
                             (url, card_id)).fetchone()
        if row is not None and row[0] == card_id:
            return row[1]
        if row is None:
            source = download_status_image(url)
            try:
                png = _image(source, (720, 720))
            except CardError as exc:
                raise CardError('Could not decode the author status portrait as a raster image') from exc
        else:
            png = row[1]
        with _open(directory) as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT 1 FROM cards WHERE id=?', (card_id,)).fetchone() is None:
                raise CardNotFound(card_id)
            db.execute('INSERT INTO card_status_portraits VALUES (?,?,?) ON CONFLICT(card_id) DO UPDATE SET url=excluded.url,png=excluded.png',
                       (card_id, url, png))
        return png


def read_status_portrait(directory: Path, card_id: str) -> str | None:
    try:
        with _open_readonly(directory) as db:
            if db is None or db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='card_status_portraits'").fetchone() is None:
                return None
            row = db.execute('SELECT png FROM card_status_portraits WHERE card_id=?', (card_id,)).fetchone()
    except SQLiteError:
        # The image cache is optional; the author's status panel still has a placeholder.
        return None
    return 'data:image/png;base64,' + b64encode(row[0]).decode('ascii') if row is not None else None
