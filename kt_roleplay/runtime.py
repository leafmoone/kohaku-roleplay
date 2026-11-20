"""Bind confirmed character data to a live KT creature without mutating its config."""

from asyncio import current_task, to_thread
from collections.abc import Callable
import json
from pathlib import Path
from typing import Literal
from uuid import uuid4

from kohakuterrarium.builtins.plugins.ui_declarative.plugin import attached_renderers
from kohakuterrarium.modules.output.event import OutputEvent
from kohakuterrarium.core.events import TriggerEvent
from kohakuterrarium.modules.tool.base import ToolContext
from kohakuterrarium.terrarium.tools.context import resolve_group_context, resolve_group_target
from pydantic import TypeAdapter

from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError, model_validator
from kohakuterrarium.core.conversation.elide import TOOL_FEEDBACK_KIND, estimate_message_tokens
from kohakuterrarium.llm.message import UserMessage
from kohakuterrarium.modules.plugin.base import BasePlugin, PluginBlockError, PluginContext, ToolVisibility
from kohakuterrarium.modules.ui_owner import OwnerArgumentError, OwnerForbiddenError
from kohakuterrarium.utils.config_dir import config_dir

from .card_scripts import CardScript, script_fingerprint, visible_script_buttons
from .card_web import WebPanel
from .cards import CardError, CardFields
from .charx import CardMedia
from .cast import NovelBinding
from .errors import SettlementRejected
from .gameplay_pack import GameplayPack, GameplayPackUnavailable, pack_settings, pack_tools, tavern_creature
from .gameplay import Action, Actions, PlayActions, apply_actions, apply_field_changes
from .header_summary import MAX_HEADER_PINS, header_summary
from .legacy_plugins import LegacyPluginError, LegacyRequest, LegacySelection, LegacyWebRequest, configured_plugins, request_plugin
from .legacy_web import (LEGACY_MESSAGE_EVENT_LIMIT, LEGACY_MESSAGE_SLOT, LegacyMessageAnchor, LegacyMessageLocator,
                         LegacyOpeningState, LegacyReplyCapture, LegacyReplyState, OpeningCounterGrant, OpeningCounterWrite,
                         completed_legacy_message_anchor, has_legacy_message_slot, has_mvu_status_adapter, legacy_web_message,
                         legacy_slot_options, mvu_reply_has_body, selected_message_values)
from .novel import Outcome, SceneError, Story
from .card_state import FieldUpdate, StateField, Value, model_fields, public_fields
from .state_tool import SetCardState
from .portraits import PortraitRule, chosen_key, rules_for
from .library_view import card_detail, cards_view, media_summary, media_view, portrait_view
from .library import CardNotFound, card_scripts_default, get_card
from .module_linker import RETRYABLE_MODULE_ISSUES, ModuleLinkError, link_card_scripts
from .lore import LoreBook, active_entries
from .lore_regex import MatchBudget
from .lore_templates import render_templates
from .lore_timing import LoreTiming
from .mvu import MvuChange, MvuInit, apply_changes, inspect_initializers, is_initializer, public_options, public_values
from .mvu_legacy import apply_literal_update, split_opening
from .mvu_patch import json_equal
from .mvu_tool import ApplyMvuUpdate, UpdateMvu
from .opening_mvu_schema import (OpeningSchemaGrant, OpeningSchemaSnapshot, derive_opening_schema,
                                 link_opening_schema, with_opening_schema_output)
from .opening_page_library import CALLBACK_RUNTIME, OpeningPageIssue, OpeningPageRuntime, cached_opening_panel
from .panels import ChoicePanel, InventoryPanel, NativePanel, QuestPanel, public_panels
from .projections import Persona, Player, expand, insert_depth_lore, persona_context, render_tavern_text, story_context, tavern_outlets
from .worldbook import TEMPLATE_BOOK_BUDGET, read_worldbook
from .worldbook_library import WorldbookNotFound, WorldbookReference, default_worldbook_for_play, snapshot_detail, worldbook_for_play
from .scene_tools import ingest_report
from .script_session import ScriptSession, SessionScripts, approved, settled_mvu_scripts, upgrade_button_receipts, upgrade_script_clock
from .script_tool import CardScriptError, RunCardScript, run_mvu_update
from .recovery import resume_scene


_SCRIPT_CLOCK_UNAVAILABLE = "Card scripts require a KT host with a persisted conversation turn counter"


