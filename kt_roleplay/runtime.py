"""Bind confirmed character data to a live KT creature without mutating its config."""

import json
import logging
from asyncio import current_task, to_thread
from collections.abc import Callable
from typing import Literal
from uuid import uuid4

from kohakuterrarium.builtins.plugins.ui_declarative.plugin import attached_renderers
from kohakuterrarium.core.conversation.elide import (
    TOOL_FEEDBACK_KIND,
    estimate_message_tokens,
)
from kohakuterrarium.core.events import TriggerEvent
from kohakuterrarium.llm.message import ImagePart, UserMessage
from kohakuterrarium.modules.output.event import OutputEvent
from kohakuterrarium.modules.plugin.base import (
    BasePlugin,
    PluginBlockError,
    PluginContext,
    ToolVisibility,
)
from kohakuterrarium.modules.tool.base import ToolContext
from kohakuterrarium.modules.ui_owner import OwnerArgumentError, OwnerForbiddenError
from kohakuterrarium.parsing import is_action_event, parse_full
from kohakuterrarium.terrarium.tools.context import (
    resolve_group_context,
    resolve_group_target,
)
from pydantic import Field, JsonValue, TypeAdapter, ValidationError

from .card_scripts import script_fingerprint, visible_script_buttons
from .card_state import FieldUpdate, model_fields, public_fields
from .cards import CardError
from .cast import NovelBinding
from .errors import SettlementRejected
from .gameplay import Action, PlayActions, apply_actions, apply_field_changes
from .gameplay_pack import (
    GameplayPackUnavailable,
    pack_settings,
    pack_tools,
    tavern_creature,
)
from .header_summary import MAX_HEADER_PINS, header_summary
from .legacy_plugins import (
    LegacyPluginError,
    LegacyRequest,
    LegacySelection,
    configured_plugins,
    request_plugin,
)
from .legacy_web import (
    LegacyReplyCapture,
    LegacyReplyState,
    OpeningCounterWrite,
    legacy_web_message,
    mvu_reply_has_body,
    selected_message_values,
)
from .library import CardNotFound, get_card
from .library_view import (
    card_detail,
    cards_view,
    media_summary,
    media_view,
    portrait_view,
)
from .lore import active_entries
from .lore_regex import MatchBudget
from .lore_templates import render_templates
from .lore_timing import LoreTiming
from .module_linker import RETRYABLE_MODULE_ISSUES, link_card_scripts
from .mvu import MvuChange, public_options, public_values
from .mvu_patch import json_equal
from .mvu_settlement import settle_mvu_candidate
from .mvu_tool import ApplyMvuUpdate, UpdateMvu
from .novel import (
    CHOICE_SHAPE,
    ChoicePrompt,
    Outcome,
    SceneError,
    Story,
    StoryChoicesToggle,
    actor_memory,
    format_choice_fence,
)
from .novel_lore import novel_lore
from .novel_media import materialize_image, media_pool
from .novel_reader import READER_ACTIONS, call_reader
from .novel_revision import (
    BASELINE,
    PLAYER_INPUT,
    active_revision,
    canonical_chapters,
    committed_revision,
    revision_view,
)
from .opening_mvu_schema import (
    OpeningSchemaSnapshot,
    derive_opening_schema,
    with_opening_schema_output,
)
from .panels import ChoicePanel, InventoryPanel, QuestPanel, public_panels
from .paths import library_dir
from .pinned_mvu import calculate_pinned_mvu
from .pinned_mvu_setup import (
    SETUP_MARKER,
    MvuSetupWrite,
    setup_preserved,
    setup_projection,
    setup_update,
)
from .portraits import chosen_key
from .projections import (
    Persona,
    insert_roleplay_context,
    insert_tail_context,
    mount_persona,
    render_tavern_text,
    tavern_dynamic_context,
    tavern_lore_context,
    tavern_outlets,
    tavern_static_context,
)
from .recovery import resume_scene
from .scene_tools import ingest_report, resolve_story_director
from .script_session import (
    ScriptSession,
    approved,
    upgrade_button_receipts,
    upgrade_script_clock,
)
from .script_tool import CardScriptError, RunCardScript
from .state_tool import SetCardState
from .tavern_media import (
    attach_scene_image,
    save_scene_image,
    scene_image,
    without_scene_images,
)
from .tavern_opening import (
    SCRIPT_CLOCK_UNAVAILABLE,
    WorldbookSnapshot,
    card_scripts_unavailable,
    prepare_tavern_opening,
)
from .tavern_state import Arguments, Play, TavernSession
from .tavern_web import WEB_ACTIONS, call_web_panel, pinned_status_view
from .worldbook import TEMPLATE_BOOK_BUDGET, read_worldbook
from .worldbook_library import WorldbookNotFound, snapshot_detail, worldbook_for_play

logger = logging.getLogger(__name__)


class Attach(Arguments):
    cardId: str
    persona: Persona


class Notes(Arguments):
    notes: str


class MvuSelection(Arguments):
    ids: list[str] = Field(max_length=128)


class PanelSelection(Arguments):
    panelId: str
    index: int = Field(ge=0)


def _text(message: dict[str, object]) -> str:
    body = message.get("content")
    if isinstance(body, str):
        return body
    if isinstance(body, list):
        return "\n".join(p["text"] for p in body if isinstance(p, dict) and p.get("type") == "text" and isinstance(p.get("text"), str))
    return ""


def _cost(text: str) -> int:
    return estimate_message_tokens(UserMessage(text))


