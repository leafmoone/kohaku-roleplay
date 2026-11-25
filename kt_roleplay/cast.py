"""Configure story creatures and project only their own perspective."""

import json
from pathlib import Path
from unicodedata import category
from uuid import uuid4

import yaml
from kohakuterrarium.modules.ui_owner import OwnerArgumentError
from kohakuterrarium.terrarium.tools.context import compute_group
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from .card_state import (
    StateField,
    model_fields,
    public_fields,
    update_values,
)
from .cards import CardFields, ParsedCard
from .charx import CardMedia
from .default_narrator import DEFAULT_NARRATOR_PORTRAIT_URL, Narrator
from .novel import (
    CHOICE_SHAPE,
    PLAYER,
    ActorMemory,
    CharacterSheet,
    Outcome,
    PlayerMode,
    SheetPatch,
    Story,
    actor_memory,
    chapter_view,
    filter_sheet,
    patch_sheet,
    sheet_from_fields,
    split_choices,
    story_chapters,
)
from .portraits import PortraitRule, chosen_key, rules_for
from .scene_tools import CheckScene, CommitScene, DispatchScene, ReportScene
from .worldbook import LoreBook


class CastMember(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    actor: str
    cardId: str
    card: CardFields
    hasPortrait: bool
    portrait_rules: list[PortraitRule] = Field(default_factory=list)
    state_fields: list[StateField] = Field(default_factory=list)
    media: list[CardMedia] = Field(default_factory=list)
    scene_media_rules: list[PortraitRule] = Field(default_factory=list)
    initial_note: str = ""
    customPortraitUrl: str | None = None


class WorldbookSnapshot(BaseModel):
    id: str
    name: str
    book: LoreBook


class NovelSettings(BaseModel):
    title: str = "Roleplay Novel"
    playerMode: PlayerMode = "protagonist"
    playerName: str = "Player"
    playerPersona: str = ""
    premise: str = ""
    sheetHint: str = ""
    narrator: Narrator | None = None
    style: Narrator | None = None
    includeCardLore: bool = False
    enableStoryChoices: bool = True
    initialActors: list[str] = Field(default_factory=list)

    def prose_reference(self) -> dict[str, object]:
        return {"narrator": self.narrator.model_dump() if self.narrator else None,
                "proseStyle": self.style.model_dump() if self.style else None}


RESERVED_ACTORS = {PLAYER, "root", "report_to_root"}


def clean_node_name(name: str, fallback: str) -> str:
    clean = "".join(" " if char in "/\\" or category(char) in {"Cc", "Cs"} else char for char in name).strip()
    return clean if clean and clean not in {".", ".."} else fallback


def unique_actor_name(name: str, taken: set[str]) -> str:
    base = " ".join(clean_node_name(name, "角色").split())
    candidate = base
    index = 2
    while candidate in RESERVED_ACTORS or candidate in taken:
        candidate = f"{base} ({index})"
        index += 1
    return candidate


def taken_actor_names(group) -> set[str]:
    nodes = compute_group(group)
    return {*group.graph.channels, *nodes, *(node.name for node in nodes.values())}


def member_from_card(actor: str, card_id: str, card: ParsedCard, note: str) -> CastMember:
    return CastMember(actor=actor, cardId=card_id, card=card.fields.model_copy(update={"first_mes": "", "alternate_greetings": []}),
                      hasPortrait=card.portrait is not None, portrait_rules=rules_for(card.portraits), state_fields=card.state_fields,
                      media=card.media, scene_media_rules=card.scene_media_rules, initial_note=note)


def creature_spec(mode: str) -> dict:
    return {"fork_enabled": False, "output": {"type": "stdout", "controller_direct": True},
            "plugins": [{"name": "roleplay", "type": "package", "options": {"mode": mode}}]}


def npc_spec(actor: str) -> dict:
    return {**creature_spec("npc"), "name": actor,
            "system_prompt": "Act as the character using only your own sensory cue and private experience. Return speech, attempted action and private reaction via rp_report_scene once. Do not write the reader's novel. End the turn after reporting."}


def director_recipe(directory: Path, name: str) -> Path:
    director = {**creature_spec("novel"), "name": name}
    director["system_prompt"] = "You are the omniscient novelist. Commit directly when no independent NPC proposal is needed. Otherwise dispatch only to characters who can perceive the scene, with a separate perceptual cue for each. End the turn while reports are missing; never invent them. When ready, commit the chapter and state changes once using rp_commit_scene; the host publishes it. Do not open another scene after a delayed notification for a finished scene. Preserve the player's agency and keep private information separate from what each character can know."
    return write_recipe(directory, director)


def write_recipe(directory: Path, spec: dict) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (uuid4().hex + ".yaml")
    with path.open("x", encoding="utf-8") as stream:
        yaml.safe_dump(spec, stream, allow_unicode=True, sort_keys=False)
    return path


def initialize_npc(binding, member: CastMember, story: Story) -> None:
    binding.set_state("character", member.card.model_dump())
    binding.set_state("castMember", member.model_dump(exclude={"card", "media", "scene_media_rules"}))
    binding.set_state("fieldDefinitions", [f.model_dump() for f in member.state_fields])
    binding.set_state("characterSheet", story.sheets[member.actor].model_dump())
    binding.set_state("privateKnowledge", actor_memory(story, member.actor).model_dump())


def npc_memory(binding) -> ActorMemory:
    raw = binding.get_state("privateKnowledge") or {}
    if "known" in raw:
        return actor_memory(Story(cast=[], knowledge={"npc": raw["known"]}), "npc")
    return ActorMemory.model_validate(raw)


def npc_sheet(binding) -> CharacterSheet:
    if (data := binding.get_state("characterSheet")) is not None:
        return CharacterSheet.model_validate(data)
    fields = TypeAdapter(list[StateField]).validate_python(binding.get_state("fieldDefinitions") or [])
    return sheet_from_fields(fields, binding.get_state("fieldValues") or {})


def character_material(card: CardFields) -> dict[str, str]:
    return {"name": card.name, "description": card.description, "personality": card.personality,
            "character_background": card.scenario, "voice_examples": card.mes_example}


def cast_material(member: CastMember) -> dict[str, str]:
    return {**character_material(member.card), "initial_note": member.initial_note}


class NovelBinding:
    def __init__(self, actor: bool):
        self.actor = actor

    def members(self, binding) -> list[CastMember]:
        return TypeAdapter(list[CastMember]).validate_python(binding.get_state("cast") or [])

    def settings(self, binding) -> NovelSettings:
        return NovelSettings.model_validate(binding.get_state("novelSettings") or {})

    def worldbooks(self, binding) -> list[WorldbookSnapshot]:
        return TypeAdapter(list[WorldbookSnapshot]).validate_python(binding.get_state("novelWorldbooks") or [])

    def story(self, binding) -> Story:
        if binding is None or binding.session_store is None:
            raise OwnerArgumentError("The novel requires a persistent KT session")
        record = binding.get_state("novel")
        members = self.members(binding)
        story = Story.model_validate(record) if record is not None else Story(cast=[m.actor for m in members])
        if any(member.actor not in story.sheets for member in members):
            seeded = {m.actor: sheet_from_fields(m.state_fields, story.card_values.get(m.actor, {})) for m in members if m.actor not in story.sheets}
            story = story.model_copy(update={"sheets": {**seeded, **story.sheets}})
        return story

    def apply_fields(self, binding, story: Story, outcome: Outcome) -> Story:
        members = {m.actor: m for m in self.members(binding)}
        changes, sheets = dict(story.card_values), dict(story.sheets)
        for actor, patch in outcome.card_updates.items():
            member = members[actor]
            values = update_values(member.state_fields, changes.get(actor, {}), patch)
            changes[actor] = values
            keys = {item.key for item in patch}
            explicit = outcome.sheet_updates.get(actor, SheetPatch())
            keys.difference_update([*explicit.remove_keys, *(item.key for group in (explicit.meters, explicit.entries, explicit.lists) for item in group)])
            update = sheet_from_fields([f for f in member.state_fields if f.key in keys], values)
            sheets[actor] = patch_sheet(sheets[actor], SheetPatch(**update.model_dump()))
        return story.model_copy(update={"card_values": changes, "sheets": sheets})

    def player(self, binding, story: Story) -> dict[str, object] | None:
        options = self.settings(binding)
        if options.playerMode == "director":
            return None
        return {"actor": PLAYER, "name": options.playerName, "persona": options.playerPersona,
                "sheet": story.sheets.get(PLAYER, CharacterSheet()).model_dump()}

    def prompt_head(self, binding) -> str:
        if self.actor:
            raw = binding.get_state("character")
            if raw is None:
                return "No character assignment is available. Do not invent one."
            material = character_material(CardFields.model_validate(raw))
            if note := (binding.get_state("castMember") or {}).get("initial_note"):
                material["initial_note"] = note
            return "Own character material (reference only): " + json.dumps(material, ensure_ascii=False)
        settings, members = self.settings(binding), self.members(binding)
        initial = set(settings.initialActors) if settings.initialActors else {member.actor for member in members}
        cast = {member.actor: cast_material(member) for member in members if member.actor in initial}
        player = None if settings.playerMode == "director" else {"actor": PLAYER, "name": settings.playerName, "persona": settings.playerPersona}
        player_instruction = ("Treat reader input as the protagonist's intent; do not decide the protagonist's choices for them. "
                              if settings.playerMode == "protagonist" else
                              "Treat reader input as direction for the story, not as actions or dialogue from a player character. ")
        choices_instruction = "Leave outcome.choices null and do not emit kt_roleplay.choices fences. "
        if settings.enableStoryChoices:
            direction = ("concrete protagonist actions or dialogue without deciding the protagonist's choice in prose"
                         if settings.playerMode == "protagonist" else "distinct director instructions about focus, conflict or pacing")
            choices_instruction = (f"When the reader can direct what happens next, use outcome.choices in rp_commit_scene: {CHOICE_SHAPE}. "
                                   f"Offer 3–4 genuinely distinct directions in the novel's language; text must contain {direction}. "
                                   "Use a short tag, concise label, and one-line summary. Keep outcome.prose pure narrative without fences. ")
        return (player_instruction + choices_instruction + "For state changes use sheet_updates; record witnessed facts, uncertain beliefs and impressions separately with memory_updates. "
                "Use card_updates for changes to declared card fields. Do not share private memories, sheets or matched worldbook entries wholesale with NPCs. "
                "When mounted, narrator guides the narrative camera and pacing; proseStyle overlays diction and literary texture without changing story facts or character intent. Neither is a character in the scene. "
                "Director static setup (reference data): " + json.dumps({"title": settings.title, "playerMode": settings.playerMode,
                    "player": player, "premise": settings.premise, "sheetHint": settings.sheetHint,
                    **settings.prose_reference(), "cast": cast}, ensure_ascii=False))

    def prompt_tail(self, binding) -> str:
        if self.actor:
            if binding.get_state("character") is None:
                return ""
            scene = binding.get_state("cueScene")
            instruction = ""
            if scene is not None and scene != binding.get_state("reportedScene"):
                instruction = (f"Report for scene {scene} once with rp_report_scene before ending this turn. "
                               "The current cue and supplied memory and sheet supersede earlier proposals for this scene.\n")
            return instruction + "Current character state (reference only): " + json.dumps({
                "memory": npc_memory(binding).model_dump(), "sheet": npc_sheet(binding).model_dump()}, ensure_ascii=False)
        story, settings = self.story(binding), self.settings(binding)
        members = self.members(binding)
        initial = set(settings.initialActors) if settings.initialActors else {member.actor for member in members}
        cast_state = {}
        for member in members:
            actor = member.actor
            entry = {"sheet": story.sheets[actor].model_dump(), "memory": actor_memory(story, actor).model_dump(),
                     "visible_status": story.visible_status.get(actor, {})}
            if member.state_fields:
                entry["card_state"] = model_fields(member.state_fields, story.card_values.get(actor, {}))
            cast_state[actor] = entry
        scene = story.pending
        phase = None if scene is None else {"number": scene.number, "ready": scene.cues.keys() == scene.reports.keys(),
                                           "reports": {actor: scene.reports[actor].model_dump() for actor in sorted(scene.reports)},
                                           "waiting": sorted(scene.cues.keys() - scene.reports.keys())}
        live = {"lastCompleted": story.completed, "pending": phase, "facts": story.facts, "castState": cast_state}
        if joined := {member.actor: cast_material(member) for member in members if member.actor not in initial}:
            live["joinedCast"] = joined
        if settings.playerMode != "director":
            live["playerSheet"] = story.sheets.get(PLAYER, CharacterSheet()).model_dump()
        return "Director live scene state (reference data): " + json.dumps(live, ensure_ascii=False)

    def view(self, binding) -> dict[str, object]:
        if binding is None or binding.session_store is None:
            return {"mode": "npc" if self.actor else "novel", "active": False}
        if self.actor:
            if (raw := binding.get_state("character")) is None:
                return {"mode": "npc", "active": False}
            member = binding.get_state("castMember") or {}
            fields = TypeAdapter(list[StateField]).validate_python(binding.get_state("fieldDefinitions") or [])
            selected = chosen_key(TypeAdapter(list[PortraitRule]).validate_python(member.get("portrait_rules", [])),
                                  fields, binding.get_state("fieldValues") or {})
            return {"mode": "npc", "active": True, "actor": binding.agent_name, "name": raw["name"],
                    "cardId": member.get("cardId", ""), "hasPortrait": bool(member.get("hasPortrait") or selected or member.get("customPortraitUrl")),
                    "portraitKey": selected, "customPortraitUrl": member.get("customPortraitUrl"),
                    "sheet": npc_sheet(binding).model_dump(), "memory": npc_memory(binding).model_dump(),
                    "cueScene": binding.get_state("cueScene"), "reportedScene": binding.get_state("reportedScene")}
        story, settings = self.story(binding), self.settings(binding)
        cast = []
        for member in self.members(binding):
            values = story.card_values.get(member.actor, {})
            selected = chosen_key(member.portrait_rules, member.state_fields, values)
            sheet = story.sheets[member.actor]
            cast.append({"actor": member.actor, "name": member.card.name, "cardId": member.cardId, "ephemeral": not member.cardId,
                         "hasPortrait": bool(member.hasPortrait or selected or member.customPortraitUrl), "portraitKey": selected,
                         "customPortraitUrl": member.customPortraitUrl, "visibleStatus": story.visible_status.get(member.actor, {}),
                         "stateFields": public_fields(member.state_fields, values), "sheet": filter_sheet(sheet, "public").model_dump(),
                         "privateSheet": filter_sheet(sheet, "private").model_dump(), "memory": actor_memory(story, member.actor).model_dump()})
        scene = story.pending
        context = binding.host_agent.executor._build_tool_context()
        return {"mode": "novel", "active": True, "title": settings.title, "playerMode": settings.playerMode,
                "rootCreatureId": context.creature_id, "rootName": binding.agent_name,
                "enableStoryChoices": settings.enableStoryChoices,
                "player": self.player(binding, story), "premise": settings.premise, "sheetHint": settings.sheetHint,
                "narrator": {"cardId": n.cardId, "name": n.name, "isDefault": n.isDefault,
                             "portraitUrl": DEFAULT_NARRATOR_PORTRAIT_URL if n.isDefault else None} if (n := settings.narrator) else None,
                "style": {"cardId": s.cardId, "name": s.name} if (s := settings.style) else None,
                "worldbooks": [{"id": row.id, "name": row.name, "entries": len(row.book.entries)} for row in self.worldbooks(binding)],
                "sceneNumber": story.completed, "pendingScene": {"number": scene.number, "waiting": sorted(scene.cues.keys() - scene.reports.keys()),
                    "reported": sorted(scene.reports)} if scene else None,
                "isProcessing": bool(binding.host_agent and binding.host_agent.is_processing), "cast": cast,
                "chapters": [chapter_view(chapter) for chapter in story_chapters(story)], "latestProse": split_choices(story.latest_prose)[0]}

    def tools(self, host):
        if self.actor:
            return [ReportScene()]
        from .cast_tools import CreateCast, ListLibraryCards, SpawnCast
        return [DispatchScene(host), CheckScene(host), CommitScene(host), ListLibraryCards(host), SpawnCast(host), CreateCast(host)]
