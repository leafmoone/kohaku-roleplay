"""Create a new library card by patching its original document, never its session."""

import base64
import binascii
from collections.abc import Callable
from io import BytesIO
import json
from pathlib import Path
import struct
import zlib

from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .card_state import StateField
from .cards import CardError, CardFields, PNG_HEADER, card_document, card_format, parse_card, require_editable
from .library import CardSummary, get_card, import_card, original_card


class CopyRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    id: str = Field(min_length=1)
    fields: dict[str, object] = Field(default_factory=dict)
    stateDefinitions: list[StateField] = Field(default_factory=list)

    @field_validator("fields")
    @classmethod
    def editable_fields(cls, value: dict[str, object]) -> dict[str, object]:
        unknown = value.keys() - CardFields.model_fields.keys()
        if unknown:
            raise ValueError("Unsupported editable fields: " + ", ".join(sorted(unknown)))
        return value


def edit_draft(directory: Path, key: str) -> dict[str, object]:
    card = get_card(directory, key)
    require_editable(card.source_format)
    return {"id": key, "fields": card.fields.model_dump(),
            "stateDefinitions": [f.model_dump(exclude_none=True, exclude_unset=True) for f in card.state_fields]}


def _rewrite_png(raw: bytes, edit: Callable[[bytes], bytes]) -> bytes:
    # Inputs are verified library originals. Preserve IDAT, animation, other metadata
    # and embedded assets exactly; only replace the character-card text chunks.
    with Image.open(BytesIO(raw), formats=("PNG",)) as image:
        metadata = image.text
    out = BytesIO()
    out.write(PNG_HEADER)
    pos = len(PNG_HEADER)
    seen = set()
    while pos < len(raw):
        length = int.from_bytes(raw[pos:pos + 4], "big")
        kind = raw[pos + 4:pos + 8]
        end = pos + length + 12
        key = b""
        if kind in (b"tEXt", b"zTXt", b"iTXt"):
            key = raw[pos + 8:pos + 8 + min(length, 80)].split(b"\0", 1)[0]
        if key in (b"chara", b"ccv3"):
            if key in seen:
                raise CardError(f"Cannot edit a PNG with duplicate {key.decode()} documents")
            seen.add(key)
            try:
                payload = base64.b64decode(metadata[key.decode()], validate=True)
            except (KeyError, ValueError, binascii.Error) as exc:
                raise CardError(f"Cannot edit unreadable {key.decode()} PNG metadata") from exc
            document = edit(payload)
            if key == b"chara" and metadata.get("ccv3"):
                # The importer validates the preferred document later. The legacy
                # companion must also be playable by readers that only know chara.
                parse_card(document)
            content = key + b"\0" + base64.b64encode(document)
            chunk = b"tEXt" + content
            out.write(struct.pack(">I", len(content)) + chunk + struct.pack(">I", zlib.crc32(chunk)))
        else:
            out.write(raw[pos:end])
        pos = end
    if not seen:
        raise CardError("PNG contains no editable card document")
    return out.getvalue()


def updated_card(raw: bytes, edit: Callable[[dict], None]) -> bytes:
    def update(payload: bytes) -> bytes:
        _, envelope, data = card_document(payload)
        edit(data)
        return json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    return _rewrite_png(raw, update) if raw.startswith(PNG_HEADER) else update(raw)


def save_copy(directory: Path, request: CopyRequest) -> CardSummary:
    original = original_card(directory, request.id)
    require_editable(card_format(original))
    change_state = "stateDefinitions" in request.model_fields_set

    def edit(data: dict) -> None:
        data.update(request.fields)
        if change_state:
            # Do not create an extension (or replace an opaque third-party one) just to clear absent fields.
            extensions = data.get("extensions")
            if not request.stateDefinitions and (not isinstance(extensions, dict) or "kohaku-roleplay" not in extensions):
                return
            if "extensions" not in data:
                data["extensions"] = {}
            if not isinstance(data["extensions"], dict):
                raise CardError("Cannot add state definitions to non-object extensions")
            namespace = data["extensions"].setdefault("kohaku-roleplay", {})
            if not isinstance(namespace, dict):
                raise CardError("extensions.kohaku-roleplay must be an object")
            namespace["state"] = [f.model_dump(exclude_none=True, exclude_unset=True) for f in request.stateDefinitions]

    encoded = updated_card(original, edit) if (request.fields or change_state) else original
    return import_card(directory, encoded)
