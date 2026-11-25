"""Novel Reader actions scoped to the owning director and its session."""

from asyncio import to_thread
from typing import Literal

from kohakuterrarium.terrarium.tools.context import (
    resolve_group_context,
    resolve_group_target,
)
from pydantic import Field

from .cast import CastMember
from .cast_tools import save_new_card
from .novel import Key, SceneError, StoryModel, story_chapters
from .novel_media import upload_image
from .novel_revision import (
    REVISION_ACTIONS,
    active_revision,
    call_revision,
    save_chapter,
    variant_id,
)
from .paths import library_dir
from .worldbook_library import snapshot_detail

READER_ACTIONS = REVISION_ACTIONS | {"submit_novel_input", "save_cast_to_library", "upload_novel_media", "novel_worldbook_detail"}


class NovelInput(StoryModel):
    text: Key


class CastSelection(StoryModel):
    actor: Key


class MediaUpload(StoryModel):
    target: Literal["chapter", "actor"]
    number: int | None = Field(default=None, ge=0)
    actor: str | None = None
    dataUrl: str
    name: str = ""


class BookSelection(StoryModel):
    index: int = Field(ge=0)


def cast_member(host, actor: str) -> CastMember:
    for member in host.novel.members(host.binding):
        if member.actor == actor:
            return member
    raise SceneError("The requested actor is not in this novel's cast")


def update_member(host, member: CastMember) -> None:
    binding = host.binding
    group = resolve_group_context(binding.host_agent.executor._build_tool_context())
    actor = resolve_group_target(group, member.actor).agent.plugins.get_plugin("roleplay")
    if actor is None or actor.mode != "npc" or actor.binding is None or actor.binding.session_store is not binding.session_store:
        raise SceneError("The selected NPC is not bound to this novel's session")
    rows = [member if row.actor == member.actor else row for row in host.novel.members(binding)]
    binding.session_store.state.put_many([
        (binding._state_key("cast"), [row.model_dump() for row in rows]),
        (actor.binding._state_key("castMember"), member.model_dump(exclude={"card", "media", "scene_media_rules"})),
    ])
    actor.ui_emit("state", actor.ui_state())


async def call_reader(host, action: str, args: dict[str, object]) -> dict[str, object]:
    binding = host.binding
    if binding is None or binding.session_store is None or binding.host_agent is None:
        raise SceneError("The reader needs a live persistent novel")
    if action in REVISION_ACTIONS:
        return await call_revision(host, action, args)
    if action == "novel_worldbook_detail":
        index = BookSelection.model_validate(args).index
        books = host.novel.worldbooks(binding)
        if index >= len(books):
            raise SceneError("The selected worldbook is not bound to this novel")
        return snapshot_detail(books[index].name, books[index].book)
    root = binding.host_agent
    if action == "submit_novel_input":
        text = NovelInput.model_validate(args).text.strip()
        if not text:
            raise SceneError("Enter a non-empty player response")
        if root.is_processing or not root.is_running or root.paused or host.story().pending is not None or active_revision(binding):
            raise SceneError("Wait for the director to be idle with no pending scene")
        await root.inject_input(text, source="web")
    elif action == "save_cast_to_library":
        member = cast_member(host, CastSelection.model_validate(args).actor)
        if member.cardId:
            raise SceneError("This cast member is already in the library")
        card_id = save_new_card(library_dir(), member.card)
        update_member(host, member.model_copy(update={"cardId": card_id}))
    else:
        upload = MediaUpload.model_validate(args)
        if upload.target == "actor":
            cast_member(host, upload.actor or "")
        else:
            if active_revision(binding) or not any(chapter.number == upload.number for chapter in story_chapters(host.story())):
                raise SceneError("The chapter is unavailable during the current rewrite")
            version = variant_id(binding)
        key, url, name = await to_thread(upload_image, binding.session_store, upload.dataUrl, upload.name)
        if upload.target == "actor":
            current = cast_member(host, upload.actor or "")
            update_member(host, current.model_copy(update={"customPortraitUrl": url}))
        else:
            if active_revision(binding) or variant_id(binding) != version:
                raise SceneError("The active variant changed during upload; select the chapter again")
            save_chapter(host, host.story(), upload.number, {"imageUrl": url})
        binding.set_state("novelMediaNames", {**(binding.get_state("novelMediaNames") or {}), key: name})
    view = host.ui_state()
    host.ui_emit("state", view)
    return view
