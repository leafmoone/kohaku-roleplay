"""Start roleplay sessions through Studio on the local single-user host."""

from asyncio import to_thread
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse
from kohakuterrarium.api.auth.dependencies import get_auth_config
from kohakuterrarium.api.ext import current_service, require_admin, studio
from kohakuterrarium.core.events import TriggerEvent
from kohakuterrarium.modules.ui_owner import OwnerArgumentError
from kohakuterrarium.studio.studio import Studio
from kohakuterrarium.terrarium import LocalTerrariumService, TerrariumService
from pydantic import Field

from .cast import (
    NovelSettings,
    WorldbookSnapshot,
    cast_recipe,
    initialize_npc,
    member_from_card,
)
from .charx import read_charx_image
from .default_narrator import (
    DEFAULT_NARRATOR_ASSET,
    DEFAULT_NARRATOR_ID,
    card_voice,
    default_narrator_narrator,
)
from .gameplay_pack import GameplayPackUnavailable, tavern_creature
from .library import CardNotFound, get_card, original_card
from .novel import PLAYER, Chapter, CharacterSheet, PlayerMode, Story, sheet_from_fields
from .paths import library_dir
from .runtime import RoleplayPlugin
from .tavern_opening import resolve_tavern_worldbook
from .tavern_state import Arguments, Play
from .worldbook_library import WorldbookNotFound, worldbook_for_play

ServiceDep = Annotated[TerrariumService, Depends(current_service)]


def local_host(request: Request, service: ServiceDep) -> None:
    if get_auth_config(request).multi_user_enabled or not isinstance(service, LocalTerrariumService):
        raise HTTPException(403, "Roleplay launch requires a local single-user Studio host")


router = APIRouter(dependencies=[Depends(require_admin), Depends(local_host)])
StudioDep = Annotated[Studio, Depends(studio)]


class NovelStart(Arguments):
    cardIds: list[str] = Field(min_length=1, max_length=32)
    name: str | None = None
    narratorCardId: str | None = None
    styleCardId: str | None = None
    worldbookIds: list[str] = Field(default_factory=list, max_length=8)
    includeCardLore: bool = False
    playerMode: PlayerMode = "protagonist"
    playerName: str = Field(default="Player", max_length=80)
    playerPersona: str = Field(default="", max_length=4000)
    premise: str = Field(default="", max_length=8000)
    sheetHint: str = Field(default="", max_length=1000)
    prologueTitle: str = Field(default="", max_length=200)
    prologueText: str = Field(default="", max_length=20000)
    prologuePrompt: str = Field(default="", max_length=4000)


def _library_card(key: str):
    try:
        return get_card(library_dir(), key)
    except CardNotFound as exc:
        raise HTTPException(404, f"Character card not found: {key}") from exc


@router.post("/taverns")
async def start_tavern(body: Play, host: StudioDep) -> dict[str, str]:
    card = _library_card(body.cardId)
    if body.greetingIndex > len(card.fields.alternate_greetings):
        raise HTTPException(422, "Opening index is out of range")
    try:
        book = resolve_tavern_worldbook(library_dir(), body)
    except WorldbookNotFound as exc:
        raise HTTPException(404, "The selected worldbook is no longer in the library") from exc
    try:
        creature = tavern_creature(card.gameplay_pack)
    except GameplayPackUnavailable as exc:
        raise HTTPException(409, str(exc)) from exc
    session = await host.sessions.start_creature(creature, name=card.fields.name)
    sid = session.session_id
    try:
        entry = host.sessions.find_creature(sid, session.creatures[0]["creature_id"])
        plugin = entry.agent.plugins.get_plugin("roleplay")
        if not isinstance(plugin, RoleplayPlugin) or plugin.mode != "tavern":
            raise OwnerArgumentError("The selected creature did not load the tavern plugin")
        await plugin.ui_call("start_tavern", body.model_dump(exclude_unset=True), None, prepared_worldbook=book)
        return {"sessionId": sid, "creatureId": entry.creature_id}
    except Exception:
        await host.sessions.end(sid)
        raise


@router.get("/default-narrator.png", response_class=FileResponse)
async def default_narrator_portrait() -> FileResponse:
    return FileResponse(DEFAULT_NARRATOR_ASSET, media_type="image/png")


