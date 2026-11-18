"""Scene tools narrow KT broadcasts to typed, per-character story exchanges."""

import json
from typing import Protocol

from pydantic import BaseModel, Field
from kohakuterrarium.modules.tool.base import BaseTool, ExecutionMode, ToolContext, ToolResult
from kohakuterrarium.terrarium.tools.context import resolve_group_context, resolve_group_target
from kohakuterrarium.terrarium.tools.send import SendChannelTool

from .novel import Cue, Outcome, Proposal, SceneError, Story, StoryModel, begin_scene, commit_scene, npc_input, receive_report


class SceneHost(Protocol):
    def watch_reports(self, context: ToolContext) -> None: ...
    def story(self) -> Story: ...
    def save_story(self, story: Story) -> None: ...
    def save_adjudication(self, context: ToolContext, story: Story, recipients: tuple[str, ...]) -> None: ...


class Dispatch(StoryModel):
    cues: dict[str, Cue]


class Report(StoryModel):
    scene: int = Field(gt=0)
    proposal: Proposal


class Commit(StoryModel):
    scene: int = Field(gt=0)
    outcome: Outcome


class Check(StoryModel):
    pass


class SceneTool(BaseTool):
    needs_context = True
    execution_mode = ExecutionMode.DIRECT
    arguments: type[BaseModel]

    def get_parameters_schema(self) -> dict:
        return self.arguments.model_json_schema()


async def send_story_message(context: ToolContext, channel: str, value: dict[str, object]) -> None:
    result = await SendChannelTool().execute({"channel": channel, "message": json.dumps(value, ensure_ascii=False)}, context)
    if not result.success:
        raise SceneError(result.error or f"KT failed to deliver to channel {channel}")


def _listeners(context: ToolContext, channel: str, allowed: set[str]) -> None:
    group = resolve_group_context(context, require_privileged=False)
    actual = {cid for cid, channels in group.graph.listen_edges.items() if channel in channels}
    if actual != allowed or channel not in group.graph.send_edges.get(group.caller.creature_id, set()):
        raise SceneError(f"Invalid story channel wiring for {channel}: verify sender and intended listeners")


def prepare_cue(context: ToolContext, group, story: Story, actor: str) -> dict[str, object]:
    target = resolve_group_target(group, actor)
    _listeners(context, actor, {group.caller.creature_id, target.creature_id})
    plugin = target.agent.plugins.get_plugin("roleplay")
    if plugin is None or plugin.binding is None or plugin.mode != "npc":
        raise SceneError(f"Missing NPC session binding for {actor!r}")
    cue = npc_input(story, actor)
    if plugin.binding.get_state("privateKnowledge") is not None:
        del cue["known"]
    return cue


class DispatchScene(SceneTool):
    tool_name = "rp_dispatch_scene"
    description = "Start a scene. Send a distinct sensory observation to each affected actor only. Return without drafting prose until required reports arrive."
    arguments = Dispatch

    def __init__(self, host: SceneHost):
        super().__init__()
        self.host = host

    async def _execute(self, args: dict, context: ToolContext) -> ToolResult:
        cues = Dispatch.model_validate(args).cues
        group = resolve_group_context(context)
        self.host.watch_reports(context)
        story = begin_scene(self.host.story(), cues)
        deliveries = {actor: prepare_cue(context, group, story, actor) for actor in cues}
        self.host.save_story(story)
        for actor, cue in deliveries.items():
            await send_story_message(context, actor, cue)
        return ToolResult(output=json.dumps({"scene": story.pending.number, "waiting": list(cues)}))


class ReportScene(SceneTool):
    tool_name = "rp_report_scene"
    description = "Report your own speech, attempted action and private reaction to the director for the scene number you received. Never claim the outcome."
    arguments = Report

    async def _execute(self, args: dict, context: ToolContext) -> ToolResult:
        report = Report.model_validate(args)
        group = resolve_group_context(context, require_privileged=False)
        root = resolve_group_target(group, "root")
        _listeners(context, "report_to_root", {root.creature_id})
        director = root.agent.plugins.get_plugin("roleplay")
        director.watch_reports(context)
        current = director.story()
        checked = receive_report(current, report.scene, group.caller.name, report.proposal)
        if checked is not current:
            await send_story_message(context, "report_to_root", report.model_dump())
        actor_plugin = group.caller.agent.plugins.get_plugin("roleplay")
        actor_plugin.binding.set_state("reportedScene", report.scene)
        return ToolResult(output="Report received. Do not report again or narrate the scene; finish this turn.")


def collect_reports(context: ToolContext, story: Story) -> Story:
    if story.pending is None:
        return story
    group = resolve_group_context(context)
    channel = context.environment.shared_channels.get("report_to_root")
    if channel is None:
        raise SceneError("The story report channel is missing")
    for message in tuple(channel.history):
        story = ingest_report(group, story, message)
    return story


def ingest_report(group, story: Story, message) -> Story:
    scene = story.pending
    if scene is None or message.sender not in scene.cues:
        return story
    if message.sender_id != resolve_group_target(group, message.sender).creature_id:
        return story
    report = Report.model_validate_json(message.content)
    if report.scene != scene.number:
        return story
    return receive_report(story, report.scene, message.sender, report.proposal)


class CheckScene(SceneTool):
    tool_name = "rp_scene_reports"
    description = "Read actual, sender-checked NPC reports for the current scene. Never invent missing reports."
    arguments = Check

    def __init__(self, host: SceneHost):
        super().__init__()
        self.host = host

    async def _execute(self, args: dict, context: ToolContext) -> ToolResult:
        Check.model_validate(args)
        story = collect_reports(context, self.host.story())
        self.host.save_story(story)
        return ToolResult(output=story.model_dump_json())


class CommitScene(SceneTool):
    tool_name = "rp_commit_scene"
    description = "Commit the director's authoritative outcome, character-specific observations, public status and final reader prose once all NPCs have reported."
    arguments = Commit

    def __init__(self, host: SceneHost):
        super().__init__()
        self.host = host

    async def _execute(self, args: dict, context: ToolContext) -> ToolResult:
        request = Commit.model_validate(args)
        story = collect_reports(context, self.host.story())
        committed = commit_scene(story, request.scene, request.outcome)
        self.host.save_adjudication(context, committed, tuple(request.outcome.private_updates))
        return ToolResult(output=request.outcome.prose)