class RoleplayPlugin(BasePlugin):
    """Creature-owned persona overlay or session-owned tavern play."""

    name = "roleplay"
    prompt_renderers = frozenset({"kt_roleplay.choices"})

    def __init__(self, **options: object) -> None:
        super().__init__()
        mode = options.get("mode", "persona")
        self.mode = TypeAdapter(Literal["persona", "tavern", "novel", "npc"]).validate_python(mode)
        self.novel = NovelBinding(self.mode == "npc") if self.mode in ("novel", "npc") else None
        self.binding: PluginContext | None = None
        self._scripts = ScriptSession(self)
        self._web_panel_scope = ''
        self._legacy_reply_capture: LegacyReplyCapture | None = None
        self.report_watch = None
        self.can_open_scene = False
        self._scene_feedback: tuple[str, str] | None = None
        self._committed_prose: str | None = None
        self._committed_choices: ChoicePrompt | None = None
        self._committed_image: ImagePart | None = None
        self._restore_feedback: Callable[[], None] | None = None

    async def on_load(self, context: PluginContext) -> None:
        self.binding = context
        self._web_panel_scope = uuid4().hex if self.mode == 'tavern' else ''
        agent = context.host_agent
        if self.mode == 'tavern' and agent is not None:
            self._legacy_reply_capture = LegacyReplyCapture(self._capture_legacy_reply)
            agent.output_router.add_secondary(self._legacy_reply_capture)
        if self.mode not in ("novel", "npc") or agent is None:
            return
        original = agent._collect_and_push_feedback

        async def finish_feedback(controller, handles, handle_order, native_tool_call_ids, native_mode) -> bool:
            # KT 2.2.2 appends native results before draining input and queuing
            # feedback. Keep that settlement; defer queued player turns only
            # when a successful scene tool ends the model continuation.
            drain, push = agent._drain_mid_turn_pending_inputs, controller.push_event
            owner = current_task()
            settled = False
            withheld = False

            async def drain_input(active_controller) -> int:
                nonlocal settled
                marker = self._scene_feedback
                if self._committed_prose is not None:
                    marker = ("rp_commit_scene", self._committed_prose)
                if (current_task() is owner and active_controller is context.controller and marker is not None and handles
                        and (not native_mode or self._has_tool_result(controller.conversation.get_messages(), native_tool_call_ids.values(), *marker))):
                    settled = True
                    return 0
                return await drain(active_controller)

            async def push_feedback(event: TriggerEvent) -> None:
                nonlocal withheld
                if current_task() is owner and settled and event.type == "tool_complete":
                    withheld = True
                else:
                    await push(event)

            agent._drain_mid_turn_pending_inputs = drain_input
            controller.push_event = push_feedback
            try:
                again = await original(controller, handles, handle_order, native_tool_call_ids, native_mode)
            finally:
                agent._drain_mid_turn_pending_inputs = drain
                controller.push_event = push
            self._scene_feedback = None
            if not withheld:
                return again
            if self._committed_prose is not None:
                choices = self._committed_choices
                chat_text = self._committed_prose
                if choices and "kt_roleplay.choices" in attached_renderers(agent) and self.novel.settings(self.binding).enableStoryChoices:
                    chat_text += "\n\n" + format_choice_fence(choices)
                await self._publish_assistant(controller, chat_text, image=self._committed_image)
                self._committed_prose = None
                self._committed_choices = None
                self._committed_image = None
            return False

        def restore() -> None:
            if agent._collect_and_push_feedback is finish_feedback:
                agent._collect_and_push_feedback = original

        agent._collect_and_push_feedback = finish_feedback
        self._restore_feedback = restore

    def mark_scene_feedback(self, tool_name: str, output: str) -> None:
        self._scene_feedback = (tool_name, output)

    @staticmethod
    def _has_tool_result(messages, current_ids, tool_name: str, expected_output: str) -> bool:
        """Match the native result to the current assistant tool announcement."""
        result_ids = set()
        for message in reversed(messages):
            if message.role == "assistant":
                return any(
                    call["id"] in result_ids and call["function"]["name"] == tool_name
                    for call in message.tool_calls or ()
                )
            if message.role == "tool" and message.tool_call_id in current_ids and message.get_text_content() == expected_output:
                result_ids.add(message.tool_call_id)
        return False

    async def on_event(self, event) -> None:
        if self.mode == "tavern" and event.type == "user_input" and not (event.context or {}).get("rerun"):
            # The host journals a fresh turn before this hook. Migrate old receipts
            # through its predecessor, not through the new input being processed.
            self._upgrade_saved_script_clock(before_current=True)
        if ((self.mode == "novel" and event.type in ("user_input", "roleplay_opening", "roleplay_resume"))
                or (self.mode == "npc" and event.type == "channel_message")):
            self._scene_feedback = None
        if self.mode == "novel" and event.type == "user_input" and self.binding and self.binding.session_store is not None:
            self.can_open_scene = self.story().pending is None
            if self.can_open_scene and active_revision(self.binding) is None:
                self.binding.set_state(PLAYER_INPUT, _text({"content": event.content}))
            # Never apply an interrupted continuation to a new player turn.
            self._committed_prose = None
            self._committed_choices = None
            self._committed_image = None
        if self.mode == "npc" and event.type == "channel_message" and self.binding is not None:
            raw = event.context.get("raw_content")
            if event.context.get("channel") == self.binding.agent_name and isinstance(raw, str):
                group = resolve_group_context(self.binding.host_agent.executor._build_tool_context(), require_privileged=False)
                channel = group.engine.channel(group.caller.graph_id, self.binding.agent_name)
                message_id = event.context.get("message_id")
                director = resolve_story_director(group)
                sender_id = director.creature_id
                # ChannelTrigger exposes the message ID, but not the stable sender ID.
                if channel is None or not any(message.message_id == message_id and message.sender_id == sender_id
                                              and message.content == raw for message in reversed(channel.history)):
                    return
                try:
                    incoming = json.loads(raw)
                except ValueError:
                    logger.warning("Ignored malformed novel cue for %s", self.binding.agent_name)
                    return
                plugin = director.agent.plugins.get_plugin("roleplay")
                scene = plugin.story().pending if plugin and plugin.mode == "novel" else None
                if (scene is not None and isinstance(incoming, dict) and incoming.get("actor") == self.binding.agent_name
                        and incoming.get("scene") == scene.number and incoming.get("attempt", "") == scene.attempt):
                    self.binding.set_state("cueScene", scene.number)
                    self.binding.set_state("cueAttempt", scene.attempt)
                    self.ui_emit("state", self.ui_state())

    def watch_reports(self, context) -> None:
        group = resolve_group_context(context, require_privileged=False)
        if not self.binding or resolve_story_director(group).agent is not self.binding.host_agent:
            raise ValueError("Reports must be collected by this graph's director")
        channel = context.environment.shared_channels.get("report_to_root")
        if channel is None:
            raise ValueError("Director has no report channel")
        if self.report_watch and self.report_watch[0] is channel:
            return
        self._unwatch_reports()
        def accept(channel_name, message):
            old = self.story()
            story = ingest_report(group, old, message)
            if story is not old:
                self.save_story(story)
        channel.on_send(accept)
        self.report_watch = (channel, accept)

    def _unwatch_reports(self) -> None:
        if self.report_watch:
            channel, callback = self.report_watch
            channel.remove_on_send(callback)
            self.report_watch = None

    async def on_agent_start(self) -> None:
        self._upgrade_saved_script_clock()

    def _upgrade_saved_script_clock(self, *, before_current: bool = False) -> None:
        if self.mode != "tavern" or self.binding is None or self.binding.session_store is None:
            return
        record = self._record()
        raw = (record or {}).get("script_state")
        turn = self._script_turn_index()
        if not raw or raw.get("clock") == "turn" or turn is None or turn < 1:
            return
        play = TavernSession.model_validate(record)
        state = upgrade_script_clock(play.script_state, turn - int(before_current))
        self._save(play.model_copy(update={"script_state": state}).model_dump())

    def _capture_legacy_reply(self, text: str) -> None:
        agent = self.binding.host_agent if self.binding else None
        turn = self._script_turn_index()
        if agent is None or not agent.is_processing or turn is None or turn == 0:
            return
        record = self._record()
        if not record or not record.get('web_panel_ready', True) or not (opening := record.get('legacy_opening_web')):
            return
        marked = opening['marker'] in text
        if not marked and not opening.get('mvu_status_adapter'):
            return
        play = TavernSession.model_validate(record)
        if not marked and (not mvu_reply_has_body(text) or not play.mvu or not play.mvu.values
                           or not approved(play.scripts, play.script_state)):
            return
        reply = LegacyReplyState(turn=turn, text=text, values=play.mvu.values if play.mvu else {})
        if reply != play.legacy_reply_web:
            self._save(play.model_copy(update={'legacy_reply_web': reply}).model_dump())
            self.ui_emit('state', self.ui_state())

    async def on_unload(self) -> None:
        if self._legacy_reply_capture is not None:
            self._legacy_reply_capture.detach()
            if self.binding and self.binding.host_agent:
                self.binding.host_agent.output_router.remove_secondary(self._legacy_reply_capture)
            self._legacy_reply_capture = None
        self._web_panel_scope = ''
        self._unwatch_reports()
        if self._restore_feedback is not None:
            self._restore_feedback()
            self._restore_feedback = None

    def presentation_contribution(self, context: PluginContext) -> str | None:
        if self.mode != "tavern" or not (self._record() or {}).get("enableStoryChoices", True):
            return None
        if "kt_roleplay.choices" not in attached_renderers(context.host_agent):
            return None
        return ("At the end of each completed narrative reply where the player can act next (not during tool-only steps), "
                f"append one closed ```kt_roleplay.choices JSON fence in the scene's language: {CHOICE_SHAPE}. "
                "Offer 3–4 genuinely distinct directions with a short tag, concise label and one-line summary. "
                "In text, use a concrete action or speech from {{user}}'s perspective, never a slash command. "
                "Do not choose or act for {{user}} in the prose. Free text remains available.")

    def get_tool_visibility(self, context: PluginContext) -> ToolVisibility | None:
        if self.mode == "tavern":
            record = self._record()
            allowed = {"rp_set_card_state"} if record and record.get("state_fields") else set()
            if record and record.get('gameplay_pack'):
                allowed.update(pack_tools(record, context.host_agent))
            if record and (record.get("mvu") or {}).get("values"):
                if not record.get('pinned_mvu'):
                    allowed.add("rp_update_mvu")
                if record.get("mvu_legacy"):
                    allowed.add("rp_apply_mvu_update")
            if record and any(p.get("type") in ("inventory", "quest") for p in record.get("native_panels", [])):
                allowed.add("rp_apply_gameplay")
            if record and (record.get("script_state") or {}).get("approved") and (record.get("mvu") or {}).get("values"):
                play = TavernSession.model_validate(record)
                if self._script_turn_index() is not None and approved(play.scripts, play.script_state):
                    allowed.add("rp_run_card_script")
            return ToolVisibility(allowed_tools=frozenset(allowed), allowed_subagents=frozenset())
        if self.novel is None:
            return None
        allowed = frozenset()
        if self.binding and self.binding.session_store is not None:
            if self.mode == "npc":
                cue = self.binding.get_state("cueScene")
                if cue is not None and cue != self.binding.get_state("reportedScene"):
                    allowed = frozenset({"rp_report_scene"})
            else:
                scene = self.story().pending
                if scene is None and self.can_open_scene:
                    rewrite = active_revision(self.binding)
                    allowed = frozenset({"rp_commit_scene"})
                    if rewrite is None:
                        allowed |= {"rp_dispatch_scene", "rp_list_library_cards", "rp_spawn_cast_from_card", "rp_create_cast_character"}
                    elif rewrite.mode == "full_rerun":
                        allowed |= {"rp_dispatch_scene"}
                elif scene is not None and scene.cues.keys() == scene.reports.keys():
                    allowed = frozenset({"rp_commit_scene"})
        return ToolVisibility(allowed_tools=allowed, allowed_subagents=frozenset())

    async def pre_tool_dispatch(self, call, context: PluginContext):
        visibility = self.get_tool_visibility(context)
        if visibility is not None and call.name not in visibility.allowed_tools:
            raise PluginBlockError(f"Tool {call.name!r} is unavailable to the {self.mode} narrator")

    async def pre_subagent_run(self, task: str, **kwargs: object) -> None:
        if self.mode != "persona":
            raise PluginBlockError("Story creatures may not delegate outside their own perspective")

    def contribute_tools(self):
        if self.mode == "tavern":
            return [SetCardState(self), UpdateMvu(self), ApplyMvuUpdate(self), PlayActions(self), RunCardScript(self)]
        return self.novel.tools(self) if self.novel else []

    def gameplay_settings(self, package: str) -> dict[str, JsonValue] | None:
        return pack_settings(self._record(), package) if self.mode == 'tavern' else None

    def script_record(self) -> tuple[dict, TavernSession]:
        if self.mode != "tavern" or (record := self._record()) is None:
            raise CardScriptError("Card scripts are only available in an active tavern")
        if self._script_turn_index() is None:
            raise CardScriptError(SCRIPT_CLOCK_UNAVAILABLE)
        return record, TavernSession.model_validate(record)

    async def invoke_card_script(self, script_id: str, args: JsonValue) -> None:
        await self._scripts.fire("tool", script_id=script_id, args=args)

    def apply_card_changes(self, changes: list[FieldUpdate]) -> None:
        if self.mode != "tavern" or self._record() is None:
            raise SceneError("Bind a card in a tavern session before changing state")
        play = TavernSession.model_validate(self._record())
        try:
            values = apply_field_changes(play.native_panels, play.state_fields, play.values, changes)
        except ValueError as exc:
            raise SettlementRejected(str(exc)) from exc
        self._save(play.model_copy(update={"values": values}).model_dump())
        self.ui_emit("state", self.ui_state())

    def apply_gameplay_actions(self, actions: list[Action]) -> None:
        if self.mode != "tavern" or (record := self._record()) is None:
            raise SceneError("Bind a tavern card before applying a gameplay action")
        play = TavernSession.model_validate(record)
        try:
            values = apply_actions(play.native_panels, play.state_fields, play.values, actions)
        except ValueError as exc:
            raise SettlementRejected(str(exc)) from exc
        self._save(play.model_copy(update={"values": values}).model_dump())
        self.ui_emit("state", self.ui_state())

    async def apply_mvu_changes(self, changes: list[MvuChange]) -> bool:
        return await self._update_mvu(changes)

    async def apply_mvu_legacy(self, update: str) -> bool:
        return await self._update_mvu(update)

    async def _update_mvu(self, update: str | list[MvuChange]) -> bool:
        async with self._scripts.lock:
            return await self._settle_mvu(update)

    async def _settle_mvu(self, update: str | list[MvuChange]) -> bool:
        """Settle a batch and report whether the saved MVU values changed."""
        if self.mode != "tavern" or (record := self._record()) is None:
            raise SceneError("Bind a card in a tavern session before changing variables")
        play = TavernSession.model_validate(record)
        settled = await self._prepare_mvu_update(play, record, update)
        before = play.mvu.values if play.mvu is not None else None
        after = settled.mvu.values if settled.mvu is not None else None
        changed = not json_equal(before, after)
        if play.pinned_mvu is not None and not changed:
            return False
        legacy = play.legacy_opening_web
        if legacy and legacy.counter and play.mvu and settled.mvu and self._script_turn_index() == 0:
            # Integer eligibility is stricter than Python's numeric equality (35 == 35.0).
            old, new = play.mvu.values, settled.mvu.values
            if old != new or legacy.counter.current(old) != legacy.counter.current(new):
                opening = legacy.model_copy(update={'values': new, 'counter_revision': legacy.counter_revision + 1})
                settled = settled.model_copy(update={'legacy_opening_web': opening})
                if schema := play.opening_schema:
                    binding = self.binding
                    store = binding.session_store if binding else None
                    settled = await self._derive_opening_schema(settled, schema)
                    if (not binding or self.binding is not binding or binding.session_store is not store
                            or self._record() != record or self._script_turn_index() != 0):
                        raise SceneError('The opening changed while applying the schema')
        self._save(settled.model_dump())
        self.ui_emit('state', self.ui_state())
        return changed

    async def _prepare_mvu_update(self, play: TavernSession, record: dict, update: str | list[MvuChange]) -> TavernSession:
        if play.mvu is None or not play.mvu.values or (isinstance(update, str) and not play.mvu_legacy):
            raise SceneError("This tavern has no initialized variables for this update format")
        try:
            if play.pinned_mvu is not None:
                if not isinstance(update, str):
                    raise ValueError('Use rp_apply_mvu_update for this fixed MVU profile')
                binding = self.binding
                store = binding.session_store if binding else None
                values = await to_thread(calculate_pinned_mvu, play.pinned_mvu, [], play.mvu.values, update)
                if (binding is None or self.binding is not binding or binding.session_store is not store
                        or self._record() != record):
                    raise ValueError('The tavern changed during the MVU update; try again')
                return play.model_copy(update={'mvu': play.mvu.model_copy(update={'values': values})})
            state = upgrade_button_receipts(play.script_state)
            scripts = approved(play.scripts, state) if self._script_turn_index() is not None else []
            # An old diagnostic is not proof of absent listeners: re-probe unknown registrations.
            scripts = [s for s in scripts if state.mvu_listeners.get(s.id, True)]
            mvu, state = await settle_mvu_candidate(play.mvu, state, update, scripts)
            if scripts and self._record() != record:
                raise ValueError('The tavern changed during the MVU update; try again')
        except ValueError as exc:
            raise SceneError(str(exc)) from exc
        return play.model_copy(update={'mvu': mvu, 'script_state': state})

    async def _derive_opening_schema(self, play: TavernSession, schema: OpeningSchemaSnapshot) -> TavernSession:
        if play.mvu is None:
            raise SceneError('An opening schema needs initialized variables')
        source = play.mvu.values if schema.input_ids is None else selected_message_values(play.mvu.values, schema.input_ids)
        value = await to_thread(derive_opening_schema, schema.code, source, schema.grant)
        return play.model_copy(update={'opening_schema': schema.model_copy(update={'value': value})})

    @staticmethod
    def _opening_schema_visible(play: TavernSession, values: dict[str, JsonValue]) -> bool:
        legacy = play.legacy_opening_web
        if not (legacy and legacy.counter and legacy.counter.public_id() in play.mvu_public):
            return False
        if play.opening_schema and (inputs := play.opening_schema.input_ids) is not None:
            return set(inputs).issubset(play.mvu_public) and len(public_values(values, inputs)) == len(inputs)
        # The legacy API schema receives the complete variable tree.
        return json_equal(values, selected_message_values(values, play.mvu_public))

    def _opening_web_message(self, play: TavernSession, values: dict[str, JsonValue]) -> dict[str, JsonValue]:
        selection = play.mvu_public
        if play.opening_schema and self._opening_schema_visible(play, values):
            values = with_opening_schema_output(values, play.opening_schema)
            selection = [*selection, json.dumps(play.opening_schema.grant.outputPath, ensure_ascii=False)]
        return legacy_web_message(0, play.greeting, values, selection)

    def _opening_counter_value(self, play: TavernSession) -> int | None:
        legacy = play.legacy_opening_web
        agent = self.binding.host_agent if self.binding else None
        if (not agent or agent.is_processing or self._script_turn_index() != 0 or not play.openingSent
                or not play.web_panel_ready or not play.mvu or not legacy or not legacy.mvu_read_enabled
                or not legacy.counter or legacy.counter.public_id() not in play.mvu_public):
            return None
        if play.opening_schema and not self._opening_schema_visible(play, play.mvu.values):
            return None
        return legacy.counter.current(play.mvu.values)

    def _can_write_mvu_setup(self, play: TavernSession) -> bool:
        binding = self.binding
        agent = binding.host_agent if binding else None
        return bool(agent and binding.session_store is not None and not agent.is_processing
                    and self._script_turn_index() == 0 and play.openingSent and play.web_panel_ready
                    and play.pinned_mvu and play.legacy_opening_web and play.legacy_opening_web.pinned_setup
                    and play.mvu and play.mvu.values.get('GameStarted') is False)

    async def _write_mvu_setup(self, requested: MvuSetupWrite, token: str) -> dict:
        async with self._scripts.lock:
            record = self._record()
            if token != self._web_panel_scope or record is None:
                raise OwnerArgumentError('The card web panel session changed; open the panel again')
            play = TavernSession.model_validate(record)
            if not self._can_write_mvu_setup(play) or not (before := setup_projection(play.mvu.values)):
                raise OwnerArgumentError('Character setup is only writable once, before the first turn')
            update = setup_update(before, requested.statData)
            settled = await self._prepare_mvu_update(play, record, update)
            if (token != self._web_panel_scope or self._record() != record or not self._can_write_mvu_setup(play)
                    or not setup_preserved(play.mvu.values, settled.mvu.values)):
                raise OwnerArgumentError('The opening setup could not be saved in the current session')
            self._save(settled.model_dump())
            self.ui_emit('state', self.ui_state())
            return {'data': {'stat_data': setup_projection(settled.mvu.values)}}

    async def _write_opening_counter(self, requested: OpeningCounterWrite, token: str) -> dict:
        binding = self.binding
        if not binding or (store := binding.session_store) is None or (agent := binding.host_agent) is None:
            raise OwnerArgumentError('The opening counter requires a persistent tavern session')

        def same_session() -> bool:
            return (self.binding is binding and binding.session_store is store and binding.host_agent is agent
                    and token == self._web_panel_scope)

        async with self._scripts.lock:
            if not same_session() or not (record := self._record()):
                raise OwnerArgumentError('The card web panel session changed; open the panel again')
            play = TavernSession.model_validate(record)
            legacy = play.legacy_opening_web
            now = self._opening_counter_value(play)
            if now is None or legacy is None or legacy.counter is None:
                raise OwnerArgumentError('The opening counter is no longer writable')
            if requested.revision != legacy.counter_revision or requested.expected != now:
                raise OwnerArgumentError('The opening counter changed; read the current value again')
            grant = legacy.counter
            if abs(requested.value - now) != 1 or not grant.minimum <= requested.value <= grant.maximum:
                raise OwnerArgumentError('The opening counter can only change by one step within its granted range')
            change = MvuChange(path=grant.path, op='set', value=requested.value)
            settled = await self._prepare_mvu_update(play, record, [change])
            if schema := play.opening_schema:
                settled = await self._derive_opening_schema(settled, schema)
            if (not same_session() or self._record() != record or self._opening_counter_value(play) != now
                    or settled.mvu is None or grant.current(settled.mvu.values) != requested.value):
                raise OwnerArgumentError('The opening counter could not be settled in the current game')
            after = legacy.model_copy(update={'values': settled.mvu.values, 'counter_revision': legacy.counter_revision + 1})
            settled = settled.model_copy(update={'legacy_opening_web': after})
            self._save(settled.model_dump())
            self.ui_emit('state', self.ui_state())
            return {'revision': after.counter_revision, 'data': self._opening_web_message(settled, after.values)['data']}

    def story(self) -> Story:
        if not self.novel or self.mode != "novel":
            raise ValueError("Only the director has the world state")
        return self.novel.story(self.binding)

    def require_open_scene(self) -> None:
        if self.mode != "novel" or not self.can_open_scene or self.story().pending is not None:
            raise SceneError("A fresh director turn with no pending scene is required")

    def save_story(self, story: Story) -> None:
        if self.mode != "novel" or self.binding is None:
            raise ValueError("Only the director may adjudicate")
        self.can_open_scene = False
        self._save(story.model_dump())
        self.ui_emit("state", self.ui_state())

    def open_dispatched_scene(self, before: Story, story: Story, output: str) -> None:
        binding = self.binding
        rewrite = active_revision(binding)
        if rewrite and rewrite.mode == "director_rewrite":
            raise SceneError("Director-only rewrites cannot dispatch NPCs")
        rows = [(binding._state_key("novel"), story.model_dump())]
        if rewrite is None:
            rows.append((binding._state_key(BASELINE), before.model_dump()))
        binding.session_store.state.put_many(rows)
        self.can_open_scene = False
        self.mark_scene_feedback("rp_dispatch_scene", output)
        self.ui_emit("state", self.ui_state())

    def save_adjudication(self, context: ToolContext, before: Story, story: Story, outcome: Outcome) -> None:
        """Commit the world and addressed NPC memories without waking a creature."""
        group = resolve_group_context(context)
        director = self.binding
        if self.mode != "novel" or director is None or director.host_agent is not group.caller.agent:
            raise SceneError("Only the bound director can commit an adjudication")
        store = director.session_store
        if store is None:
            raise SceneError("A persistent novel session is required")
        story = self.novel.apply_fields(director, story, outcome)
        rows = []
        updated_plugins = []
        memory_actors = outcome.private_updates.keys() | outcome.memory_updates.keys()
        sheet_actors = outcome.sheet_updates.keys() | outcome.card_updates.keys()
        for actor in (memory_actors | sheet_actors) & set(story.cast):
            target = resolve_group_target(group, actor)
            plugin = target.agent.plugins.get_plugin("roleplay")
            binding = plugin.binding if isinstance(plugin, RoleplayPlugin) else None
            if binding is None or plugin.mode != "npc" or binding.session_store is not store or binding.agent_name != actor:
                raise SceneError(f"Cannot deliver an adjudication to the session of {actor!r}")
            if actor in memory_actors:
                rows.append((binding._state_key("privateKnowledge"), actor_memory(story, actor).model_dump()))
            if actor in sheet_actors:
                rows.append((binding._state_key("characterSheet"), story.sheets[actor].model_dump()))
            if actor in outcome.card_updates:
                rows.append((binding._state_key("fieldValues"), story.card_values[actor]))
            updated_plugins.append(plugin)
        image = materialize_image(director, self.novel.members(director), story, outcome)
        chapter = story.chapters[-1]
        patch = {"imageUrl": image.url} if image is not None else {}
        if not self.novel.settings(director).enableStoryChoices:
            patch["choices"] = None
        if patch:
            story = story.model_copy(update={"chapters": [*story.chapters[:-1], chapter.model_copy(update=patch)]})
        values = {"novel": story.model_dump(), **committed_revision(director, before, story)}
        store.state.put_many([*((director._state_key(key), value) for key, value in values.items()), *rows])
        for plugin in updated_plugins:
            plugin.ui_emit("state", plugin.ui_state())
        self._committed_prose = story.latest_prose
        self._committed_choices = story.chapters[-1].choices
        self._committed_image = image
        self.can_open_scene = False
        self.ui_emit("state", self.ui_state())

    def _record(self) -> object:
        return self.binding.get_state(self.mode) if self.binding is not None else None

    def _save(self, value: object) -> None:
        if self.binding is None or self.binding.session_store is None:
            raise OwnerArgumentError("Start a persistent KT session before binding a card")
        self.binding.set_state(self.mode, value)

    def ui_state(self) -> dict[str, object]:
        if self.novel:
            view = self.novel.view(self.binding)
            if self.mode == "novel" and view["active"]:
                view["mediaPool"] = media_pool(self.binding, self.novel.members(self.binding))
                view["revision"] = revision_view(self, self.story(), bool(view["isProcessing"]))
            return view
        record = self._record()
        if record is None:
            return {"mode": self.mode, "active": False}
        if self.mode == "persona":
            return {"mode": self.mode, "active": True, **Attach.model_validate(record).model_dump()}
        play = TavernSession.model_validate(record)
        view = {"mode": self.mode, "active": True, "cardId": play.cardId, "name": play.card.name,
                "player": play.player.model_dump(), "greeting": play.greeting, "greetingIndex": play.greetingIndex,
                "enableStoryChoices": play.enableStoryChoices, "openingSent": play.openingSent, "hasPortrait": play.hasPortrait, "notes": play.notes,
                "worldbookEntries": len(play.worldbook.entries) if play.worldbook else None,
                "worldbookRef": play.worldbookRef,
                "worldbookDiagnostics": play.worldbook.diagnostics() if play.worldbook else None,
                "cardLoreDiagnostics": play.lore.diagnostics() if play.lore else None,
                "lore": self.binding.get_state("loreView") if self.binding else None,
                "media": media_summary(play.media), "mediaIssues": play.media_issues,
                'legacyPlugins': play.legacy_plugins}
        if play.web_panel and play.web_panel_ready:
            view['webPanel'] = {'title': play.web_panel.title}
            if play.legacy_opening_web is not None:
                view['webPanel']['source'] = 'legacyOpening'
                if play.legacy_reply_web is not None:
                    view['webPanel']['latestMessageId'] = play.legacy_reply_web.turn
            if status := pinned_status_view(play):
                view['webPanel']['pinnedMvuStatus'] = status
        elif play.web_panel_issue is not None:
            view['webPanelIssue'] = play.web_panel_issue
        elif play.web_panel is None and SETUP_MARKER in play.greeting:
            greetings = [play.card.first_mes, *play.card.alternate_greetings]
            if 0 <= play.greetingIndex < len(greetings) and SETUP_MARKER in greetings[play.greetingIndex]:
                view['webPanelIssue'] = 'setup_not_in_save'
        if play.opening_gameplay_issue:
            view['openingGameplayIssue'] = play.opening_gameplay_issue
        if play.scripts and play.pinned_mvu is None:
            host_ok = self._script_turn_index() is not None
            issues = play.script_state.issues if host_ok else {**play.script_state.issues, "$host": SCRIPT_CLOCK_UNAVAILABLE}
            if play.pinned_mvu_issue:
                issues = {**issues, '$host': play.pinned_mvu_issue}
            runnable = {s.id for s in approved(play.scripts, play.script_state)} if host_ok else set()
            views = [s.view() if s.id not in runnable else {
                **s.view(), 'buttons': visible_script_buttons(s, play.script_state.appended_buttons.get(s.id, [])),
            } for s in play.scripts]
            view["cardScripts"] = {"entries": views,
                                   "canEnable": host_ok and play.opening_schema is None and not play.pinned_mvu_issue and bool(play.mvu and play.mvu.values and any(
                                       s.enabled and (s.issue is None or s.issue in RETRYABLE_MODULE_ISSUES) for s in play.scripts)),
                                   "enabled": bool(runnable),
                                   "issues": issues, 'inactiveEvents': play.script_state.inactive_events}
        selected = chosen_key(play.portrait_rules, play.state_fields, play.values)
        if selected is not None:
            view.update(hasPortrait=True, portraitKey=selected)
        if play.scene_media_rules:
            selected_scene = scene_image(play)
            view["sceneMediaKey"] = selected_scene.key if selected_scene else next(
                (asset.key for asset in play.media if asset.kind == "icon"), None)
        visible = public_fields(play.state_fields, play.values)
        if visible:
            view["stateFields"] = visible
        if play.native_panels or play.invalid_native_panels:
            view["nativePanels"] = public_panels(play.native_panels, play.state_fields, play.values)
            view["invalidNativePanels"] = play.invalid_native_panels
        if play.mvu is not None:
            view["mvu"] = {"invalidInitializers": play.mvu.issues.get("invalid_initializer", 0),
                           "invalidOpeningUpdates": play.mvu.issues.get("invalid_opening_update", 0),
                           "options": public_options(play.mvu.values), "selected": play.mvu_public,
                           "values": public_values(play.mvu.values, play.mvu_public)}
            if play.pinned_mvu is not None:
                view['mvu']['runtime'] = 'magvarupdate-zod-v1'
        view["headerSummary"] = header_summary(view, play.header_pins)
        return view

    async def _request_legacy_plugin(self, call: LegacyRequest, panel_scope: str | None) -> dict[str, JsonValue]:
        record = self._record()
        if not record or call.pluginId not in record.get('legacy_plugins', []):
            raise OwnerArgumentError(f'Legacy plugin {call.pluginId} is not enabled in this tavern')
        providers = await to_thread(configured_plugins, library_dir())
        current = self._record()
        if panel_scope is not None and panel_scope != self._web_panel_scope:
            raise OwnerArgumentError('The card web panel session changed; open the panel again')
        if not current or call.pluginId not in current.get('legacy_plugins', []):
            raise OwnerArgumentError(f'Legacy plugin {call.pluginId} is no longer enabled in this tavern')
        return await to_thread(request_plugin, providers, call)

    async def ui_call(self, action: str, args: dict[str, object], context, *,
                      prepared_worldbook: WorldbookSnapshot | None = None) -> dict[str, object] | None:
        if context is not None and context.multi_user:
            raise OwnerForbiddenError("Roleplay currently supports single-user KT hosts only")
        try:
            if self.mode == "novel" and action in READER_ACTIONS:
                return await call_reader(self, action, args)
            if action == "set_story_choices" and self.mode == "tavern":
                record = self._record()
                if record is None:
                    raise OwnerArgumentError("Start a tavern before setting story choices")
                toggle = StoryChoicesToggle.model_validate(args)
                self._save({**record, "enableStoryChoices": toggle.enabled})
                view = self.ui_state()
                self.ui_emit("state", view)
                return view
            if action == "resume_scene" and self.mode == "novel":
                number = args.get("scene")
                if type(number) is not int or set(args) != {"scene"}:
                    raise OwnerArgumentError("Expected the current numeric scene identifier")
                await resume_scene(self, number)
                return self.ui_state()
            if action == "cards" and self.mode in ("persona", "tavern"):
                return cards_view(library_dir())
            if action in WEB_ACTIONS and self.mode == 'tavern':
                return await call_web_panel(self, action, args)
            if action == "worldbook_slot_detail" and self.mode == "tavern" and (record := self._record()) is not None:
                slot = args.get("slot")
                if set(args) != {"slot"} or slot not in ("embedded", "attached"):
                    raise OwnerArgumentError("Choose the embedded or attached worldbook")
                play = TavernSession.model_validate(record)
                if slot == "embedded":
                    return snapshot_detail(play.card.name, play.lore) if play.lore is not None else None
                name = play.worldbookRef["name"] if play.worldbookRef else ""
                return snapshot_detail(name, play.worldbook) if play.worldbook is not None else None
            if action in ('legacy_plugin_options', 'set_legacy_plugins', 'legacy_plugin_request') and self.mode == 'tavern':
                if (record := self._record()) is None:
                    raise OwnerArgumentError('Start a tavern before using legacy plugins')
                play = TavernSession.model_validate(record)
                if action == 'legacy_plugin_request':
                    return await self._request_legacy_plugin(LegacyRequest.model_validate(args), None)
                if action == 'legacy_plugin_options':
                    if args:
                        raise OwnerArgumentError('Plugin options do not take any arguments')
                    providers = await to_thread(configured_plugins, library_dir())
                    return {'available': sorted(providers), 'enabled': play.legacy_plugins}
                requested = LegacySelection.model_validate(args).pluginIds
                if len(requested) != len(set(requested)):
                    raise OwnerArgumentError('Do not select the same plugin twice')
                if requested:
                    providers = await to_thread(configured_plugins, library_dir())
                    if any(name not in providers for name in requested):
                        raise OwnerArgumentError('Only plugins configured by the KT operator can be enabled')
                    if self._record() != record:
                        raise OwnerArgumentError('The tavern changed while setting plugins; try again')
                self._save(play.model_copy(update={'legacy_plugins': requested}).model_dump())
                view = self.ui_state()
                self.ui_emit('state', view)
                return {'enabled': requested}
            if action == "set_card_scripts" and self.mode == "tavern" and (record := self._record()) is not None:
                if set(args) != {"enabled"} or type(args["enabled"]) is not bool:
                    raise OwnerArgumentError("Expected an explicit script enable or disable choice")
                play = TavernSession.model_validate(record)
                if play.pinned_mvu is not None or (args['enabled'] and play.pinned_mvu_issue):
                    raise OwnerArgumentError('The fixed MVU runtime is selected at opening; prepare resources and start a new tavern')
                if args['enabled'] and play.opening_schema:
                    raise OwnerArgumentError('This opening schema profile runs separately from ordinary card scripts')
                if args["enabled"] and self._script_turn_index() is None:
                    raise OwnerArgumentError(SCRIPT_CLOCK_UNAVAILABLE)
                if args["enabled"]:
                    if not play.mvu or not play.mvu.values:
                        raise card_scripts_unavailable(play.scripts, play.mvu)
                    if not approved(play.scripts, play.script_state) and any(
                            s.enabled and not s.module and (s.issue is None or s.issue in RETRYABLE_MODULE_ISSUES)
                            for s in play.scripts):
                        scripts = await to_thread(link_card_scripts, library_dir(), play.cardId, play.scripts)
                        if self._record() != record:
                            raise OwnerArgumentError("The tavern changed while linking modules; try again")
                        if scripts != play.scripts:
                            unchanged = {old.id for old, new in zip(play.scripts, scripts) if old == new}
                            saved = {key: rows for key, rows in play.script_state.appended_buttons.items() if key in unchanged}
                            play = play.model_copy(update={"scripts": scripts, "script_state": play.script_state.model_copy(
                                update={'appended_buttons': saved})})
                    if not any(s.enabled and not s.issue for s in play.scripts):
                        self._save(play.model_dump())
                        self.ui_emit("state", self.ui_state())
                        raise card_scripts_unavailable(play.scripts, play.mvu)
                consent = script_fingerprint(play.scripts) if args["enabled"] else None
                permission = play.script_state.model_copy(update={'approved': consent})
                if consent != play.script_state.approved:
                    permission = permission.model_copy(update={'mvu_listeners': {}, 'issues': {}, 'inactive_events': {}})
                self._save(play.model_copy(update={'script_state': permission}).model_dump())
                view = self.ui_state()
                self.ui_emit("state", view)
                return view
            if action == "invoke_script_button" and self.mode == "tavern" and self._record() is not None:
                script_id, button = args.get("scriptId"), args.get("button")
                if set(args) != {"scriptId", "button"} or not isinstance(script_id, str) or not isinstance(button, str):
                    raise OwnerArgumentError("Expected a script id and a published button")
                agent = self.binding.host_agent if self.binding else None
                if agent and agent.is_processing:
                    raise OwnerArgumentError("Wait for the tavern to finish responding before using a script button")
                await self._scripts.fire("button:" + button, script_id=script_id)
                return self.ui_state()
            if action == "set_header_pins" and self.mode == "tavern" and (record := self._record()) is not None:
                pins = args.get("ids")
                if (set(args) != {"ids"} or not isinstance(pins, list) or len(pins) > MAX_HEADER_PINS
                        or any(not isinstance(key, str) for key in pins) or len(set(pins)) != len(pins)):
                    raise OwnerArgumentError("Choose up to eight different public summary items")
                view = self.ui_state()
                if not set(pins).issubset(item["id"] for item in view["headerSummary"]["options"]):
                    raise OwnerArgumentError("Only current public summary items can be pinned")
                play = TavernSession.model_validate(record)
                self._save(play.model_copy(update={"header_pins": pins}).model_dump())
                view = self.ui_state()
                self.ui_emit("state", view)
                return view
            if action == "set_mvu_public" and self.mode == "tavern" and (record := self._record()) is not None:
                selection = MvuSelection.model_validate(args).ids
                play = TavernSession.model_validate(record)
                if play.mvu is None or len(selection) != len(set(selection)) or not set(selection).issubset(
                    item["id"] for item in public_options(play.mvu.values)
                ):
                    raise OwnerArgumentError("Choose existing variable paths only")
                pins = [key for key in play.header_pins if not key.startswith("mvu:") or key[4:] in selection]
                legacy = play.legacy_opening_web
                if legacy and legacy.counter and set(selection) != set(play.mvu_public):
                    legacy = legacy.model_copy(update={'counter_revision': legacy.counter_revision + 1})
                self._save(play.model_copy(update={'mvu_public': selection, 'header_pins': pins,
                                                  'legacy_opening_web': legacy}).model_dump())
                view = self.ui_state()
                self.ui_emit("state", view)
                return view
            if action == "choose_panel_option" and self.mode == "tavern" and (record := self._record()) is not None:
                choice = PanelSelection.model_validate(args)
                play = TavernSession.model_validate(record)
                panel = next((p for p in play.native_panels if isinstance(p, ChoicePanel) and p.id == choice.panelId), None)
                if panel is None or choice.index >= len(panel.options):
                    raise OwnerArgumentError("This action is not available for the current card")
                agent = self.binding.host_agent if self.binding else None
                if agent is None or agent.is_processing:
                    raise OwnerArgumentError("Wait for the tavern to become idle before sending an action")
                text = panel.options[choice.index].text
                await agent.inject_input([{"type": "text", "text": text}], source="web")
                return self.ui_state()
            if action == "media" and self.mode == "tavern" and self._record() is not None:
                play = TavernSession.model_validate(self._record())
                key = args.get("key")
                if args.get("id") != play.cardId or not isinstance(key, str) or not any(item.key == key for item in play.media):
                    raise OwnerArgumentError("Only media from the selected tavern card can be viewed here")
                return await to_thread(media_view, library_dir(), play.cardId, key)
            if action in ("detail", "portrait") and (self.mode != "npc" or action == "portrait"):
                key = args.get("id")
                if not isinstance(key, str) or not key:
                    raise OwnerArgumentError("A card id is required")
                if self.mode == "novel" and (action != "portrait" or key not in {m.cardId for m in self.novel.members(self.binding)}):
                    raise OwnerArgumentError("The reader can only request portraits from this cast")
                if self.mode == "npc" and key != self.ui_state().get("cardId"):
                    raise OwnerArgumentError("Only this NPC's portrait can be requested")
                if action == "detail":
                    return card_detail(library_dir(), key)
                selected = args.get("variant")
                if selected is not None:
                    view = self.ui_state()
                    entries = view["cast"] if self.mode == "novel" else [view]
                    if not isinstance(selected, str) or not any(e.get("cardId") == key and e.get("portraitKey") == selected for e in entries):
                        raise OwnerArgumentError("Portrait is not selected in this session")
                return portrait_view(library_dir(), key, selected)
            if action == "apply_persona" and self.mode == "persona":
                request = Attach.model_validate(args)
                get_card(library_dir(), request.cardId)
                self._save(request.model_dump())
            elif action == "remove_persona" and self.mode == "persona":
                self._save(None)
            elif action == "start_tavern" and self.mode == "tavern":
                if self._record() is not None:
                    raise OwnerArgumentError("This session already has an opening; start a new session for another game")
                agent = self.binding.host_agent
                if agent is not None and agent.is_processing:
                    raise OwnerArgumentError("Wait for the session to become idle before setting its opening")
                choice = Play.model_validate(args)
                scope = self._web_panel_scope

                def check_opening_target() -> None:
                    if scope != self._web_panel_scope or self._record() is not None or (agent is not None and agent.is_processing):
                        raise OwnerArgumentError('The session changed before its opening could be set')

                card = await to_thread(get_card, library_dir(), choice.cardId, with_scripts=True)
                check_opening_target()
                if pack := card.gameplay_pack:
                    tavern_creature(pack)
                    provider = agent.plugins.get_plugin(pack.name) if agent and agent.plugins.is_enabled(pack.name) else None
                    validate = getattr(provider, 'validate_roleplay_settings', None)
                    if not callable(validate):
                        raise OwnerArgumentError(f'Start this card with the {pack.name} gameplay creature')
                    validate(pack.model_copy(deep=True).settings)
                play, enable_scripts = await prepare_tavern_opening(
                    library_dir(), choice, card, prepared_worldbook=prepared_worldbook,
                    has_script_clock=lambda: self._script_turn_index() is not None, ensure_current=check_opening_target,
                )
                self._save(play.model_dump())
                if enable_scripts:
                    await self._scripts.fire("opening", sequence=0)
                changes = {'web_panel_ready': True} if play.web_panel is not None else {}
                if play.greeting:
                    if legacy_state := play.legacy_opening_web:
                        opening_play = TavernSession.model_validate(self._record())
                        if opening_play.mvu is not None:
                            changes['legacy_opening_web'] = legacy_state.model_copy(update={'values': opening_play.mvu.values})
                    await self.publish_opening(play.greeting)
                    changes['openingSent'] = True
                if changes:
                    latest = TavernSession.model_validate(self._record())
                    self._save(latest.model_copy(update=changes).model_dump())
            elif action in ("set_worldbook", "bind_library_worldbook") and self.mode == "tavern" and (record := self._record()) is not None:
                book_ref = None
                if action == "set_worldbook":
                    if set(args) != {"book"} or (args["book"] is not None and not isinstance(args["book"], dict)):
                        raise OwnerArgumentError("Expected a world-info object or null to remove the book")
                    book = read_worldbook(args["book"]) if args["book"] is not None else None
                else:
                    book_id = args.get("bookId")
                    if set(args) != {"bookId"} or (book_id is not None and (not isinstance(book_id, str) or not book_id)):
                        raise OwnerArgumentError("Expected a library book id or null to remove the book")
                    book_ref, book = worldbook_for_play(library_dir(), book_id) if book_id is not None else (None, None)
                existing = TavernSession.model_validate(record)
                timers = {kind: starts for kind, starts in existing.lore_activation.items() if kind != "worldbook"}
                self._save(existing.model_copy(update={"worldbook": book, "worldbookRef": book_ref, "lore_activation": timers}).model_dump())
                self.binding.set_state("loreView", None)
            elif action == "set_notes" and self.mode == "tavern" and self._record() is not None:
                existing = TavernSession.model_validate(self._record())
                self._save(existing.model_copy(update=Notes.model_validate(args).model_dump()).model_dump())
            else:
                raise OwnerArgumentError(f"Action {action!r} is not available in the current {self.mode} session")
        except (ValidationError, CardError, CardNotFound, WorldbookNotFound, CardScriptError, SceneError, GameplayPackUnavailable, LegacyPluginError, SettlementRejected) as exc:
            raise OwnerArgumentError(f"Invalid roleplay request: {exc}") from exc
        view = self.ui_state()
        self.ui_emit("state", view)
        return view

    async def _tavern_scene_image(self) -> ImagePart | None:
        binding = self.binding
        store = binding.session_store if binding is not None else None
        record = self._record() if self.mode == "tavern" and store is not None else None
        if not record or not record.get("scene_media_rules"):
            return None
        play = TavernSession.model_validate(record)
        if (scene := scene_image(play)) is None:
            return None
        try:
            image = await to_thread(save_scene_image, library_dir(), play.cardId, scene, store)
        except (CardError, CardNotFound, OSError, ValueError) as exc:
            logger.warning("Could not attach a Roleplay scene image: %s", exc)
            return None
        if self.binding is binding and binding.session_store is store and self._record() == record:
            return image
        return None

    async def publish_opening(self, text: str) -> None:
        binding = self.binding
        if binding is None or binding.controller is None:
            raise OwnerArgumentError("Publishing requires a live controller")
        controller, agent, store = binding.controller, binding.host_agent, binding.session_store
        history = getattr(agent, "_session_output", None)
        image = await self._tavern_scene_image()
        if self.binding is not binding or binding.controller is not controller or binding.session_store is not store:
            raise OwnerArgumentError("The session changed before publishing its opening")
        if history is None:
            await self._publish_assistant(controller, text, image=image)
            return

        # KT 2.2.2 treats every live text frame as model streaming, and a
        # synthetic processing_end would also activate Studio's summary hook.
        # Persist the opening first, then refresh attached chats as already idle.
        from kohakuterrarium.studio.attach._event_stream import StreamOutput

        await binding.emit(OutputEvent(type="assistant_round_start"))
        message = controller.conversation.append("assistant", text)
        await history.emit(OutputEvent(type="text", content=text))
        if image is not None:
            # Like the opening text, persist it and let the idle refresh load
            # the whole row rather than synthesize a live model turn.
            await history.emit(attach_scene_image(message, image))
        await binding.emit(OutputEvent(type="assistant_message", payload={"message": message.to_dict()}))
        await history.drain()
        if not agent.is_processing:
            for output in agent.output_router._secondary_outputs:
                if isinstance(output, StreamOutput):
                    output._put({"type": "idle"})

    async def _publish_assistant(self, controller, text: str, *, image: ImagePart | None = None) -> None:
        await self.binding.emit(OutputEvent(type="assistant_round_start"))
        message = controller.conversation.append("assistant", text)
        await self.binding.emit(OutputEvent(type="text", content=text))
        if image is not None:
            await self.binding.emit(attach_scene_image(message, image))
        await self.binding.emit(OutputEvent(type="assistant_message", payload={"message": message.to_dict()}))

    def _script_turn_index(self) -> int | None:
        if self.binding is None or self.binding.controller is None:
            return None
        turn = getattr(self.binding.host_agent, "_turn_index", None)
        return turn if type(turn) is int and turn >= 0 else None

    def _script_turn(self):
        record = self._record() if self.mode == "tavern" else None
        if not record or not (record.get("script_state") or {}).get("approved") or self.binding is None:
            return None
        turn = self._script_turn_index()
        return (self.binding.controller, turn) if turn else None

    async def post_llm_call(self, messages: list[dict], response: str, usage: dict, **kwargs: object) -> None:
        binding = self.binding
        if self.mode != "tavern" or binding is None or binding.controller is None or not response.strip():
            return
        controller = binding.controller
        message = controller._completed_assistant_message
        history = controller.conversation.get_messages()
        if message is None or not history or history[-1] is not message or message.tool_calls:
            return
        if (active := self._script_turn()) is not None:
            await self._scripts.fire("assistant", sequence=active[1], args={"text": response[:900]})

        record = self._record()
        if not record or not record.get("scene_media_rules") or controller._interrupted:
            return
        # Native calls are present on the message; text-mode calls are encoded
        # in the prose. Neither an intermediate call nor an aborted reply gets CG.
        if not controller._is_native_mode and any(
            is_action_event(event) for event in parse_full(message.get_text_content(), controller._parser_config)
        ):
            return
        image = await self._tavern_scene_image()
        if (image is not None and self.binding is binding and not controller._interrupted
                and controller._completed_assistant_message is message):
            await binding.emit(attach_scene_image(message, image))

    async def pre_llm_call(self, messages: list[dict], **kwargs: object) -> list[dict] | None:
        if (active := self._script_turn()) is not None:
            controller, turn = active
            history = controller.conversation.get_messages()
            if history:
                message = history[-1]
                if message.role == "user" and (message.metadata or {}).get("kind") != TOOL_FEEDBACK_KIND:
                    await self._scripts.fire("user", sequence=turn, args={"text": message.get_text_content()[:900]})
        record = self._record()
        if self.novel:
            head = self.novel.prompt_head(self.binding)
            tail = self.novel.prompt_tail(self.binding)
            if self.mode == "novel":
                tail += canonical_chapters(self.story())
                messages = without_scene_images(messages)
                settings = self.novel.settings(self.binding)
                lore = await novel_lore(messages, self.novel.worldbooks(self.binding), settings, _text, _cost)
                if lore:
                    tail += "\nDirector-only worldbook references: " + json.dumps(lore, ensure_ascii=False)
                media = media_pool(self.binding, self.novel.members(self.binding))
                if media:
                    tail += "\nAvailable local scene image keys: " + json.dumps([{k: item[k] for k in ("key", "name")} for item in media], ensure_ascii=False)
        elif record is None:
            return None
        elif self.mode == "persona":
            return mount_persona(messages, Attach.model_validate(record).persona)
        else:
            play = TavernSession.model_validate(record)
            messages = without_scene_images(messages)
            history = [_text(m) for m in messages if m.get("role") in ("user", "assistant")]
            sources = {kind: book for kind, book in (("lore", play.lore), ("worldbook", play.worldbook)) if book is not None}
            books = list(sources.values())
            timers = {kind for kind, book in sources.items() if any(e.sticky_messages or e.cooldown_messages for e in book.entries)}
            chat_count = None
            if timers or any(entry.delay_messages for book in books for entry in book.entries):
                host = self.binding.host_agent if self.binding else None
                if host and host.controller:
                    chat_count = sum(
                        message.role in ("user", "assistant") and bool(message.content)
                        and (message.metadata or {}).get("kind") != TOOL_FEEDBACK_KIND
                        for message in host.controller.conversation.get_messages()
                    )
            # Reserve worker slots for entries that can activate now before speculating about recursive matches.
            authored, recursive = [], []
            scan = {}
            template_match_budget = MatchBudget()
            has_templates = False
            for kind, book in sources.items():
                for index, entry in enumerate(book.entries):
                    if not entry.enabled or not entry.content_template:
                        continue
                    has_templates = True
                    depth = book.scan_depth if entry.scan_depth is None else entry.scan_depth
                    if depth not in scan:
                        scan[depth] = '\n'.join(history[-depth:]) if depth else ''
                    try:
                        matches = entry.match_score(scan[depth], template_match_budget) is not None
                    except TimeoutError:
                        matches = False
                    if matches or str(index) in play.lore_activation.get(kind, {}):
                        authored.append(entry.content)
                    elif book.recursive_scanning and not entry.exclude_recursion:
                        recursive.append(entry.content)
            rendered, template_failures = {}, 0
            if authored or recursive:
                rendered, template_failures = await to_thread(render_templates, authored + recursive,
                                                               play.mvu.values if play.mvu else {}, play.player.name)
                if self._record() != record:
                    raise PluginBlockError('Roleplay session changed while rendering the worldbook; retry this turn')
            entries = []
            allowance = TEMPLATE_BOOK_BUDGET if has_templates else 2048
            remaining = allowance

            def lore_cost(text: str) -> int:
                return _cost(render_tavern_text(text, play.card, play.player))

            regex_budget = MatchBudget()
            outlets = tavern_outlets(play.card)
            activation = dict(play.lore_activation)
            for kind, book in sources.items():
                timing = LoreTiming(chat_count, activation.get(kind, {})) if kind in timers and chat_count is not None else None
                chosen = active_entries(book, history, lore_cost, remaining, chat_messages=chat_count,
                                        regex_budget=regex_budget, outlets=outlets, timing=timing, rendered_templates=rendered)
                entries.extend(chosen)
                remaining -= sum(lore_cost(e.content) for e in chosen)
                if timing is not None and timing.next:
                    activation[kind] = timing.next
                elif timing is not None:
                    activation.pop(kind, None)
            if activation != play.lore_activation:
                self._save(play.model_copy(update={"lore_activation": activation}).model_dump())
            static_lore, dynamic_lore = tavern_lore_context(play.card, play.player, books, entries)
            head = tavern_static_context(play.card, play.player, play.notes, static_lore)
            if not play.enableStoryChoices:
                head += "\nDo not output a kt_roleplay.choices block."
            elif self.binding and (choice_direction := self.presentation_contribution(self.binding)):
                head += "\n" + choice_direction
            state = []
            if play.state_fields:
                state.append("Use rp_set_card_state for changed declared fields only. Settle independent in-world actions "
                            "in separate tool calls, even in the same turn. Group only steps that must succeed together. "
                            "Do not replay successful calls if a different call fails. Keep private fields out of prose.\n"
                            + json.dumps(model_fields(play.state_fields, play.values), ensure_ascii=False))
            gameplay = public_panels([panel for panel in play.native_panels if isinstance(panel, (InventoryPanel, QuestPanel))],
                                     play.state_fields, play.values)
            if gameplay:
                state.append("For an inventory or quest action, use rp_apply_gameplay with these panel IDs; "
                            "do not replace inventory contents or set a quest to its completed value through rp_set_card_state.\n" + json.dumps(gameplay, ensure_ascii=False))
            if play.mvu is not None and play.mvu.values:
                mvu_tool = 'rp_apply_mvu_update' if play.pinned_mvu is not None else 'rp_update_mvu'
                state.append(f"These are initialized variables in the current fictional session only. Use {mvu_tool} to "
                            "record only justified changes. Variables not selected for display are private; do not copy "
                            "their values into prose.\n" + json.dumps({"mvu_variables": play.mvu.values,
                                                                       "mvu_displayed_paths": [json.loads(key) for key in play.mvu_public]},
                                                                      ensure_ascii=False))
            if play.script_state.approved and self._script_turn_index() is not None:
                script_choices = [{"id": script.id, "name": script.name} for script in approved(play.scripts, play.script_state)]
                if script_choices:
                    state.append("Only use rp_run_card_script for a justified action with a registered ID from this list:\n" + json.dumps(script_choices, ensure_ascii=False))
            if play.pinned_mvu is not None:
                head += '\nUse one <UpdateVariable><JSONPatch>…</JSONPatch></UpdateVariable> with literal JSON add, replace and remove operations. Do not print the update in the story.'
            elif play.mvu_legacy:
                head += "\nIf the card requests a literal <UpdateVariable> block, call rp_apply_mvu_update instead of printing the block. Do not apply the same change through both update tools."
            tail = tavern_dynamic_context(dynamic_lore, state)
            if books and self.binding:
                lore_view = {"totalEntries": sum(len(book.entries) for book in books), "activeTitles": [e.name or e.comment or ", ".join(e.keys) for e in entries], "usedTokens": allowance - remaining, "budgetTokens": min(allowance, sum(book.token_budget for book in books))}
                if template_failures:
                    lore_view['templateFailures'] = template_failures
                if self.binding.get_state("loreView") != lore_view:
                    self.binding.set_state("loreView", lore_view)
                    self.ui_emit("state", self.ui_state())
        return insert_roleplay_context(insert_tail_context(messages, tail), head)
