"""Scene tools narrow KT broadcasts to typed, per-character story exchanges."""

import json
from asyncio import gather
from typing import Protocol

from kohakuterrarium.modules.tool.base import (
    BaseTool,
    ExecutionMode,
    ToolContext,
    ToolResult,
)
from kohakuterrarium.terrarium.tools.context import (
    compute_group,
    resolve_group_context,
    resolve_group_target,
)
from kohakuterrarium.terrarium.tools.send import SendChannelTool
from kohakuterrarium.utils.logging import get_logger
from pydantic import BaseModel, Field, ValidationError

from .novel import (
    Cue,
    Outcome,
    Proposal,
    SceneError,
    Story,
    StoryModel,
    begin_scene,
    commit_scene,
    npc_input,
    receive_report,
)

log = get_logger(__name__)


class SceneHost(Protocol):
    def watch_reports(self, context: ToolContext) -> None: ...
    def story(self) -> Story: ...
    def save_story(self, story: Story) -> None: ...
    def open_dispatched_scene(self, before: Story, story: Story) -> None: ...
    def require_open_scene(self) -> None: ...
    def save_adjudication(self, context: ToolContext, before: Story, story: Story, outcome: Outcome) -> None: ...


class Dispatch(StoryModel):
    cues: dict[str, Cue]


class Report(StoryModel):
    scene: int = Field(gt=0)
    proposal: Proposal


class ReportEnvelope(Report):
    attempt: str = ""


class Commit(StoryModel):
    scene: int = Field(gt=0)
    outcome: Outcome


class Check(StoryModel):
    pass


class SceneTool(BaseTool):
    needs_context = True
    is_concurrency_safe = False
    execution_mode = ExecutionMode.DIRECT
    arguments: type[BaseModel]

    def get_parameters_schema(self) -> dict:
        return self.arguments.model_json_schema()


def resolve_story_director(group):
    directors = [node for node in compute_group(group).values()
                 if node.is_privileged and (plugin := node.agent.plugins.get_plugin("roleplay")) is not None
                 and plugin.mode == "novel"]
    if len(directors) != 1:
        raise SceneError("The graph must contain one privileged novel director")
    return directors[0]


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
    if (plugin is None or plugin.binding is None or plugin.mode != "npc"
            or plugin.binding.session_store is not group.caller.agent.session_store):
        raise SceneError(f"Missing NPC session binding for {actor!r}")
    cue = npc_input(story, actor)
    if plugin.binding.get_state("privateKnowledge") is not None:
        del cue["known"]
    return cue


class DispatchScene(SceneTool):
    tool_name = "rp_dispatch_scene"
    description = ('Start one scene. Pass cues as an object keyed by actual cast IDs; each value is '
                   'an object {"observation": "..."}, not a string. Include only actors who can perceive '
                   'the event. End the turn without prose while waiting for their reports.')
    arguments = Dispatch

    def __init__(self, host: SceneHost):
        super().__init__()
        self.host = host

    async def _execute(self, args: dict, context: ToolContext) -> ToolResult:
        self.host.require_open_scene()
        cues = Dispatch.model_validate(args).cues
        group = resolve_group_context(context)
        self.host.watch_reports(context)
        before = self.host.story()
        story = begin_scene(before, cues)
        deliveries = {actor: prepare_cue(context, group, story, actor) for actor in cues}
        self.host.open_dispatched_scene(before, story)
        await gather(*(send_story_message(context, actor, cue) for actor, cue in deliveries.items()))
        return ToolResult(output=json.dumps({"scene": story.pending.number, "waiting": list(cues)}))


class ReportScene(SceneTool):
    tool_name = "rp_report_scene"
    description = ('Report your own proposal for the integer scene you received. Pass proposal as '
                   'an object, not a JSON-encoded string: {"speech": "...", "attempted_action": "...", '
                   '"private_reaction": "..."}. All three values are strings; use "" when absent. '
                   'Do not claim the outcome.')
    arguments = Report

    async def _execute(self, args: dict, context: ToolContext) -> ToolResult:
        report = Report.model_validate(args)
        group = resolve_group_context(context, require_privileged=False)
        root = resolve_story_director(group)
        _listeners(context, "report_to_root", {root.creature_id})
        director = root.agent.plugins.get_plugin("roleplay")
        director.watch_reports(context)
        current = director.story()
        actor_plugin = group.caller.agent.plugins.get_plugin("roleplay")
        attempt = actor_plugin.binding.get_state("cueAttempt") or ""
        if current.pending is None or current.pending.attempt != attempt:
            raise SceneError("This NPC proposal belongs to an inactive scene attempt")
        checked = receive_report(current, report.scene, group.caller.name, report.proposal)
        if checked is not current:
            await send_story_message(context, "report_to_root", {**report.model_dump(), "attempt": attempt})
        actor_plugin.binding.set_state("reportedScene", report.scene)
        actor_plugin.ui_emit("state", actor_plugin.ui_state())
        return ToolResult(output=f"Your report for scene {report.scene} was received. Finish this turn; report again only for a new scene.")


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
    if message.sender in scene.reports:
        return story
    try:
        report = ReportEnvelope.model_validate_json(message.content)
    except ValidationError:
        log.warning("Ignored malformed novel report", actor=message.sender, scene=scene.number)
        return story
    if report.scene != scene.number or report.attempt != scene.attempt:
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
    description = ('Commit directly when no proposals are needed, or adjudicate once all reports are in. Pass scene as an integer and outcome as an '
                   'object containing {"prose": "..."}, not the prose string itself. Include changed '
                   'facts, memory_updates, sheet_updates, visible_status or card_updates in outcome when applicable. '
                   'Keep character-private information out of reader prose.')
    arguments = Commit

    def __init__(self, host: SceneHost):
        super().__init__()
        self.host = host

    async def _execute(self, args: dict, context: ToolContext) -> ToolResult:
        request = Commit.model_validate(args)
        story = collect_reports(context, self.host.story())
        if story.pending is None:
            self.host.require_open_scene()
        committed = commit_scene(story, request.scene, request.outcome)
        self.host.save_adjudication(context, story, committed, request.outcome)
        return ToolResult(output=request.outcome.prose)
