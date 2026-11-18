"""Decode character cards without executing card-supplied formatting or instructions."""

import base64
import binascii
import json
from io import BytesIO
from typing import Literal

from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .card_state import StateField, decode_fields
from .errors import CardError
from .lore import load_book

MAX_CARD_BYTES = 12 * 1024 * 1024
PNG_HEADER = b"\x89PNG\r\n\x1a\n"


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
    portrait: bytes | None = None


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


def parse_card(raw: bytes) -> ParsedCard:
    if not 0 < len(raw) <= MAX_CARD_BYTES:
        raise CardError("Choose a non-empty JSON or PNG card no larger than 12 MiB")
    payload, portrait = _png_payload(raw) if raw.startswith(PNG_HEADER) else (raw, None)
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
    try:
        fields = CardFields.model_validate(data)
    except ValidationError as exc:
        errors = "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors(include_input=False))
        raise CardError(f"Invalid card fields: {errors}") from exc
    book = data.get("character_book")
    if book is not None and not isinstance(book, dict):
        raise CardError("character_book must be an object")
    if book is not None:
        load_book(book)
    warnings = []
    extensions = data.get("extensions")
    definitions = decode_fields(extensions)
    if extensions and (not isinstance(extensions, dict) or set(extensions) - {"kohaku-roleplay"}):
        warnings.append("Card extensions are retained in the original; external scripts are not executed.")
    if data.get("assets"):
        warnings.append("V3 external assets are retained, not automatically fetched.")
    return ParsedCard(version=version, fields=fields, book=book, warnings=warnings, portrait=portrait, state_fields=definitions)
