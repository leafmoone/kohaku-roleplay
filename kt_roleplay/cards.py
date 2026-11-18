"""Decode character cards without executing card-supplied formatting or instructions."""

import base64
import binascii
import json
from functools import cached_property
from io import BytesIO
from typing import Literal

from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .card_state import StateField, decode_fields
from .charx import CardMedia, inspect_charx_media, is_charx, open_charx, read_charx_card
from .errors import CardError
from .lore import LoreBook
from .portraits import PortraitAsset, PortraitRule, read_portraits
from .scene_media import read_scene_media
from .worldbook import read_worldbook

MAX_CARD_BYTES = 12 * 1024 * 1024
PNG_HEADER = b"\x89PNG\r\n\x1a\n"
CardFormat = Literal["png", "json", "charx"]


def card_format(raw: bytes) -> CardFormat:
    if raw.startswith(PNG_HEADER):
        return "png"
    return "charx" if is_charx(raw) else "json"


def require_editable(fmt: CardFormat | None) -> None:
    if fmt == "charx":
        raise CardError("CHARX archives are read-only; export the original instead")


class CardFields(BaseModel):
    model_config = ConfigDict(strict=True)
    name: str
    description: str
    personality: str
    scenario: str
    first_mes: str
    mes_example: str
    alternate_greetings: list[str] = Field(default_factory=list)
    creator_notes: str = ""
    creator: str = ""
    tags: list[str] = Field(default_factory=list)
    system_prompt: str = ""
    post_history_instructions: str = ""

    @field_validator("name")
    @classmethod
    def nonempty_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Character name must not be blank")
        return value


class ParsedCard(BaseModel):
    version: Literal[1, 2, 3]
    fields: CardFields
    book: dict[str, object] | None
    warnings: list[str]
    state_fields: list[StateField] = Field(default_factory=list)
    portraits: list[PortraitAsset] = Field(default_factory=list)
    portrait: bytes | None = None
    source_format: CardFormat | None = None
    media: list[CardMedia] = Field(default_factory=list)
    media_issues: dict[str, int] = Field(default_factory=dict)
    scene_media_rules: list[PortraitRule] = Field(default_factory=list)

    @cached_property
    def lore(self) -> LoreBook | None:
        return read_worldbook(self.book) if self.book is not None else None


def _png_payload(raw: bytes) -> tuple[bytes, bytes]:
    try:
        with Image.open(BytesIO(raw), formats=("PNG",)) as probe:
            if probe.width * probe.height > 16_000_000:
                raise CardError("Card portrait exceeds 16 megapixels")
            probe.verify()
            if not raw.endswith(b"\x00\x00\x00\x00IEND\xaeB`\x82"):
                raise CardError("PNG does not end with a complete IEND chunk")
        with Image.open(BytesIO(raw), formats=("PNG",)) as image:
            encoded = image.text.get("ccv3") or image.text.get("chara")
            if not encoded:
                raise CardError("PNG has no character card metadata (ccv3 or chara)")
            payload = base64.b64decode(encoded, validate=True)
            image.thumbnail((480, 640))
            portrait = image.convert("RGBA")
            portrait.info.clear()
            output = BytesIO()
            portrait.save(output, format="PNG")
            return payload, output.getvalue()
    except CardError:
        raise
    except (OSError, SyntaxError, ValueError, UnidentifiedImageError, Image.DecompressionBombError, binascii.Error) as exc:
        raise CardError(f"Invalid character card PNG: {exc}") from exc


def card_document(payload: bytes) -> tuple[Literal[1, 2, 3], dict, dict]:
    """Return the envelope and the editable data object, retaining unknown keys."""
    try:
        envelope = json.loads(payload.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise CardError("Card data must be UTF-8 JSON") from exc
    if not isinstance(envelope, dict):
        raise CardError("Card root must be an object")
    if "spec" not in envelope and "data" not in envelope:
        version, data = 1, envelope
    elif envelope.get("spec") in ("chara_card_v2", "chara_card_v3"):
        version = 2 if envelope["spec"] == "chara_card_v2" else 3
        data = envelope.get("data")
    else:
        raise CardError(f"Unsupported character card specification: {envelope.get('spec')!r}")
    if not isinstance(data, dict):
        raise CardError("Card data must be an object")
    return version, envelope, data


def parse_card(raw: bytes) -> ParsedCard:
    fmt = card_format(raw)
    if fmt == "charx":
        with open_charx(raw) as (archive, members):
            version, _, data = card_document(read_charx_card(archive, members))
            if version != 3:
                raise CardError("CHARX card.json must be a Character Card V3 document")
            media, portrait, issues = inspect_charx_media(archive, members, data.get("assets"))
        card = _parse_document(version, data, portrait, fmt)
        extensions = data.get("extensions")
        namespace = extensions.get("kohaku-roleplay", {}) if isinstance(extensions, dict) else {}
        rules = []
        if "scene_images" in namespace:
            rules, invalid = read_scene_media(namespace["scene_images"], media, card.state_fields)
            if invalid:
                issues["invalid_scene_rule"] = invalid
        return card.model_copy(update={"media": media, "media_issues": issues, "scene_media_rules": rules})
    if not 0 < len(raw) <= MAX_CARD_BYTES:
        raise CardError("Choose a non-empty JSON or PNG card no larger than 12 MiB")
    payload, portrait = _png_payload(raw) if fmt == "png" else (raw, None)
    version, _, data = card_document(payload)
    return _parse_document(version, data, portrait, fmt)


def _parse_document(version: Literal[1, 2, 3], data: dict, portrait: bytes | None, fmt: CardFormat) -> ParsedCard:
    try:
        fields = CardFields.model_validate(data)
    except ValidationError as exc:
        errors = "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors(include_input=False))
        raise CardError(f"Invalid card fields: {errors}") from exc
    book = data.get("character_book")
    if book is not None and not isinstance(book, dict):
        raise CardError("character_book must be an object")
    warnings = []
    extensions = data.get("extensions")
    definitions = decode_fields(extensions)
    if extensions and (not isinstance(extensions, dict) or set(extensions) - {"kohaku-roleplay"}):
        warnings.append("Card extensions are retained in the original; external scripts are not executed.")
    if data.get("assets") and fmt != "charx":
        warnings.append("V3 assets outside a CHARX archive are retained, not automatically fetched.")
    namespace = extensions.get("kohaku-roleplay", {}) if isinstance(extensions, dict) else {}
    portraits = read_portraits(namespace.get("portraits", []), definitions, MAX_CARD_BYTES)
    cover = next((p for p in portraits if p.field is None), None)
    if cover is not None:
        portrait = base64.b64decode(cover.data)
    card = ParsedCard(version=version, fields=fields, book=book, warnings=warnings,
                      portrait=portrait, state_fields=definitions, portraits=portraits, source_format=fmt)
    if book is not None:
        _ = card.lore
    return card
