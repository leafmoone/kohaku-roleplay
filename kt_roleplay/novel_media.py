"""Local images and session-backed Novel Reader media."""

import base64
import binascii
from io import BytesIO
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

from kohakuterrarium.core.tools.output import artifact_served_url
from kohakuterrarium.llm.message import ImagePart
from kohakuterrarium.terrarium.tools.context import resolve_group_context
from PIL import Image, UnidentifiedImageError

from .cast import CastMember
from .novel import Outcome, SceneError, Story
from .paths import library_dir
from .portraits import chosen_key
from .tavern_media import SCENE_SOURCE, save_scene_image

FORMATS = {"png": "PNG", "jpeg": "JPEG", "webp": "WEBP"}
MAX_IMAGE = 8 * 1024 * 1024


def media_pool(binding, members: list[CastMember]) -> list[dict[str, str]]:
    rows = []
    if any(member.media for member in members):
        group = resolve_group_context(binding.host_agent.executor._build_tool_context())
        session = quote(group.caller.graph_id, safe="")
    for member in members:
        for asset in member.media:
            actor = quote(member.actor, safe="")
            url = f"/api/ext/kohaku-roleplay/novel-media/{session}/{actor}?key={quote(asset.key, safe='')}"
            rows.append({"key": f"{member.actor}:{asset.key}", "actor": member.actor, "cardId": member.cardId,
                         "name": asset.name, "url": url})
    store = binding.session_store
    directory = store.artifacts_dir / "novel-media"
    names = binding.get_state("novelMediaNames") or {}
    for path in sorted(directory.glob("*")):
        if path.is_file() and path.suffix.lstrip(".").lower() in FORMATS:
            key = f"novel-media/{path.name}"
            rows.append({"key": key, "name": names.get(key, path.name), "url": artifact_served_url(store, key, path)})
    return rows


def materialize_image(binding, members: list[CastMember], story: Story, outcome: Outcome) -> ImagePart | None:
    explicit = outcome.scene_image_key
    actors = story.chapters[-1].actors
    for member in members:
        if explicit is None:
            if actors and member.actor not in actors:
                continue
            selected = chosen_key(member.scene_media_rules, member.state_fields, story.card_values.get(member.actor, {}))
        else:
            actor, _, key = explicit.partition(":")
            selected = key if actor == member.actor else None
        if asset := next((asset for asset in member.media if asset.key == selected), None):
            return save_scene_image(library_dir(), member.cardId, asset, binding.session_store)
    if explicit:
        for row in media_pool(binding, []):
            if row["key"] == explicit:
                return ImagePart(row["url"], source_type=SCENE_SOURCE, source_name=row["name"])
        raise SceneError("The scene image is not in this novel's local media pool")
    return None


def upload_image(store, data_url: str, name: str) -> tuple[str, str, str]:
    header, separator, encoded = data_url.partition(",")
    kind = next((kind for kind in FORMATS if header == f"data:image/{kind};base64"), None)
    if not separator or kind is None or len(encoded) > ((MAX_IMAGE + 2) // 3) * 4:
        raise SceneError("Upload a PNG, JPEG or WEBP data URL of at most 8 MB")
    try:
        raw = base64.b64decode(encoded, validate=True)
        if not 0 < len(raw) <= MAX_IMAGE:
            raise SceneError("Upload a non-empty image of at most 8 MB")
        with Image.open(BytesIO(raw), formats=(FORMATS[kind],)) as image:
            image.verify()
    except (binascii.Error, UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError) as exc:
        raise SceneError("The uploaded data is not a valid image of the declared type") from exc
    key = f"novel-media/{uuid4().hex}.{kind}"
    path = store.write_artifact(key, raw)
    return key, artifact_served_url(store, key, path), Path(name.replace("\\", "/")).name or path.name
