"""Select local scene CGs and freeze their bytes in the session transcript."""

from hashlib import sha256
from pathlib import Path

from kohakuterrarium.core.tools.output import artifact_served_url
from kohakuterrarium.llm.message import ImagePart, Message, TextPart
from kohakuterrarium.modules.output.event import OutputEvent

from .charx import CardMedia, read_charx_image
from .library import original_card
from .portraits import chosen_key
from .tavern_state import TavernSession

SCENE_SOURCE = "roleplay-scene"


def scene_image(play: TavernSession) -> CardMedia | None:
    key = chosen_key(play.scene_media_rules, play.state_fields, play.values)
    return next((asset for asset in play.media if asset.key == key), None) if key else None


def save_scene_image(directory: Path, card_id: str, scene: CardMedia, store) -> ImagePart:
    png = read_charx_image(original_card(directory, card_id), scene.member)
    filename = f"roleplay-scene/{sha256(png).hexdigest()}.png"
    path = store.artifacts_dir / filename
    if not path.is_file():
        path = store.write_artifact(filename, png)
    return ImagePart(artifact_served_url(store, filename, path), source_type=SCENE_SOURCE, source_name=scene.name)


def attach_scene_image(message: Message, image: ImagePart) -> OutputEvent:
    body = message.content
    parts = [TextPart(body)] if isinstance(body, str) else list(body or ())
    message.content = [*parts, image]
    # Stock Studio consumes the display event live; canonical message parts
    # retain the image for history replay and conversation snapshots.
    return OutputEvent(type="assistant_image", payload={"url": image.url, "detail": image.detail,
                                                        "source_type": image.source_type,
                                                        "source_name": image.source_name})


def without_scene_images(messages: list[dict]) -> list[dict]:
    """Keep plot images out of gameplay requests without touching saved history."""
    result = []
    for message in messages:
        content = message.get("content")
        if message.get("role") == "assistant" and isinstance(content, list):
            parts = [part for part in content if not (
                part.get("type") == "image_url" and (part.get("meta") or {}).get("source_type") == SCENE_SOURCE
            )]
            if len(parts) != len(content):
                content = parts[0]["text"] if len(parts) == 1 and set(parts[0]) == {"type", "text"} else parts
                message = {**message, "content": content}
        result.append(message)
    return result
