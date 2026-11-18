"""Adjudicate NPC proposals for one linear, session-owned story."""

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field


Key = Annotated[str, Field(min_length=1)]


class StoryModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


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


class Outcome(StoryModel):
    prose: Key
    facts: list[str]
    private_updates: dict[Key, str]
    visible_status: dict[Key, dict[str, str | int]]


class Story(StoryModel):
    cast: list[Key]
    completed: int = 0
    latest_prose: str = ""
    facts: list[str] = Field(default_factory=list)
    knowledge: dict[Key, list[str]] = Field(default_factory=dict)
    visible_status: dict[Key, dict[str, str | int]] = Field(default_factory=dict)
    pending: Scene | None = None


class SceneError(ValueError):
    """An action does not belong to the active scene or its cast."""


def begin_scene(story: Story, cues: dict[str, Cue]) -> Story:
    if story.pending is not None:
        raise SceneError("Finish or cancel the active scene before starting another")
    if set(cues).difference(story.cast):
        raise SceneError("A perspective was addressed to an unknown NPC")
    return story.model_copy(update={"pending": Scene(number=story.completed + 1, cues=cues, reports={})})


def npc_input(story: Story, actor: str) -> dict[str, object]:
    scene = story.pending
    if scene is None or actor not in scene.cues:
        raise SceneError("This NPC has no observation in the active scene")
    return {"scene": scene.number, "actor": actor, "observation": scene.cues[actor].observation, "known": list(story.knowledge.get(actor, []))}


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
    if scene is None or scene.number != number:
        raise SceneError("This scene is no longer active")
    missing = set(scene.cues).difference(scene.reports)
    if missing:
        raise SceneError("Missing required NPC reports: " + ", ".join(sorted(missing)))
    affected = set(outcome.private_updates) | set(outcome.visible_status)
    if affected.difference(scene.cues):
        raise SceneError("A character outside this scene cannot acquire a new reaction or observation")
    knowledge = {**story.knowledge, **{actor: [*story.knowledge.get(actor, []), text] for actor, text in outcome.private_updates.items()}}
    return story.model_copy(update={"completed": number, "latest_prose": outcome.prose, "pending": None, "knowledge": knowledge, "facts": [*story.facts, *outcome.facts], "visible_status": {**story.visible_status, **outcome.visible_status}})