class Arguments(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


class Attach(Arguments):
    cardId: str
    persona: Persona


class Play(Arguments):
    cardId: str
    player: Player
    greetingIndex: int = Field(ge=0)
    worldbookId: str | None = Field(default=None, min_length=1)
    enableCardScripts: bool = False
    enableOpeningModules: bool = True
    openingPageRuntime: OpeningPageRuntime | None = None
    enableOpeningMvuRead: bool = False
    openingMvuCounter: OpeningCounterGrant | None = None
    openingMvuSchema: OpeningSchemaGrant | None = None
    legacyMessageSlot: Literal['mes-text-v1'] | None = None

    @model_validator(mode='after')
    def _opening_runtime_consent(self) -> 'Play':
        if self.openingPageRuntime is not None and not self.enableOpeningModules:
            raise ValueError('An opening-page runtime requires opening modules to be enabled')
        if self.enableOpeningMvuRead and self.openingPageRuntime != CALLBACK_RUNTIME:
            raise ValueError('Opening-page MVU reads require the tavern-page-callbacks-v1 runtime')
        if self.openingMvuCounter is not None and not self.enableOpeningMvuRead:
            raise ValueError('An opening counter requires explicit opening-page MVU read permission')
        if self.openingMvuSchema and (not self.openingMvuCounter or self.enableCardScripts
                                      or 'enableCardScripts' not in self.model_fields_set):
            raise ValueError('The opening schema needs a counter and explicit enableCardScripts: false')
        if self.legacyMessageSlot is not None and not self.enableOpeningModules:
            raise ValueError('The message slot requires opening modules to be enabled')
        return self


def _card_scripts_unavailable(scripts: list[CardScript], mvu: MvuInit | None) -> OwnerArgumentError:
    detail = ", ".join(f"{script.id}: {script.issue}" for script in scripts if script.enabled and script.issue)
    if not mvu or not mvu.values:
        message = "Card scripts need non-empty variables from a valid [InitVar] entry"
    elif detail:
        message = "No enabled card script can run"
    else:
        message = "This card has no enabled compatible scripts"
    return OwnerArgumentError(f"{message} ({detail})" if detail else message)


class Notes(Arguments):
    notes: str


class MvuSelection(Arguments):
    ids: list[str] = Field(max_length=128)


class LegacyMessageSlotRequest(Arguments):
    panelScope: str = Field(min_length=1, max_length=256)
    locator: LegacyMessageLocator


class LegacyMessageOptionRequest(LegacyMessageSlotRequest):
    optionIndex: int = Field(ge=0, lt=8)


class PanelSelection(Arguments):
    panelId: str
    index: int = Field(ge=0)


class TavernSession(Arguments):
    cardId: str
    card: CardFields
    player: Player
    greeting: str
    greetingIndex: int = 0
    openingSent: bool = False
    hasPortrait: bool = False
    portrait_rules: list[PortraitRule] = Field(default_factory=list)
    state_fields: list[StateField] = Field(default_factory=list)
    values: dict[str, Value] = Field(default_factory=dict)
    lore: LoreBook | None
    worldbook: LoreBook | None = None
    worldbookRef: WorldbookReference | None = None
    notes: str
    media: list[CardMedia] = Field(default_factory=list)
    media_issues: dict[str, int] = Field(default_factory=dict)
    scene_media_rules: list[PortraitRule] = Field(default_factory=list)
    native_panels: list[NativePanel] = Field(default_factory=list)
    invalid_native_panels: int = 0
    mvu: MvuInit | None = None
    mvu_public: list[str] = Field(default_factory=list)
    header_pins: list[str] = Field(default_factory=list)
    mvu_legacy: bool = False
    lore_activation: dict[Literal["lore", "worldbook"], dict[str, int]] = Field(default_factory=dict)
    gameplay_pack: GameplayPack | None = None
    legacy_plugins: list[str] = Field(default_factory=list)
    web_panel: WebPanel | None = None
    web_panel_ready: bool = True
    web_panel_issue: OpeningPageIssue | None = None
    legacy_opening_web: LegacyOpeningState | None = None
    legacy_reply_web: LegacyReplyState | None = None
    opening_schema: OpeningSchemaSnapshot | None = None
    scripts: list[CardScript] = Field(default_factory=list)
    script_state: SessionScripts = Field(default_factory=lambda: SessionScripts(clock="turn"))


def library_dir() -> Path:
    return config_dir() / "kohaku-roleplay"


WorldbookSnapshot = tuple[WorldbookReference | None, LoreBook | None]


def resolve_tavern_worldbook(choice: Play) -> WorldbookSnapshot:
    if "worldbookId" not in choice.model_fields_set:
        return default_worldbook_for_play(library_dir(), choice.cardId)
    return worldbook_for_play(library_dir(), choice.worldbookId) if choice.worldbookId is not None else (None, None)


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
        self._committed_prose: str | None = None
        self._restore_feedback: Callable[[], None] | None = None

    async def on_load(self, context: PluginContext) -> None:
        self.binding = context
        self._web_panel_scope = uuid4().hex if self.mode == 'tavern' else ''
        agent = context.host_agent
        if self.mode == 'tavern' and agent is not None:
            self._legacy_reply_capture = LegacyReplyCapture(self._capture_legacy_reply)
            agent.output_router.add_secondary(self._legacy_reply_capture)
        if self.mode != "novel" or agent is None:
            return
        original = agent._collect_and_push_feedback

        async def finish_feedback(controller, handles, handle_order, native_tool_call_ids, native_mode) -> bool:
            # KT 2.2.2 appends native results before draining input and queuing
            # feedback. Keep that settlement; defer queued player turns only
            # when a successful adjudication replaces the model continuation.
            drain, push = agent._drain_mid_turn_pending_inputs, controller.push_event
            owner = current_task()
            settled_prose: str | None = None
            withheld = False

            async def drain_input(active_controller) -> int:
                nonlocal settled_prose
                prose = self._committed_prose
                if current_task() is owner and active_controller is context.controller and prose is not None and handles:
                    if not native_mode or self._has_commit_result(controller.conversation.get_messages(), native_tool_call_ids.values(), prose):
                        settled_prose = prose
                        return 0
                return await drain(active_controller)

            async def push_feedback(event: TriggerEvent) -> None:
                nonlocal withheld
                if current_task() is owner and settled_prose is not None and event.type == "tool_complete":
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
            if not withheld or settled_prose is None:
                return again
            await self._publish_assistant(controller, settled_prose)
            self._committed_prose = None
            return False

        def restore() -> None:
            if agent._collect_and_push_feedback is finish_feedback:
                agent._collect_and_push_feedback = original

        agent._collect_and_push_feedback = finish_feedback
        self._restore_feedback = restore

    @staticmethod
    def _has_commit_result(messages, current_ids, prose: str) -> bool:
        """Match the native result to the current assistant tool announcement."""
        result_ids = set()
        for message in reversed(messages):
            if message.role == "assistant":
                return any(
                    call["id"] in result_ids and call["function"]["name"] == "rp_commit_scene"
                    for call in message.tool_calls or ()
                )
            if message.role == "tool" and message.tool_call_id in current_ids and message.get_text_content() == prose:
                result_ids.add(message.tool_call_id)
        return False

    async def on_event(self, event) -> None:
        if self.mode == "tavern" and event.type == "user_input" and not (event.context or {}).get("rerun"):
            # The host journals a fresh turn before this hook. Migrate old receipts
            # through its predecessor, not through the new input being processed.
            self._upgrade_saved_script_clock(before_current=True)
        if self.mode == "novel" and event.type == "user_input":
            self.can_open_scene = True
            # Never apply an interrupted continuation to a new player turn.
            self._committed_prose = None
        if self.mode == "npc" and event.type == "channel_message" and self.binding is not None:
            raw = event.context.get("raw_content")
            if event.context.get("channel") == self.binding.agent_name and isinstance(raw, str):
                incoming = json.loads(raw)
                if isinstance(incoming, dict) and incoming.get("actor") == self.binding.agent_name and type(incoming.get("scene")) is int:
                    self.binding.set_state("cueScene", incoming["scene"])

    def watch_reports(self, context) -> None:
        group = resolve_group_context(context, require_privileged=False)
        if not self.binding or resolve_group_target(group, "root").agent is not self.binding.host_agent:
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
        slotted = opening.get('message_slot_enabled') is True and has_legacy_message_slot(text)
        if not marked and not slotted and not opening.get('mvu_status_adapter'):
            return
        play = TavernSession.model_validate(record)
        if not marked and not slotted and (not mvu_reply_has_body(text) or not play.mvu or not play.mvu.values
                           or not approved(play.scripts, play.script_state)):
            return
        branch = getattr(agent, '_branch_id', None)
        reply = LegacyReplyState(turn=turn, text=text, values=play.mvu.values if play.mvu else {},
                                 branch=branch if type(branch) is int and branch > 0 else None)
        if reply != play.legacy_reply_web:
            self._save(play.model_copy(update={'legacy_reply_web': reply}).model_dump())
            self.ui_emit('state', self.ui_state())

    async def _web_message_anchor(self, play: TavernSession, message_id: int) -> LegacyMessageAnchor | None:
        reply = play.legacy_reply_web
        binding = self.binding
        token = self._web_panel_scope
        if not binding or not play.legacy_opening_web or not reply or reply.branch is None or reply.turn != message_id:
            return None
        agent, store = binding.host_agent, binding.session_store
        if not agent or not store:
            return None

        def still_current() -> bool:
            return (self.binding is binding and binding.session_store is store and binding.host_agent is agent
                    and self._web_panel_scope == token and not agent.is_processing
                    and self._script_turn_index() == reply.turn and getattr(agent, '_branch_id', None) == reply.branch
                    and (self._record() or {}).get('legacy_reply_web') == reply.model_dump())

        run = getattr(store, 'run', None)
        recent = getattr(store, 'recent_agent_events', None)
        if not callable(run) or not callable(recent) or not still_current():
            return None
        events = await run(recent, binding.agent_name, limit=LEGACY_MESSAGE_EVENT_LIMIT)
        return completed_legacy_message_anchor(reply, events) if still_current() else None

    async def _resolve_message_slot(
        self, locator: LegacyMessageLocator, *, panel_scope: str | None = None
    ) -> tuple[TavernSession, LegacyReplyState] | None:
        if panel_scope is not None and panel_scope != self._web_panel_scope:
            raise OwnerArgumentError('The message slot session changed')
        if not self._web_panel_scope:
            return None
        record = self._record()
        play = TavernSession.model_validate(record) if record is not None else None
        if not play or not play.web_panel or not play.web_panel_ready or not play.legacy_opening_web:
            return None
        legacy, reply = play.legacy_opening_web, play.legacy_reply_web
        if not legacy.message_slot_enabled or reply is None or not has_legacy_message_slot(reply.text):
            return None
        if (reply.turn, reply.branch) != (locator.turn, locator.branchId):
            return None
        if await self._web_message_anchor(play, locator.turn) != locator.model_dump() or self._record() != record:
            return None
        return play, reply

    async def _legacy_message_offer(self, locator: LegacyMessageLocator) -> dict:
        # Discovery never advertises old snapshots with no explicit ready flag.
        if (self._record() or {}).get('web_panel_ready') is not True:
            return {'offer': None}
        resolved = await self._resolve_message_slot(locator)
        if resolved is None or not legacy_slot_options(resolved[1].text):
            return {'offer': None}
        return {'offer': {'mode': LEGACY_MESSAGE_SLOT, 'panelScope': self._web_panel_scope}}

    async def _legacy_message_slot(self, request: LegacyMessageSlotRequest) -> dict:
        if (resolved := await self._resolve_message_slot(request.locator, panel_scope=request.panelScope)) is None:
            return {'slot': None}
        play, reply = resolved
        # Only the compatibility message_id (the tavern turn) goes into the
        # author frame. The scope, branch and two physical event IDs stay with the owner.
        selected = play.mvu_public if play.legacy_opening_web.mvu_read_enabled else []
        return {'slot': LEGACY_MESSAGE_SLOT, **play.web_panel.model_dump(),
                'message': legacy_web_message(reply.turn, reply.text, reply.values, selected)}

    async def _legacy_message_option(self, request: LegacyMessageOptionRequest) -> dict:
        if (resolved := await self._resolve_message_slot(request.locator, panel_scope=request.panelScope)) is None:
            return {'draft': None}
        _, reply = resolved
        options = legacy_slot_options(reply.text)
        if request.optionIndex >= len(options):
            raise OwnerArgumentError('Choose a listed option from the current message')
        return {'draft': options[request.optionIndex]}

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
        if self.mode not in ("tavern", "novel") or "kt_roleplay.choices" not in attached_renderers(context.host_agent):
            return None
        location = "in outcome.prose when committing a scene" if self.mode == "novel" else "after finished prose"
        return ('Optional reader choices ' + location + ': a closed kt_roleplay.choices code fence containing '
                'JSON {"prompt":"…","options":["…","…"]}. Free text remains available.')

    def get_tool_visibility(self, context: PluginContext) -> ToolVisibility | None:
        if self.mode == "tavern":
            record = self._record()
            allowed = {"rp_set_card_state"} if record and record.get("state_fields") else set()
            if record and record.get('gameplay_pack'):
                allowed.update(pack_tools(record, context.host_agent))
            if record and (record.get("mvu") or {}).get("values"):
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
                    allowed = frozenset({"rp_dispatch_scene"})
                elif scene is not None and scene.cues.keys() == scene.reports.keys():
                    allowed = frozenset({"rp_commit_scene"})
        return ToolVisibility(allowed_tools=allowed, allowed_subagents=frozenset())

    async def pre_tool_dispatch(self, call, context: PluginContext):
        visibility = self.get_tool_visibility(context)
        if visibility is not None and call.name not in visibility.allowed_tools:
            raise PluginBlockError(f"Tool {call.name!r} is unavailable to the {self.mode} narrator")
        return None

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
            raise CardScriptError(_SCRIPT_CLOCK_UNAVAILABLE)
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

    async def apply_mvu_changes(self, changes: list[MvuChange]) -> None:
        await self._update_mvu(changes)

    async def apply_mvu_legacy(self, update: str) -> None:
        await self._update_mvu(update)

    async def _update_mvu(self, update: str | list[MvuChange]) -> None:
        async with self._scripts.lock:
            await self._settle_mvu(update)

    async def _settle_mvu(self, update: str | list[MvuChange]) -> None:
        if self.mode != "tavern" or (record := self._record()) is None:
            raise SceneError("Bind a card in a tavern session before changing variables")
        play = TavernSession.model_validate(record)
        settled = await self._prepare_mvu_update(play, record, update)
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

    async def _prepare_mvu_update(self, play: TavernSession, record: dict, update: str | list[MvuChange]) -> TavernSession:
        if play.mvu is None or not play.mvu.values or (isinstance(update, str) and not play.mvu_legacy):
            raise SceneError("This tavern has no initialized variables for this update format")
        try:
            state = upgrade_button_receipts(play.script_state)
            scripts = approved(play.scripts, state) if self._script_turn_index() is not None else []
            # An old diagnostic is not proof of absent listeners: re-probe unknown registrations.
            scripts = [s for s in scripts if state.mvu_listeners.get(s.id, True)]
            if scripts:
                wire = update if isinstance(update, str) else [change.model_dump() for change in update]
                values, notices, added = await to_thread(run_mvu_update, scripts, play.mvu.values, wire, state.appended_buttons)
                if self._record() != record:
                    raise ValueError('The tavern changed during the MVU update; try again')
                state = settled_mvu_scripts(state, notices, added)
            elif isinstance(update, str):
                values = apply_literal_update(play.mvu.values, update)
            else:
                values = apply_changes(play.mvu.values, update)
        except ValueError as exc:
            raise SceneError(str(exc)) from exc
        mvu = play.mvu.model_copy(update={"values": values})
        return play.model_copy(update={'mvu': mvu, 'script_state': state})

    async def _derive_opening_schema(self, play: TavernSession, schema: OpeningSchemaSnapshot) -> TavernSession:
        if play.mvu is None:
            raise SceneError('An opening schema needs initialized variables')
        value = await to_thread(derive_opening_schema, schema.code, play.mvu.values, schema.grant)
        return play.model_copy(update={'opening_schema': schema.model_copy(update={'value': value})})

    @staticmethod
    def _opening_schema_visible(play: TavernSession, values: dict[str, JsonValue]) -> bool:
        legacy = play.legacy_opening_web
        # Both the derived value and the outcome of a write can depend on any input.
        return bool(legacy and legacy.counter and legacy.counter.public_id() in play.mvu_public
                    and json_equal(values, selected_message_values(values, play.mvu_public)))

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

    def save_story(self, story: Story) -> None:
        if self.mode != "novel" or self.binding is None:
            raise ValueError("Only the director may adjudicate")
        self.can_open_scene = False
        self._save(story.model_dump())
        self.ui_emit("state", self.ui_state())

    def save_adjudication(self, context: ToolContext, story: Story, outcome: Outcome) -> None:
        """Commit the world and addressed NPC memories without waking a creature."""
        group = resolve_group_context(context)
        director = self.binding
        if self.mode != "novel" or director is None or director.host_agent is not group.caller.agent:
            raise SceneError("Only the bound director can commit an adjudication")
        store = director.session_store
        if store is None:
            raise SceneError("A persistent novel session is required")
        story = self.novel.apply_fields(director, story, outcome)
        rows = [(director._state_key("novel"), story.model_dump())]
        for actor in outcome.private_updates.keys() | outcome.card_updates.keys():
            target = resolve_group_target(group, actor)
            plugin = target.agent.plugins.get_plugin("roleplay")
            binding = plugin.binding if isinstance(plugin, RoleplayPlugin) else None
            if binding is None or plugin.mode != "npc" or binding.session_store is not store or binding.agent_name != actor:
                raise SceneError(f"Cannot deliver an adjudication to the session of {actor!r}")
            if actor in outcome.private_updates:
                receipt = {"throughScene": story.completed, "known": story.knowledge[actor]}
                rows.append((binding._state_key("privateKnowledge"), receipt))
            if actor in outcome.card_updates:
                rows.append((binding._state_key("fieldValues"), story.card_values[actor]))
        store.state.put_many(rows)
        self._committed_prose = story.latest_prose
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
            return self.novel.view(self.binding)
        record = self._record()
        if record is None:
            return {"mode": self.mode, "active": False}
        if self.mode == "persona":
            return {"mode": self.mode, "active": True, **Attach.model_validate(record).model_dump()}
        play = TavernSession.model_validate(record)
        view = {"mode": self.mode, "active": True, "cardId": play.cardId, "name": play.card.name,
                "player": play.player.model_dump(), "greeting": play.greeting, "greetingIndex": play.greetingIndex,
                "openingSent": play.openingSent, "hasPortrait": play.hasPortrait, "notes": play.notes,
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
                    if (play.legacy_opening_web.message_slot_enabled and self._web_panel_scope
                            and has_legacy_message_slot(play.legacy_reply_web.text)):
                        view['webPanel']['messageSlot'] = {'mode': LEGACY_MESSAGE_SLOT, 'panelScope': self._web_panel_scope,
                                                          'turn': play.legacy_reply_web.turn, 'branchId': play.legacy_reply_web.branch}
        elif play.web_panel_issue is not None:
            view['webPanelIssue'] = play.web_panel_issue
        if play.scripts:
            host_ok = self._script_turn_index() is not None
            issues = play.script_state.issues if host_ok else {**play.script_state.issues, "$host": _SCRIPT_CLOCK_UNAVAILABLE}
            runnable = {s.id for s in approved(play.scripts, play.script_state)} if host_ok else set()
            views = [s.view() if s.id not in runnable else {
                **s.view(), 'buttons': visible_script_buttons(s, play.script_state.appended_buttons.get(s.id, [])),
            } for s in play.scripts]
            view["cardScripts"] = {"entries": views,
                                   "canEnable": host_ok and play.opening_schema is None and bool(play.mvu and play.mvu.values and any(
                                       s.enabled and (s.issue is None or s.issue in RETRYABLE_MODULE_ISSUES) for s in play.scripts)),
                                   "enabled": bool(runnable),
                                   "issues": issues, 'inactiveEvents': play.script_state.inactive_events}
        selected = chosen_key(play.portrait_rules, play.state_fields, play.values)
        if selected is not None:
            view.update(hasPortrait=True, portraitKey=selected)
        if play.scene_media_rules:
            selected_scene = chosen_key(play.scene_media_rules, play.state_fields, play.values)
            view["sceneMediaKey"] = selected_scene or next((asset.key for asset in play.media if asset.kind == "icon"), None)
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
            if action == "resume_scene" and self.mode == "novel":
                number = args.get("scene")
                if type(number) is not int or set(args) != {"scene"}:
                    raise OwnerArgumentError("Expected the current numeric scene identifier")
                await resume_scene(self, number)
                return self.ui_state()
            if action == "cards" and self.mode in ("persona", "tavern"):
                return cards_view(library_dir())
            if action == 'card_web_message_offer' and self.mode == 'tavern':
                if set(args) != {'locator'}:
                    raise OwnerArgumentError('Expected only the trusted message locator')
                return await self._legacy_message_offer(LegacyMessageLocator.model_validate(args['locator']))
            if action == 'card_web_message_slot' and self.mode == 'tavern':
                return await self._legacy_message_slot(LegacyMessageSlotRequest.model_validate(args))
            if action == 'card_web_message_option' and self.mode == 'tavern':
                return await self._legacy_message_option(LegacyMessageOptionRequest.model_validate(args))
            if action in ('card_web_panel', 'card_web_state', 'card_web_gameplay', 'card_web_plugin_request',
                          'card_web_message_anchor', 'card_web_mvu_counter') and self.mode == 'tavern':
                record = self._record()
                play = TavernSession.model_validate(record) if record is not None else None
                if play is None or play.web_panel is None or not play.web_panel_ready or not self._web_panel_scope:
                    raise OwnerArgumentError('This tavern has no ready card web panel')
                if action == 'card_web_panel':
                    if args:
                        raise OwnerArgumentError('The card web panel does not take arguments')
                    panel = {**play.web_panel.model_dump(), 'panelScope': self._web_panel_scope}
                    if legacy := play.legacy_opening_web:
                        panel['legacyOpening'] = self._opening_web_message(play, legacy.values)
                        panel['legacyMarker'] = legacy.marker
                        if self._opening_counter_value(play) is not None and play.mvu and legacy.counter:
                            panel['legacyOpening'] = self._opening_web_message(play, play.mvu.values)
                            panel['legacyMvuCounter'] = {'messageId': 0, **legacy.counter.model_dump(),
                                                         'revision': legacy.counter_revision}
                        if latest := play.legacy_reply_web:
                            panel['legacyLatest'] = legacy_web_message(latest.turn, latest.text, latest.values, play.mvu_public)
                        if legacy.mvu_read_enabled and any(
                            panel[key]['data']['stat_data'] for key in ('legacyOpening', 'legacyLatest') if key in panel
                        ):
                            panel['legacyMvuRead'] = {'mode': 'kt-message-stat-data-v1'}
                    return panel
                if args.get('panelScope') != self._web_panel_scope:
                    raise OwnerArgumentError('The card web panel session changed; open the panel again')
                payload = {key: value for key, value in args.items() if key != 'panelScope'}
                if action == 'card_web_mvu_counter':
                    return await self._write_opening_counter(OpeningCounterWrite.model_validate(payload), self._web_panel_scope)
                if action == 'card_web_message_anchor':
                    message_id = payload.get('messageId')
                    if set(payload) != {'messageId'} or type(message_id) is not int or message_id < 1:
                        raise OwnerArgumentError('Choose the current completed card web reply')
                    return {'anchor': await self._web_message_anchor(play, message_id)}
                if action == 'card_web_plugin_request':
                    call = LegacyWebRequest.model_validate(payload).to_plugin_request()
                    if play.legacy_opening_web is not None and call.method != 'GET':
                        raise OwnerArgumentError('The legacy opening page is read-only')
                    return await self._request_legacy_plugin(call, self._web_panel_scope)
                if action == 'card_web_gameplay':
                    if play.legacy_opening_web is not None:
                        raise OwnerArgumentError('The legacy opening page is read-only')
                    agent = self.binding.host_agent if self.binding else None
                    if agent and agent.is_processing:
                        raise OwnerArgumentError('Wait for this tavern before using a card web action')
                    self.apply_gameplay_actions(Actions.model_validate(payload).actions)
                    play = TavernSession.model_validate(self._record())
                elif payload:
                    raise OwnerArgumentError('The card web state does not take arguments')
                return {'fields': public_fields(play.state_fields, play.values),
                        'panels': public_panels(play.native_panels, play.state_fields, play.values),
                        'mvu': public_values(play.mvu.values, play.mvu_public) if play.mvu else []}
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
                if args['enabled'] and play.opening_schema:
                    raise OwnerArgumentError('This opening schema profile runs separately from ordinary card scripts')
                if args["enabled"] and self._script_turn_index() is None:
                    raise OwnerArgumentError(_SCRIPT_CLOCK_UNAVAILABLE)
                if args["enabled"]:
                    if not play.mvu or not play.mvu.values:
                        raise _card_scripts_unavailable(play.scripts, play.mvu)
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
                        raise _card_scripts_unavailable(play.scripts, play.mvu)
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
            if action in ("detail", "portrait") and self.mode != "npc":
                key = args.get("id")
                if not isinstance(key, str) or not key:
                    raise OwnerArgumentError("A card id is required")
                if self.mode == "novel" and (action != "portrait" or key not in {m.cardId for m in self.novel.members(self.binding)}):
                    raise OwnerArgumentError("The reader can only request portraits from this cast")
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
                greetings = [card.fields.first_mes, *card.fields.alternate_greetings]
                if choice.greetingIndex >= len(greetings):
                    raise OwnerArgumentError("Opening index is out of range")
                book_ref, book = prepared_worldbook if prepared_worldbook is not None else resolve_tavern_worldbook(choice)
                lore = card.lore
                mvu = inspect_initializers(card.book)
                if mvu is not None and lore is not None:
                    lore = lore.model_copy(update={"entries": [
                        entry.model_copy(update={"enabled": False}) if is_initializer(entry.comment, entry.name) else entry
                        for entry in lore.entries
                    ]})
                opening = greetings[choice.greetingIndex]
                legacy_mvu = False
                block = None
                if mvu is not None and mvu.values:
                    prose, block = split_opening(opening)
                    directions = [card.fields.mes_example, card.fields.system_prompt, card.fields.post_history_instructions]
                    if lore is not None:
                        directions.extend(entry.content for entry in lore.entries if entry.enabled)
                    legacy_mvu = block is not None or any(
                        "<UpdateVariable>" in text and ("_." in text or "<JSONPatch>" in text) for text in directions
                    )
                    if block is not None:
                        opening = prose
                script_host_ok = self._script_turn_index() is not None
                scripts = card.scripts
                enable_requested = (choice.enableCardScripts if "enableCardScripts" in choice.model_fields_set
                                    else script_host_ok and bool(mvu and mvu.values) and any(s.enabled for s in scripts)
                                    and card_scripts_default(library_dir()))
                if enable_requested and script_host_ok and mvu and mvu.values:
                    scripts = await to_thread(link_card_scripts, library_dir(), choice.cardId, scripts)
                    check_opening_target()
                script_card_ok = bool(mvu and mvu.values and any(s.enabled and not s.issue for s in scripts))
                if choice.enableCardScripts and not script_host_ok:
                    raise OwnerArgumentError(_SCRIPT_CLOCK_UNAVAILABLE)
                if choice.enableCardScripts and not script_card_ok:
                    raise _card_scripts_unavailable(scripts, mvu)
                enable_scripts = enable_requested and script_host_ok and script_card_ok
                script_state = SessionScripts(clock="turn", approved=script_fingerprint(scripts) if enable_scripts else None,
                                              button_receipts_current=True)
                if block is not None:
                    try:
                        if enable_scripts:
                            values, notices, added = await to_thread(run_mvu_update, approved(scripts, script_state), mvu.values,
                                                                     block, script_state.appended_buttons)
                            script_state = settled_mvu_scripts(script_state, notices, added)
                        else:
                            values = apply_literal_update(mvu.values, block)
                        mvu = mvu.model_copy(update={'values': values})
                    except (ValueError, RecursionError):
                        mvu = mvu.model_copy(update={'issues': {**mvu.issues, 'invalid_opening_update': 1}})
                    check_opening_target()
                web_panel, legacy_state, web_panel_issue = card.web_panel, None, None
                if web_panel is None:
                    rule = next((row for row in card.legacy_web_rules if row.marker in opening), None)
                    marker, mvu_read_enabled, message_slot_enabled = None, False, False
                    if rule is not None:
                        web_panel, marker = rule.panel, rule.marker
                    elif (remote := card.legacy_remote_opening) is not None and remote.marker in opening:
                        web_panel, web_panel_issue, linked = await to_thread(
                            cached_opening_panel, library_dir(), choice.cardId, remote,
                            allow_modules=choice.enableOpeningModules, runtime=choice.openingPageRuntime,
                            require_linked=choice.enableOpeningMvuRead,
                        )
                        check_opening_target()
                        marker = remote.marker
                        mvu_read_enabled = choice.enableOpeningMvuRead
                        message_slot_enabled = linked and (
                            'legacyMessageSlot' not in choice.model_fields_set or choice.legacyMessageSlot == LEGACY_MESSAGE_SLOT
                        )
                    if web_panel is not None and marker is not None:
                        legacy_state = LegacyOpeningState(marker=marker, values={},
                                                          mvu_status_adapter=has_mvu_status_adapter(marker, card.scripts),
                                                          mvu_read_enabled=mvu_read_enabled,
                                                          message_slot_enabled=message_slot_enabled)
                if counter := choice.openingMvuCounter:
                    if not legacy_state or not legacy_state.mvu_read_enabled or not mvu or counter.current(mvu.values) is None:
                        raise OwnerArgumentError('Choose an existing initialized integer in the linked opening for this counter')
                    legacy_state = legacy_state.model_copy(update={'counter': counter})
                schema = None
                if grant := choice.openingMvuSchema:
                    if mvu is None or legacy_state is None:
                        raise OwnerArgumentError('The schema needs an initialized linked opening')
                    try:
                        code = await to_thread(link_opening_schema, library_dir(), choice.cardId, card.scripts, grant)
                    except ModuleLinkError as exc:
                        raise OwnerArgumentError(f'Opening MVU schema: {exc}') from exc
                    value = await to_thread(derive_opening_schema, code, mvu.values, grant)
                    check_opening_target()
                    schema = OpeningSchemaSnapshot(grant=grant, code=code, value=value)
                play = TavernSession(cardId=choice.cardId, card=card.fields, player=choice.player,
                                     greeting=expand(opening, card.fields.name, choice.player.name, ""),
                                     lore=lore, worldbook=book, worldbookRef=book_ref, notes="", greetingIndex=choice.greetingIndex, hasPortrait=card.portrait is not None,
                                     portrait_rules=rules_for(card.portraits), state_fields=card.state_fields,
                                     media=card.media, media_issues=card.media_issues,
                                     scene_media_rules=card.scene_media_rules, native_panels=card.native_panels,
                                     invalid_native_panels=card.invalid_native_panels, mvu=mvu, mvu_legacy=legacy_mvu,
                                     gameplay_pack=card.gameplay_pack, web_panel=web_panel, web_panel_ready=web_panel is None,
                                     web_panel_issue=web_panel_issue, legacy_opening_web=legacy_state,
                                     scripts=scripts, script_state=script_state, opening_schema=schema)
                self._save(play.model_dump())
                if enable_scripts:
                    await self._scripts.fire("opening", sequence=0)
                changes = {'web_panel_ready': True} if web_panel is not None else {}
                if play.greeting:
                    if legacy_state is not None:
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

    async def publish_opening(self, text: str) -> None:
        if self.binding is None or self.binding.controller is None:
            raise OwnerArgumentError("Publishing requires a live controller")
        controller = self.binding.controller
        agent = self.binding.host_agent
        history = getattr(agent, "_session_output", None)
        if history is None:
            await self._publish_assistant(controller, text)
            return

        # KT 2.2.2 treats every live text frame as model streaming, and a
        # synthetic processing_end would also activate Studio's summary hook.
        # Persist the opening first, then refresh attached chats as already idle.
        from kohakuterrarium.studio.attach._event_stream import StreamOutput

        await self.binding.emit(OutputEvent(type="assistant_round_start"))
        message = controller.conversation.append("assistant", text)
        await history.emit(OutputEvent(type="text", content=text))
        await self.binding.emit(OutputEvent(type="assistant_message", payload={"message": message.to_dict()}))
        await history.drain()
        if not agent.is_processing:
            for output in agent.output_router._secondary_outputs:
                if isinstance(output, StreamOutput):
                    output._put({"type": "idle"})

    async def _publish_assistant(self, controller, text: str) -> None:
        await self.binding.emit(OutputEvent(type="assistant_round_start"))
        message = controller.conversation.append("assistant", text)
        await self.binding.emit(OutputEvent(type="text", content=text))
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
        active = self._script_turn()
        if active is None or not response.strip():
            return
        controller, turn = active
        message = controller._completed_assistant_message
        history = controller.conversation.get_messages()
        if message is not None and history and history[-1] is message and not message.tool_calls:
            await self._scripts.fire("assistant", sequence=turn, args={"text": response[:900]})

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
            content = self.novel.prompt(self.binding)
        elif record is None:
            return None
        elif self.mode == "persona":
            content = persona_context(Attach.model_validate(record).persona)
        else:
            play = TavernSession.model_validate(record)
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
            content = story_context(play.card, play.player, entries, play.notes)
            messages = insert_depth_lore(messages, entries, play.card, play.player)
            if play.state_fields:
                content += ("\nUse rp_set_card_state for changed declared fields only. Settle independent in-world actions "
                            "in separate tool calls, even in the same turn. Group only steps that must succeed together. "
                            "Do not replay successful calls if a different call fails. Keep private fields out of prose.\n"
                            + json.dumps(model_fields(play.state_fields, play.values), ensure_ascii=False))
            gameplay = public_panels([panel for panel in play.native_panels if isinstance(panel, (InventoryPanel, QuestPanel))],
                                     play.state_fields, play.values)
            if gameplay:
                content += ("\nFor an inventory or quest action, use rp_apply_gameplay with these panel IDs; "
                            "do not replace inventory contents or set a quest to its completed value through rp_set_card_state.\n" + json.dumps(gameplay, ensure_ascii=False))
            if play.mvu is not None and play.mvu.values:
                content += ("\nThese are initialized variables in the current fictional session only. Use rp_update_mvu to "
                            "record only justified changes. Variables not selected for display are private; do not copy "
                            "their values into prose.\n" + json.dumps({"mvu_variables": play.mvu.values,
                                                                       "mvu_displayed_paths": [json.loads(key) for key in play.mvu_public]},
                                                                      ensure_ascii=False))
            if play.script_state.approved and self._script_turn_index() is not None:
                script_choices = [{"id": script.id, "name": script.name} for script in approved(play.scripts, play.script_state)]
                if script_choices:
                    content += "\nOnly use rp_run_card_script for a justified action with a registered ID from this list:\n" + json.dumps(script_choices, ensure_ascii=False)
            if play.mvu_legacy:
                content += "\nIf the card requests a literal <UpdateVariable> block, call rp_apply_mvu_update instead of printing the block. Do not apply the same change through both update tools."
            if books and self.binding:
                lore_view = {"totalEntries": sum(len(book.entries) for book in books), "activeTitles": [e.name or e.comment or ", ".join(e.keys) for e in entries], "usedTokens": allowance - remaining, "budgetTokens": min(allowance, sum(book.token_budget for book in books))}
                if template_failures:
                    lore_view['templateFailures'] = template_failures
                if self.binding.get_state("loreView") != lore_view:
                    self.binding.set_state("loreView", lore_view)
                    self.ui_emit("state", self.ui_state())
        index = next((i for i, message in enumerate(messages) if message.get("role") not in ("system", "developer")), len(messages))
        return [*messages[:index], {"role": "user", "content": content}, *messages[index:]]
