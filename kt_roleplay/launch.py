"""Start roleplay sessions through Studio on the local single-user host."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import Field
from kohakuterrarium.api.auth.dependencies import get_auth_config
from kohakuterrarium.api.ext import current_service, require_admin, studio
from kohakuterrarium.modules.ui_owner import OwnerArgumentError
from kohakuterrarium.studio.studio import Studio
from kohakuterrarium.terrarium import LocalTerrariumService, TerrariumService

from .cast import CastMember, cast_recipe
from .library import CardNotFound, get_card
from .runtime import Arguments, Play, RoleplayPlugin, library_dir


def local_host(request: Request, service: TerrariumService = Depends(current_service)) -> None:
    if get_auth_config(request).multi_user_enabled or not isinstance(service, LocalTerrariumService):
        raise HTTPException(403, "Roleplay launch requires a local single-user Studio host")


router = APIRouter(dependencies=[Depends(require_admin), Depends(local_host)])
StudioDep = Annotated[Studio, Depends(studio)]
ServiceDep = Annotated[TerrariumService, Depends(current_service)]


class NovelStart(Arguments):
    cardIds: list[str] = Field(min_length=1, max_length=32)
    name: str | None = None


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
    session = await host.sessions.start_creature("@kohaku-roleplay/creatures/rp_agent", name=card.fields.name)
    sid = session.session_id
    try:
        entry = host.sessions.find_creature(sid, session.creatures[0]["creature_id"])
        plugin = entry.agent.plugins.get_plugin("roleplay")
        if not isinstance(plugin, RoleplayPlugin) or plugin.mode != "tavern":
            raise OwnerArgumentError("The selected creature did not load the tavern plugin")
        await plugin.ui_call("start_tavern", body.model_dump(), None)
        return {"sessionId": sid, "creatureId": entry.creature_id}
    except Exception:
        await host.sessions.end(sid)
        raise


@router.post("/novels")
async def start_novel(body: NovelStart, host: StudioDep, service: ServiceDep) -> dict[str, str]:
    members = []
    for index, key in enumerate(body.cardIds, 1):
        card = _library_card(key)
        members.append(CastMember(actor=f"npc_{index}", cardId=key, card=card.fields, hasPortrait=card.portrait is not None, state_fields=card.state_fields))
    recipe = cast_recipe(library_dir() / "recipes", members)
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
        for member in members:
            npc = host.sessions.find_creature(sid, member.actor)
            actor_plugin = npc.agent.plugins.get_plugin("roleplay")
            if not isinstance(actor_plugin, RoleplayPlugin) or actor_plugin.mode != "npc":
                raise OwnerArgumentError(f"NPC roleplay plugin missing: {member.actor}")
            if actor_plugin.binding is None or actor_plugin.binding.session_store is None:
                raise OwnerArgumentError(f"NPC has no persistent session: {member.actor}")
            actor_plugin.binding.set_state("character", member.card.model_dump())
            if member.state_fields:
                actor_plugin.binding.set_state("fieldDefinitions", [f.model_dump() for f in member.state_fields])
            await service.wire_creature(sid, root.creature_id, member.actor, "send", enabled=True)
        plugin.story()
        return {"sessionId": sid, "creatureId": root.creature_id}
    except Exception:
        await host.sessions.end(sid)
        raise
