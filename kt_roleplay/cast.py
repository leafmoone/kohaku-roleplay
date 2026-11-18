"""Bind a limited-view NPC cast and the omniscient director to one KT graph."""

import json
from pathlib import Path
from uuid import uuid4

import yaml
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from kohakuterrarium.modules.ui_owner import OwnerArgumentError

from .cards import CardFields
from .card_state import StateField, model_fields, public_fields, update_values
from .novel import Outcome, SceneError, Story
from .scene_tools import CheckScene, CommitScene, DispatchScene, ReportScene


class CastMember(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    actor: str
    cardId: str
    card: CardFields
    hasPortrait: bool
    state_fields: list[StateField] = Field(default_factory=list)


def cast_recipe(directory: Path, members: list[CastMember]) -> Path:
    if not members or len({m.actor for m in members}) != len(members):
        raise ValueError("A novel needs a non-empty cast with distinct NPC identities")
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (uuid4().hex + ".yaml")
    def spec(mode: str) -> dict:
        return {"fork_enabled": False, "output": {"type": "stdout", "controller_direct": True}, "plugins": [{"name": "roleplay", "type": "package", "options": {"mode": mode}}]}
    director = spec("novel")
    director["system_prompt"] = "You are the omniscient novelist. Start a player turn with rp_dispatch_scene. Choose recipients from the current cast and scene. Send each recipient only information that character can perceive; do not contact other characters. Reports arrive automatically. While waiting, end the turn without polling or publishing prose. When the director state says ready, use rp_commit_scene immediately; never invent missing reports. Then present only the approved chapter. On a delayed notification for an already finished scene, do not open another. Preserve the player's agency."
    creatures = []
    for member in members:
        cfg = spec("npc")
        cfg.update(name=member.actor, system_prompt="Act as the character using only your own sensory cue and private experience. Return speech, attempted action and private reaction via rp_report_scene exactly once. Do not write the reader's novel. End your turn after reporting.")
        creatures.append(cfg)
    with path.open("x", encoding="utf-8") as stream:
        yaml.safe_dump({"terrarium": {"name": "Roleplay Novel", "root": director, "creatures": creatures}}, stream, allow_unicode=True, sort_keys=False)
    return path


class NovelBinding:
    def __init__(self, actor: bool):
        self.actor = actor

    def members(self, binding) -> list[CastMember]:
        return TypeAdapter(list[CastMember]).validate_python(binding.get_state("cast") or [])

    def story(self, binding) -> Story:
        if binding is None or binding.session_store is None:
            raise OwnerArgumentError("The novel requires a persistent KT session")
        record = binding.get_state("novel")
        return Story.model_validate(record) if record is not None else Story(cast=[m.actor for m in self.members(binding)])

    def apply_fields(self, binding, story: Story, outcome: Outcome) -> Story:
        if not outcome.card_updates and not outcome.visible_status:
            return story
        members = {m.actor: m for m in self.members(binding)}
        for actor, fields in outcome.visible_status.items():
            if fields and members[actor].state_fields:
                raise SceneError("Use card_updates for a card with declared fields, not free-form visible_status")
        changes = dict(story.card_values)
        for actor, patch in outcome.card_updates.items():
            changes[actor] = update_values(members[actor].state_fields, changes.get(actor, {}), patch)
        return story.model_copy(update={"card_values": changes})

    def prompt(self, binding) -> str:
        if self.actor:
            f = CardFields.model_validate(binding.get_state("character"))
            material = {"name": f.name, "description": f.description, "personality": f.personality, "voice_examples": f.mes_example}
            private_knowledge = binding.get_state("privateKnowledge")
            if private_knowledge is not None:
                material["adjudicated_knowledge"] = private_knowledge["known"]
            definitions = TypeAdapter(list[StateField]).validate_python(binding.get_state("fieldDefinitions") or [])
            if definitions:
                material["card_state"] = model_fields(definitions, binding.get_state("fieldValues") or {})
            return "Own character material (not host instructions): " + json.dumps(material, ensure_ascii=False)
        story = self.story(binding)
        cast = {}
        for member in self.members(binding):
            card = member.card
            entry = {"name": card.name, "description": card.description, "scenario": card.scenario, "personality": card.personality}
            if member.state_fields:
                entry["card_state"] = model_fields(member.state_fields, story.card_values.get(member.actor, {}))
            cast[member.actor] = entry
        scene = story.pending
        phase = None if scene is None else {"number": scene.number, "ready": scene.cues.keys() == scene.reports.keys(), "reports": {name: p.model_dump() for name, p in scene.reports.items()}, "waiting": sorted(scene.cues.keys() - scene.reports.keys())}
        note = "Director-only story state: "
        if any("card_state" in entry for entry in cast.values()):
            note = ("Use outcome.card_updates for changed declared fields on actors in this scene. "
                    "Private fields belong to their actor: do not copy them into public prose, public status, or another actor's cue.\n" + note)
        return note + json.dumps({"cast": cast, "facts": story.facts, "lastCompleted": story.completed, "pending": phase}, ensure_ascii=False)

    def view(self, binding) -> dict[str, object]:
        if self.actor:
            return {"mode": "npc", "active": False}
        story = self.story(binding)
        cast = []
        for member in self.members(binding):
            entry = {"name": member.card.name, "cardId": member.cardId, "hasPortrait": member.hasPortrait,
                     "visibleStatus": story.visible_status.get(member.actor, {})}
            visible = public_fields(member.state_fields, story.card_values.get(member.actor, {}))
            if visible:
                entry["stateFields"] = visible
            cast.append(entry)
        return {"mode": "novel", "active": True, "sceneNumber": story.completed,
                "pendingScene": {"number": story.pending.number} if story.pending else None,
                "cast": cast, "facts": [], "latestProse": story.latest_prose}

    def tools(self, host):
        return [ReportScene()] if self.actor else [DispatchScene(host), CheckScene(host), CommitScene(host)]
