"""Session-scoped director state and pure novel transitions."""

import json
import re
from typing import Annotated, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from .card_state import FieldUpdate, StateField, Value

Key = Annotated[str, Field(min_length=1)]
Visibility = Literal["public", "private"]
PlayerMode = Literal["protagonist", "director"]
PLAYER = "__player__"
CHOICE_FENCE = re.compile(r"(?:^|\n)```kt_roleplay\.choices[^\S\n]*\n(.*?)\n```[^\S\n]*\s*\Z", re.DOTALL)


class StoryModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, allow_inf_nan=False)


class SheetMeter(StoryModel):
    key: Key
    label: str
    current: int | float
    max: int | float | None = None
    unit: str = ""
    visibility: Visibility = "public"


class SheetEntry(StoryModel):
    key: Key
    label: str
    value: str
    visibility: Visibility = "public"


class SheetList(StoryModel):
    key: Key
    label: str
    items: list[str]
    visibility: Visibility = "public"


class CharacterSheet(StoryModel):
    meters: list[SheetMeter] = Field(default_factory=list)
    entries: list[SheetEntry] = Field(default_factory=list)
    lists: list[SheetList] = Field(default_factory=list)


class SheetPatch(CharacterSheet):
    remove_keys: list[Key] = Field(default_factory=list)


class ActorMemory(StoryModel):
    impressions: dict[str, str] = Field(default_factory=dict)
    facts_witnessed: list[str] = Field(default_factory=list)
    beliefs: list[str] = Field(default_factory=list)
    summary: str = ""


class MemoryPatch(StoryModel):
    impressions: dict[str, str] = Field(default_factory=dict)
    add_facts: list[str] = Field(default_factory=list)
    add_beliefs: list[str] = Field(default_factory=list)
    clear_beliefs: list[str] = Field(default_factory=list)


class Chapter(StoryModel):
    number: int
    title: str = ""
    prose: str
    actors: list[str] = Field(default_factory=list)
    imageUrl: str | None = None
    imageCaption: str = ""
    choices: dict[str, object] | None = None


class Cue(StoryModel):
    observation: Key


class Proposal(StoryModel):
    speech: str
    attempted_action: str
    private_reaction: str


class Scene(StoryModel):
    number: int
    cues: dict[Key, Cue]
    reports: dict[Key, Proposal]
    attempt: str = ""


class Outcome(StoryModel):
    prose: Key
    title: str = ""
    actors: list[Key] = Field(default_factory=list)
    scene_image_key: str | None = None
    image_caption: str = ""
    facts: list[str] = Field(default_factory=list)
    private_updates: dict[Key, str] = Field(default_factory=dict, description="Private adjudications keyed by the affected actor ID.")
    visible_status: dict[Key, dict[str, str | int]] = Field(default_factory=dict)
    card_updates: dict[Key, list[FieldUpdate]] = Field(default_factory=dict, description="Declared field changes keyed by affected actor ID. Use absolute values.")
    sheet_updates: dict[Key, SheetPatch] = Field(default_factory=dict)
    memory_updates: dict[Key, MemoryPatch] = Field(default_factory=dict)


class Story(StoryModel):
    cast: list[Key]
    completed: int = 0
    latest_prose: str = ""
    facts: list[str] = Field(default_factory=list)
    knowledge: dict[Key, list[str]] = Field(default_factory=dict)
    visible_status: dict[Key, dict[str, str | int]] = Field(default_factory=dict)
    card_values: dict[Key, dict[str, Value]] = Field(default_factory=dict)
    sheets: dict[Key, CharacterSheet] = Field(default_factory=dict)
    memories: dict[Key, ActorMemory] = Field(default_factory=dict)
    chapters: list[Chapter] = Field(default_factory=list)
    playerMode: PlayerMode = "protagonist"
    pending: Scene | None = None


class SceneError(ValueError):
    """An action does not belong to the active scene or its cast."""


def split_choices(prose: str) -> tuple[str, dict[str, object] | None]:
    match = CHOICE_FENCE.search(prose)
    if match is None:
        return prose, None
    try:
        choices = json.loads(match[1])
    except ValueError:
        return prose, None
    if not isinstance(choices, dict) or not isinstance(choices.get("options"), list):
        return prose, None
    options = []
    for option in choices["options"]:
        if isinstance(option, str):
            label = text = option.strip()
        elif isinstance(option, dict):
            label = option.get("label") or option.get("text") or option.get("value")
            text = option.get("text") or option.get("value") or option.get("label")
        else:
            continue
        if isinstance(label, str) and isinstance(text, str) and label.strip() and text.strip() and not text.lstrip().startswith("/"):
            options.append({"label": label.strip(), "text": text.strip()})
    if not options:
        return prose, None
    prompt = choices.get("prompt", choices.get("question", ""))
    return prose[:match.start()].rstrip(), {"prompt": prompt.strip() if isinstance(prompt, str) else "", "options": options}


def chapter_view(chapter: Chapter) -> dict[str, object]:
    clean, choices = split_choices(chapter.prose)
    return {**chapter.model_dump(), "cleanProse": clean, "choices": chapter.choices or choices}


def story_chapters(story: Story) -> list[Chapter]:
    if story.chapters or not story.latest_prose:
        return story.chapters
    return [Chapter(number=story.completed, prose=story.latest_prose)]


