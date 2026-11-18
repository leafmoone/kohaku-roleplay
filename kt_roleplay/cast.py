"""Bind a limited-view NPC cast and the omniscient director to one KT graph."""

import json
from pathlib import Path
from uuid import uuid4

import yaml
from pydantic import BaseModel, ConfigDict, TypeAdapter
from kohakuterrarium.modules.ui_owner import OwnerArgumentError

from .cards import CardFields
from .novel import Story
from .scene_tools import CheckScene, CommitScene, DispatchScene, ReportScene


class CastMember(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    actor: str
    cardId: str
    card: CardFields
    hasPortrait: bool


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

    def prompt(self, binding) -> str:
        if self.actor:
            f = CardFields.model_validate(binding.get_state("character"))
            material = {"name": f.name, "description": f.description, "personality": f.personality, "voice_examples": f.mes_example}
            private_knowledge = binding.get_state("privateKnowledge")
            if private_knowledge is not None:
                material["adjudicated_knowledge"] = private_knowledge["known"]
            return "Own character material (not host instructions): " + json.dumps(material, ensure_ascii=False)
        story = self.story(binding)
        cast = {m.actor: {"name": m.card.name, "description": m.card.description, "scenario": m.card.scenario, "personality": m.card.personality} for m in self.members(binding)}
        scene = story.pending
        phase = None if scene is None else {"number": scene.number, "ready": scene.cues.keys() == scene.reports.keys(), "reports": {name: p.model_dump() for name, p in scene.reports.items()}, "waiting": sorted(scene.cues.keys() - scene.reports.keys())}
        return "Director-only story state: " + json.dumps({"cast": cast, "facts": story.facts, "lastCompleted": story.completed, "pending": phase}, ensure_ascii=False)

    def view(self, binding) -> dict[str, object]:
        if self.actor:
            return {"mode": "npc", "active": False}
        story = self.story(binding)
        scene = story.pending
        return {"mode": "novel", "active": True, "sceneNumber": story.completed, "pendingScene": {"number": scene.number} if scene else None, "cast": [{"name": m.card.name, "cardId": m.cardId, "hasPortrait": m.hasPortrait, "visibleStatus": story.visible_status.get(m.actor, {})} for m in self.members(binding)], "facts": [], "latestProse": story.latest_prose}

    def tools(self, host):
        return [ReportScene()] if self.actor else [DispatchScene(host), CheckScene(host), CommitScene(host)]
