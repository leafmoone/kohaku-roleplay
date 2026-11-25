"""Director-only library lookup and live cast changes."""

import json
from asyncio import to_thread
from pathlib import Path

from kohakuterrarium.modules.tool.base import ToolContext, ToolResult
from kohakuterrarium.terrarium.creature.ops import wire_creature_on_engine
from kohakuterrarium.terrarium.tools.context import resolve_group_context

from .cards import CardFields
from .cast import (
    CastMember,
    WorldbookSnapshot,
    initialize_npc,
    member_from_card,
    npc_spec,
    taken_actor_names,
    unique_actor_name,
    write_recipe,
)
from .library import get_card, import_card
from .library_view import cards_view
from .novel import Key, SceneError, Story, StoryModel, sheet_from_fields
from .paths import library_dir
from .scene_tools import SceneTool


class Lookup(StoryModel):
    query: str = ""


class Spawn(StoryModel):
    card_id: Key
    initial_note: str = ""


class Create(StoryModel):
    name: Key
    description: str
    personality: str
    voice_examples: str = ""
    initial_note: str = ""
    save_to_library: bool = False


def save_new_card(directory: Path, card: CardFields) -> str:
    return import_card(directory, card.model_dump_json().encode("utf-8"))["id"]


def search_cards(directory: Path, query: str, in_cast: set[str]) -> list[dict[str, object]]:
    found = []
    for row in cards_view(directory)["cards"]:
        fields = get_card(directory, row["id"]).fields
        if query and query not in (fields.name + "\n" + fields.description).casefold():
            continue
        found.append({"cardId": row["id"], "name": row["name"], "summary": " ".join(fields.description.split())[:240],
                      "hasPortrait": row["hasPortrait"], "inCast": row["id"] in in_cast})
    return found


async def add_cast_node(engine, root, binding, member: CastMember, story: Story):
    actor, graph_id = member.actor, root.graph_id
    recipe = write_recipe(library_dir() / "recipes", npc_spec(actor))
    npc = None
    channel_created = False
    try:
        npc = await engine.add_creature(recipe, graph=graph_id, parent_creature_id=root.creature_id, io="none", name=actor)
        child = npc.agent.plugins.get_plugin("roleplay")
        if child is None or child.mode != "npc" or child.binding is None or child.binding.session_store is not binding.session_store:
            raise SceneError("The new NPC did not join this novel's persistent session")
        initialize_npc(child.binding, member, story)
        await engine.add_channel(graph_id, actor, description="Private NPC observation")
        channel_created = True
        for node, channel, direction in ((root, actor, "send"), (root, actor, "listen"), (npc, actor, "listen"),
                                         (npc, "report_to_root", "send")):
            wire_creature_on_engine(engine, graph_id, node.creature_id, channel, direction, enabled=True)
    except BaseException:
        if npc is not None:
            await engine.remove_creature(npc.creature_id, split=False)
        if channel_created:
            await engine.remove_channel(graph_id, actor)
        recipe.unlink(missing_ok=True)
        raise
    return npc, recipe


async def spawn_member(host, context: ToolContext, member: CastMember, book: WorldbookSnapshot | None) -> CastMember:
    host.require_open_scene()
    group = resolve_group_context(context)
    root, engine = group.caller, group.engine
    binding = host.binding
    if binding is None or root.agent is not binding.host_agent or binding.session_store is None:
        raise SceneError("Only this novel's director can add a cast member")
    graph_id = root.graph_id
    story = host.story()
    actor = unique_actor_name(member.card.name, taken_actor_names(group) | set(story.cast))
    member = member.model_copy(update={"actor": actor})
    story = story.model_copy(update={"cast": [*story.cast, actor], "sheets": {
        **story.sheets, actor: sheet_from_fields(member.state_fields, {}),
    }})
    npc, recipe = await add_cast_node(engine, root, binding, member, story)
    try:
        await engine.checkpoint_graph(graph_id)
        host.require_open_scene()
        latest = host.story()
        story = latest.model_copy(update={"cast": [*latest.cast, actor], "sheets": {**latest.sheets, actor: story.sheets[actor]}})
        members = [*host.novel.members(binding), member]
        books = host.novel.worldbooks(binding)
        rows = [(binding._state_key("cast"), [row.model_dump() for row in members]),
                (binding._state_key("novel"), story.model_dump())]
        if book and all(row.id != book.id for row in books):
            rows.append((binding._state_key("novelWorldbooks"), [row.model_dump() for row in [*books, book]]))
        binding.session_store.state.put_many(rows)
    except BaseException:
        await engine.remove_creature(npc.creature_id, split=False)
        await engine.remove_channel(graph_id, actor)
        recipe.unlink(missing_ok=True)
        raise
    host.ui_emit("state", host.ui_state())
    return member


class CastTool(SceneTool):
    def __init__(self, host):
        super().__init__()
        self.host = host


class ListLibraryCards(CastTool):
    tool_name = "rp_list_library_cards"
    description = "Find reusable character cards by name or description. This does not change the cast."
    arguments = Lookup

    async def _execute(self, args: dict, context: ToolContext) -> ToolResult:
        self.host.require_open_scene()
        query = Lookup.model_validate(args).query.strip().casefold()
        used = {m.cardId for m in self.host.novel.members(self.host.binding)}
        return ToolResult(output=json.dumps({"cards": await to_thread(search_cards, library_dir(), query, used)}, ensure_ascii=False))


class SpawnCast(CastTool):
    tool_name = "rp_spawn_cast_from_card"
    description = "Add an independent NPC from a library card between scenes. Initial note is private to that NPC."
    arguments = Spawn

    async def _execute(self, args: dict, context: ToolContext) -> ToolResult:
        self.host.require_open_scene()
        request = Spawn.model_validate(args)
        card = await to_thread(get_card, library_dir(), request.card_id)
        member = member_from_card("", request.card_id, card, request.initial_note)
        book = None
        if self.host.novel.settings(self.host.binding).includeCardLore and card.lore is not None:
            book = WorldbookSnapshot(id=f"card:{request.card_id}", name=card.fields.name, book=card.lore)
        member = await spawn_member(self.host, context, member, book)
        return ToolResult(output=json.dumps({"actor": member.actor, "name": member.card.name, "cardId": member.cardId}, ensure_ascii=False))


class CreateCast(CastTool):
    tool_name = "rp_create_cast_character"
    description = "Create a new independent NPC between scenes. Save to the reusable card library only when requested."
    arguments = Create

    async def _execute(self, args: dict, context: ToolContext) -> ToolResult:
        self.host.require_open_scene()
        request = Create.model_validate(args)
        card = CardFields(name=request.name, description=request.description, personality=request.personality,
                          scenario="", first_mes="", mes_example=request.voice_examples)
        card_id = await to_thread(save_new_card, library_dir(), card) if request.save_to_library else ""
        member = await spawn_member(self.host, context, CastMember(actor="", cardId=card_id, card=card,
                                   hasPortrait=False, initial_note=request.initial_note), None)
        return ToolResult(output=json.dumps({"actor": member.actor, "name": member.card.name, "cardId": member.cardId}, ensure_ascii=False))