def sheet_from_fields(fields: list[StateField], values: dict[str, Value]) -> CharacterSheet:
    meters, entries, lists = [], [], []
    for field in fields:
        common = {"key": field.key, "label": field.label, "visibility": field.visibility}
        value = values.get(field.key, field.initial)
        if field.type == "number":
            meters.append(SheetMeter(**common, current=value, max=field.max))
        elif field.type == "list":
            lists.append(SheetList(**common, items=value))
        else:
            entries.append(SheetEntry(**common, value=value))
    return CharacterSheet(meters=meters, entries=entries, lists=lists)


def filter_sheet(sheet: CharacterSheet, visibility: Visibility) -> CharacterSheet:
    return CharacterSheet(**{group: [item for item in getattr(sheet, group) if item.visibility == visibility]
                             for group in ("meters", "entries", "lists")})


def patch_sheet(sheet: CharacterSheet, patch: SheetPatch) -> CharacterSheet:
    groups = ("meters", "entries", "lists")
    upserts = {item.key: (group, item) for group in groups for item in getattr(patch, group)}
    entries = {item.key: (group, item) for group in groups for item in getattr(sheet, group)}
    entries.update(upserts)
    return CharacterSheet(**{group: [item for key, (kind, item) in entries.items()
                                    if kind == group and key not in patch.remove_keys] for group in groups})


def patch_memory(memory: ActorMemory, patch: MemoryPatch, legacy_fact: str) -> ActorMemory:
    facts = [*memory.facts_witnessed, *patch.add_facts, *([legacy_fact] if legacy_fact else [])]
    older = [" ".join(text.split())[:200] for text in facts[:-12]]
    summary = "\n".join(filter(None, [memory.summary, *older]))[-2000:]
    beliefs = list(dict.fromkeys([*(belief for belief in memory.beliefs if belief not in patch.clear_beliefs), *patch.add_beliefs]))
    return ActorMemory(impressions={**memory.impressions, **patch.impressions}, facts_witnessed=facts[-12:],
                       beliefs=beliefs, summary=summary)


def actor_memory(story: Story, actor: str) -> ActorMemory:
    if actor in story.memories:
        return story.memories[actor]
    return patch_memory(ActorMemory(), MemoryPatch(add_facts=story.knowledge.get(actor, [])), "")


def begin_scene(story: Story, cues: dict[str, Cue]) -> Story:
    if story.pending is not None:
        raise SceneError("Finish or cancel the active scene before starting another")
    if not cues:
        raise SceneError("A dispatched scene needs at least one cue; use direct commit otherwise")
    if set(cues).difference(story.cast):
        raise SceneError("A perspective was addressed to an unknown NPC")
    return story.model_copy(update={"pending": Scene(number=story.completed + 1, cues=cues, reports={}, attempt=uuid4().hex)})


def npc_input(story: Story, actor: str) -> dict[str, object]:
    scene = story.pending
    if scene is None or actor not in scene.cues:
        raise SceneError("This NPC has no observation in the active scene")
    return {"scene": scene.number, "attempt": scene.attempt, "actor": actor, "observation": scene.cues[actor].observation,
            "known": actor_memory(story, actor).facts_witnessed}


def receive_report(story: Story, number: int, sender: str, proposal: Proposal) -> Story:
    scene = story.pending
    if scene is None or scene.number != number or sender not in scene.cues:
        raise SceneError("NPC report is late or the sender was not invited to this scene")
    if sender in scene.reports:
        if scene.reports[sender] == proposal:
            return story
        raise SceneError("NPC submitted conflicting proposals for the same scene")
    changed = scene.model_copy(update={"reports": {**scene.reports, sender: proposal}})
    return story.model_copy(update={"pending": changed})


def commit_scene(story: Story, number: int, outcome: Outcome) -> Story:
    scene = story.pending
    if number != (scene.number if scene else story.completed + 1):
        raise SceneError("This scene is no longer active")
    if scene and (missing := scene.cues.keys() - scene.reports.keys()):
        raise SceneError("Missing required NPC reports: " + ", ".join(sorted(missing)))
    participants = set(story.cast)
    player = {PLAYER} if story.playerMode == "protagonist" else set()
    if set(outcome.actors) - (participants | player):
        raise SceneError("The chapter lists an unknown actor")
    affected = outcome.private_updates.keys() | outcome.visible_status.keys() | outcome.card_updates.keys() | outcome.memory_updates.keys()
    allowed = set(scene.cues) if scene else participants
    if affected - allowed or outcome.sheet_updates.keys() - (allowed | player):
        raise SceneError("A character outside this scene cannot acquire a new reaction or observation")
    memories, sheets = dict(story.memories), dict(story.sheets)
    for actor in outcome.private_updates.keys() | outcome.memory_updates.keys():
        memories[actor] = patch_memory(actor_memory(story, actor), outcome.memory_updates.get(actor, MemoryPatch()),
                                       outcome.private_updates.get(actor, ""))
    for actor, patch in outcome.sheet_updates.items():
        sheets[actor] = patch_sheet(sheets.get(actor, CharacterSheet()), patch)
    chapter = Chapter(number=number, title=outcome.title, prose=outcome.prose,
                      actors=outcome.actors or (list(scene.cues) if scene else []),
                      choices=split_choices(outcome.prose)[1], imageCaption=outcome.image_caption)
    return story.model_copy(update={"completed": number, "latest_prose": outcome.prose, "pending": None,
                                    "memories": memories, "sheets": sheets, "chapters": [*story_chapters(story), chapter],
                                    "facts": [*story.facts, *outcome.facts],
                                    "visible_status": {**story.visible_status, **outcome.visible_status}})
