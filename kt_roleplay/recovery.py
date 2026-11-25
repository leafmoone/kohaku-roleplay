"""Manually resume only unfinished work in an existing story scene."""

from kohakuterrarium.core.channel import AgentChannel
from kohakuterrarium.core.events import TriggerEvent
from kohakuterrarium.terrarium.tools.context import resolve_group_context

from .novel import SceneError
from .scene_tools import (
    collect_reports,
    ensure_actor_running,
    ensure_creature_running,
    prepare_cue,
    send_story_message,
)


async def resume_scene(plugin, number: int) -> None:
    binding = plugin.binding
    if binding is None or plugin.mode != "novel" or binding.host_agent is None:
        raise SceneError("Recovery requires a loaded novel director")
    root = binding.host_agent
    if root.is_processing or root.paused:
        raise SceneError("The director must be idle and unpaused before resuming a scene")
    context = root.executor._build_tool_context()
    group = resolve_group_context(context)
    current = plugin.story()
    if current.pending is None or current.pending.number != number:
        raise SceneError("This is not the current pending scene; refresh the session")
    await ensure_creature_running(group, group.caller, "Director")
    plugin.watch_reports(context)
    story = collect_reports(context, current)
    if story is not current:
        plugin.save_story(story)
    missing = [actor for actor in story.pending.cues if actor not in story.pending.reports]
    if not missing:
        await root.inject_event(TriggerEvent(type="roleplay_resume", content=f"Resume pending scene {number}. Use the existing reports to adjudicate; do not start a new scene."))
        return
    deliveries = {}
    for actor in missing:
        target = await ensure_actor_running(group, actor)
        channel = context.environment.shared_channels.get(actor)
        # The KT trigger subscribes as <creature>_<channel> on its first wait.
        if not target.agent.is_processing and (
            not isinstance(channel, AgentChannel) or channel.subscribe(f"{target.name}_{actor}").empty
        ):
            cue = prepare_cue(context, group, story, actor)
            deliveries[actor] = (cue, target.agent.plugins.get_plugin("roleplay").binding)
    if not deliveries:
        raise SceneError("The pending recipients are already processing; no cues were sent")
    for actor, (cue, recipient) in deliveries.items():
        # The director's ledger (including authenticated channel history) wins over
        # a stale local acknowledgement after restart; otherwise the report tool stays hidden.
        if recipient.get_state("reportedScene") == number:
            recipient.set_state("reportedScene", None)
        await send_story_message(context, actor, cue)