@router.get("/novel-media/{session_id}/{actor}")
async def novel_media(session_id: str, actor: str, key: str, host: StudioDep) -> Response:
    try:
        root = host.sessions.find_creature(session_id, "root")
    except KeyError as exc:
        raise HTTPException(404, "Novel media not found") from exc
    plugin = root.agent.plugins.get_plugin("roleplay")
    if isinstance(plugin, RoleplayPlugin) and plugin.mode == "novel":
        for member in plugin.novel.members(plugin.binding):
            if member.actor != actor:
                continue
            if asset := next((asset for asset in member.media if asset.key == key), None):
                try:
                    original = await to_thread(original_card, library_dir(), member.cardId)
                    image = await to_thread(read_charx_image, original, asset.member)
                except (CardNotFound, ValueError) as exc:
                    raise HTTPException(404, "Novel media not found") from exc
                return Response(image, media_type="image/png")
    raise HTTPException(404, "Novel media not found")


@router.post("/novels")
async def start_novel(body: NovelStart, host: StudioDep, service: ServiceDep) -> dict[str, str]:
    directory = library_dir()
    cards = [(key, _library_card(key)) for key in body.cardIds]
    members = [member_from_card(f"npc_{index}", key, card, "") for index, (key, card) in enumerate(cards, 1)]
    books = []
    try:
        for key in dict.fromkeys(body.worldbookIds):
            ref, book = worldbook_for_play(directory, key)
            books.append(WorldbookSnapshot(**ref, book=book))
    except WorldbookNotFound as exc:
        raise HTTPException(404, "The selected worldbook is no longer in the library") from exc
    if body.includeCardLore:
        for key, card in dict(cards).items():
            if card.lore is not None:
                books.append(WorldbookSnapshot(id=f"card:{key}", name=card.fields.name, book=card.lore))
    narrator_id = body.narratorCardId
    if not narrator_id or narrator_id == DEFAULT_NARRATOR_ID:
        narrator = default_narrator_narrator()
    elif narrator_id == "__none__":
        narrator = None
    else:
        narrator = card_voice(narrator_id, _library_card(narrator_id).fields)
    style_id = body.styleCardId
    style = card_voice(style_id, _library_card(style_id).fields) if style_id else None
    settings = NovelSettings(title=body.name or "Roleplay Novel", playerMode=body.playerMode,
                            playerName=body.playerName.strip() or "Player", playerPersona=body.playerPersona,
                            premise=body.premise, sheetHint=body.sheetHint, narrator=narrator, style=style, includeCardLore=body.includeCardLore)
    sheets = {m.actor: sheet_from_fields(m.state_fields, {}) for m in members}
    if body.playerMode == "protagonist":
        sheets[PLAYER] = CharacterSheet()
    chapters = [Chapter(number=0, title=body.prologueTitle or "Prologue", prose=body.prologueText)] if body.prologueText else []
    story = Story(cast=[m.actor for m in members], sheets=sheets, playerMode=body.playerMode,
                  latest_prose=body.prologueText, chapters=chapters)
    recipe = cast_recipe(directory / "recipes", members)
    try:
        session = await host.sessions.start_terrarium(recipe, name=body.name or "Roleplay Novel")
    except Exception:
        recipe.unlink()
        raise
    sid = session.session_id
    try:
        root = host.sessions.find_creature(sid, "root")
        plugin = root.agent.plugins.get_plugin("roleplay")
        if not isinstance(plugin, RoleplayPlugin) or plugin.mode != "novel":
            raise OwnerArgumentError("Director was not loaded on the novel root")
        if plugin.binding is None or plugin.binding.session_store is None:
            raise OwnerArgumentError("Director has no persistent session")
        plugin.binding.set_state("cast", [member.model_dump() for member in members])
        plugin.binding.set_state("novelSettings", settings.model_dump())
        plugin.binding.set_state("narrator", narrator.model_dump() if narrator else None)
        plugin.binding.set_state("novelWorldbooks", [book.model_dump() for book in books])
        plugin.save_story(story)
        for member in members:
            npc = host.sessions.find_creature(sid, member.actor)
            actor_plugin = npc.agent.plugins.get_plugin("roleplay")
            if not isinstance(actor_plugin, RoleplayPlugin) or actor_plugin.mode != "npc":
                raise OwnerArgumentError(f"NPC roleplay plugin missing: {member.actor}")
            if actor_plugin.binding is None or actor_plugin.binding.session_store is None:
                raise OwnerArgumentError(f"NPC has no persistent session: {member.actor}")
            initialize_npc(actor_plugin.binding, member, story)
            await service.wire_creature(sid, root.creature_id, member.actor, "send", enabled=True)
        if chapters:
            await plugin.publish_opening(body.prologueText)
        elif body.prologuePrompt:
            plugin.can_open_scene = True
            await root.agent.inject_event(TriggerEvent(type="roleplay_opening", content=f"Opening scene request:\n{body.prologuePrompt}"))
        return {"sessionId": sid, "creatureId": root.creature_id}
    except Exception:
        await host.sessions.end(sid)
        raise
