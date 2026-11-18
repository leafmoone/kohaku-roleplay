"""Read Character Card V3 archives in memory without extracting or executing them."""

import binascii
from collections import Counter
from contextlib import contextmanager
from io import BytesIO
from pathlib import PurePosixPath
from typing import Iterator
from urllib.parse import unquote
from zipfile import BadZipFile, LargeZipFile, ZipFile, ZipInfo

from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict

from .errors import CardError


MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
_MAX_MEMBERS = 512
_MAX_UNPACKED_BYTES = 96 * 1024 * 1024
_MAX_MEMBER_BYTES = 8 * 1024 * 1024
_MAX_IMAGE_PIXELS = 16_000_000
_IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp"})
_IMAGE_FORMATS = ("PNG", "JPEG", "WEBP")
_ARCHIVE_ERRORS = (BadZipFile, LargeZipFile, NotImplementedError, RuntimeError, OSError, EOFError, binascii.Error)


class CardMedia(BaseModel):
    model_config = ConfigDict(strict=True)
    key: str
    name: str
    kind: str
    member: str


def is_charx(raw: bytes) -> bool:
    return raw.startswith(b"PK\x03\x04")


def _local_path(name: str) -> bool:
    return bool(name) and "\\" not in name and ":" not in name and not any(ord(c) < 32 for c in name) and all(
        part not in ("", ".", "..") for part in name.split("/")
    )


@contextmanager
def open_charx(raw: bytes) -> Iterator[tuple[ZipFile, dict[str, ZipInfo]]]:
    if not 0 < len(raw) <= MAX_ARCHIVE_BYTES:
        raise CardError("Choose a non-empty CHARX archive of at most 32 MiB")
    try:
        with ZipFile(BytesIO(raw)) as archive:
            members = archive.infolist()
            if len(members) > _MAX_MEMBERS or sum(item.file_size for item in members) > _MAX_UNPACKED_BYTES:
                raise CardError("CHARX archive exceeds the unpacked size or entry limit")
            index = {}
            for item in members:
                name = item.filename.removesuffix("/") if item.is_dir() else item.filename
                mode = (item.external_attr >> 16) & 0o170000
                if (not _local_path(name) or item.filename != item.orig_filename or name in index
                        or item.flag_bits & 1 or mode not in (0, 0o100000, 0o040000)):
                    raise CardError("CHARX archive contains an unsafe, duplicate, or encrypted entry")
                index[name] = item
            manifest = index.get("card.json")
            if manifest is None or manifest.is_dir() or not 0 < manifest.file_size <= _MAX_MEMBER_BYTES:
                raise CardError("CHARX archive needs a readable card.json at its root")
            yield archive, index
    except _ARCHIVE_ERRORS as exc:
        raise CardError("Cannot read the CHARX archive") from exc


def _member(archive: ZipFile, item: ZipInfo) -> bytes:
    if item.is_dir() or not 0 < item.file_size <= _MAX_MEMBER_BYTES:
        raise CardError("CHARX file exceeds the per-entry size limit or is empty")
    with archive.open(item) as stream:
        data = stream.read(_MAX_MEMBER_BYTES + 1)
        if len(data) != item.file_size:
            raise CardError("CHARX entry length does not match its directory")
        return data


def read_charx_card(archive: ZipFile, index: dict[str, ZipInfo]) -> bytes:
    return _member(archive, index["card.json"])


def _image(data: bytes, bounds: tuple[int, int]) -> bytes:
    try:
        with Image.open(BytesIO(data), formats=_IMAGE_FORMATS) as probe:
            if probe.width * probe.height > _MAX_IMAGE_PIXELS:
                raise CardError("CHARX image exceeds the pixel limit")
            probe.verify()
        with Image.open(BytesIO(data), formats=_IMAGE_FORMATS) as image:
            display = ImageOps.exif_transpose(image)
            display.thumbnail(bounds)
            display = display.convert("RGBA")
            display.info.clear()
            out = BytesIO()
            display.save(out, format="PNG")
            return out.getvalue()
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError, ValueError) as exc:
        raise CardError("Invalid CHARX image") from exc


def inspect_charx_media(archive: ZipFile, index: dict[str, ZipInfo], declared: object) -> tuple[list[CardMedia], bytes | None, dict[str, int]]:
    if not isinstance(declared, list):
        return [], None, {"invalid_asset": 1} if declared is not None else {}
    media = []
    warnings = Counter()
    checked_paths: dict[str, bool] = {}
    cover = None
    for i, row in enumerate(declared):
        if not isinstance(row, dict) or not all(isinstance(row.get(k), str) and row[k].strip() for k in ("name", "type", "uri")):
            warnings["invalid_asset"] += 1
            continue
        uri = row["uri"]
        if uri == "ccdefault:":
            continue
        if not uri.startswith(("embeded://", "embedded://")):
            warnings["external_asset"] += 1
            continue
        path = uri.split("://", 1)[1]
        if path not in index:
            path = unquote(path)
        if not _local_path(path) or path not in index:
            warnings["missing_asset"] += 1
            continue
        if PurePosixPath(path).suffix.lower() not in _IMAGE_SUFFIXES:
            warnings["unsupported_asset"] += 1
            continue
        kind = row["type"]
        needs_cover = kind == "icon" and cover is None
        if checked_paths.get(path) is not False and (path not in checked_paths or needs_cover):
            try:
                checked = _image(_member(archive, index[path]), (480, 640))
                checked_paths[path] = True
                if needs_cover:
                    cover = checked
            except (CardError, *_ARCHIVE_ERRORS):
                checked_paths[path] = False
        if not checked_paths[path]:
            warnings["invalid_asset"] += 1
            continue
        media.append(CardMedia(key=f"media-{i}", name=row["name"], kind=kind, member=path))
    return media, cover, dict(warnings)


def read_charx_image(raw: bytes, member: str) -> bytes:
    with open_charx(raw) as (archive, index):
        item = index.get(member)
        if item is None:
            raise CardError("CHARX image is missing")
        return _image(_member(archive, item), (1600, 1200))
