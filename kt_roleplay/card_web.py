"""Read the self-contained page declared by an author in a CHARX archive."""

from zipfile import ZipFile, ZipInfo

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .charx import _local_path, _member
from .errors import CardError

_MAX_HTML = 256 * 1024


class WebPanelSource(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid', str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=100)
    entry: str = Field(min_length=1, max_length=240)


class WebPanel(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    title: str
    html: str


def read_web_panel(archive: ZipFile, members: dict[str, ZipInfo], declaration: object) -> WebPanel:
    try:
        source = WebPanelSource.model_validate(declaration)
    except ValidationError as exc:
        raise CardError('webPanel requires a title and a local HTML entry') from exc
    if not _local_path(source.entry) or not source.entry.lower().endswith(('.html', '.htm')):
        raise CardError('webPanel.entry must be a local HTML file in the CHARX archive')
    item = members.get(source.entry)
    if item is None or item.is_dir():
        raise CardError('webPanel.entry is missing from the CHARX archive')
    if not 0 < item.file_size <= _MAX_HTML:
        raise CardError('The card web panel must be a nonempty HTML file of at most 256 KiB')
    try:
        html = _member(archive, item).decode('utf-8-sig')
    except UnicodeDecodeError as exc:
        raise CardError('The card web panel must be UTF-8 HTML') from exc
    return WebPanel(title=source.title, html=html)
