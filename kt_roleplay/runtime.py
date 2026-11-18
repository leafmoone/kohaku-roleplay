"""Bind confirmed character data to a live KT creature without mutating its config."""

from asyncio import current_task, to_thread
from collections.abc import Callable
import json
from pathlib import Path
from typing import Literal

from kohakuterrarium.builtins.plugins.ui_declarative.plugin import attached_renderers
from kohakuterrarium.modules.output.event import OutputEvent
from kohakuterrarium.core.events import TriggerEvent
from kohakuterrarium.modules.tool.base import ToolContext
from kohakuterrarium.terrarium.tools.context import resolve_group_context, resolve_group_target
from pydantic import TypeAdapter

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from kohakuterrarium.core.conversation.elide import TOOL_FEEDBACK_KIND, estimate_message_tokens
from kohakuterrarium.llm.message import UserMessage
from kohakuterrarium.modules.plugin.base import BasePlugin, PluginBlockError, PluginContext, ToolVisibility
from kohakuterrarium.modules.ui_owner import OwnerArgumentError, OwnerForbiddenError
from kohakuterrarium.utils.config_dir import config_dir

from .cards import CardError, CardFields
from .charx import CardMedia
from .cast import NovelBinding
from .gameplay import Action, PlayActions, apply_actions
from .novel import Outcome, SceneError, Story
from .card_state import FieldUpdate, StateField, Value, model_fields, public_fields, update_values
from .state_tool import SetCardState
from .portraits import PortraitRule, chosen_key, rules_for
from .library_view import card_detail, cards_view, media_summary, media_view, portrait_view
from .library import CardNotFound, get_card
from .lore import LoreBook, active_entries
from .mvu import MvuChange, MvuInit, apply_changes, inspect_initializers, is_initializer, public_options, public_values
from .mvu_legacy import apply_literal_update, split_opening
from .mvu_tool import ApplyMvuUpdate, UpdateMvu
from .panels import ChoicePanel, InventoryPanel, NativePanel, QuestPanel, public_panels
from .projections import Persona, Player, expand, insert_depth_lore, persona_context, render_tavern_text, story_context
from .worldbook import read_worldbook
from .scene_tools import ingest_report
from .recovery import resume_scene


class Arguments(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


class Attach(Arguments):
    cardId: str
    persona: Persona


class Play(Arguments):
    cardId: str
    player: Player
    greetingIndex: int = Field(ge=0)


class Notes(Arguments):
    notes: str


class MvuSelection(Arguments):
    ids: list[str] = Field(max_length=128)


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
    notes: str
    media: list[CardMedia] = Field(default_factory=list)
    media_issues: dict[str, int] = Field(default_factory=dict)
    scene_media_rules: list[PortraitRule] = Field(default_factory=list)
    native_panels: list[NativePanel] = Field(default_factory=list)
    invalid_native_panels: int = 0
    mvu: MvuInit | None = None
    mvu_public: list[str] = Field(default_factory=list)
    mvu_legacy: bool = False


def library_dir() -> Path:
    return config_dir() / "kohaku-roleplay"


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
        self.report_watch = None
        self.can_open_scene = False
        self._committed_prose: str | None = None
        self._restore_feedback: Callable[[], None] | None = None

    async def on_load(self, context: PluginContext) -> None:
        self.binding = context
        agent = context.host_agent
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

    async def on_unload(self) -> None:
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
            if record and (record.get("mvu") or {}).get("values"):
                allowed.add("rp_update_mvu")
                if record.get("mvu_legacy"):
                    allowed.add("rp_apply_mvu_update")
            if record and any(p.get("type") in ("inventory", "quest") for p in record.get("native_panels", [])):
                allowed.add("rp_apply_gameplay")
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
            return [SetCardState(self), UpdateMvu(self), ApplyMvuUpdate(self), PlayActions(self)]
        return self.novel.tools(self) if self.novel else []

    def apply_card_changes(self, changes: list[FieldUpdate]) -> None:
        if self.mode != "tavern" or self._record() is None:
            raise SceneError("Bind a card in a tavern session before changing state")
        play = TavernSession.model_validate(self._record())
        values = update_values(play.state_fields, play.values, changes)
        self._save(play.model_copy(update={"values": values}).model_dump())
        self.ui_emit("state", self.ui_state())

    def apply_gameplay_actions(self, actions: list[Action]) -> None:
        if self.mode != "tavern" or (record := self._record()) is None:
            raise SceneError("Bind a tavern card before applying a gameplay action")
        play = TavernSession.model_validate(record)
        try:
            values = apply_actions(play.native_panels, play.state_fields, play.values, actions)
        except ValueError as exc:
            raise SceneError(str(exc)) from exc
        self._save(play.model_copy(update={"values": values}).model_dump())
        self.ui_emit("state", self.ui_state())

    def apply_mvu_changes(self, changes: list[MvuChange]) -> None:
        self._update_mvu(lambda values: apply_changes(values, changes))

    def apply_mvu_legacy(self, update: str) -> None:
        self._update_mvu(lambda values: apply_literal_update(values, update), legacy=True)

    def _update_mvu(self, calculate, *, legacy: bool = False) -> None:
        if self.mode != "tavern" or (record := self._record()) is None:
            raise SceneError("Bind a card in a tavern session before changing variables")
        play = TavernSession.model_validate(record)
        if play.mvu is None or not play.mvu.values or (legacy and not play.mvu_legacy):
            raise SceneError("This tavern has no initialized variables for this update format")
        try:
            values = calculate(play.mvu.values)
        except ValueError as exc:
            raise SceneError(str(exc)) from exc
        mvu = play.mvu.model_copy(update={"values": values})
        self._save(play.model_copy(update={"mvu": mvu}).model_dump())
        self.ui_emit("state", self.ui_state())

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
                "worldbookDiagnostics": play.worldbook.diagnostics() if play.worldbook else None,
                "cardLoreDiagnostics": play.lore.diagnostics() if play.lore else None,
                "lore": self.binding.get_state("loreView") if self.binding else None,
                "media": media_summary(play.media), "mediaIssues": play.media_issues}
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
        return view

    async def ui_call(self, action: str, args: dict[str, object], context) -> dict[str, object]:
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
            if action == "set_mvu_public" and self.mode == "tavern" and (record := self._record()) is not None:
                selection = MvuSelection.model_validate(args).ids
                play = TavernSession.model_validate(record)
                if play.mvu is None or len(selection) != len(set(selection)) or not set(selection).issubset(
                    item["id"] for item in public_options(play.mvu.values)
                ):
                    raise OwnerArgumentError("Choose existing variable paths only")
                self._save(play.model_copy(update={"mvu_public": selection}).model_dump())
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
                card = get_card(library_dir(), choice.cardId)
                greetings = [card.fields.first_mes, *card.fields.alternate_greetings]
                if choice.greetingIndex >= len(greetings):
                    raise OwnerArgumentError("Opening index is out of range")
                lore = card.lore
                mvu = inspect_initializers(card.book)
                if mvu is not None and lore is not None:
                    lore = lore.model_copy(update={"entries": [
                        entry.model_copy(update={"enabled": False}) if is_initializer(entry.comment, entry.name) else entry
                        for entry in lore.entries
                    ]})
                opening = greetings[choice.greetingIndex]
                legacy_mvu = False
                if mvu is not None and mvu.values:
                    prose, block = split_opening(opening)
                    directions = [card.fields.mes_example, card.fields.system_prompt, card.fields.post_history_instructions]
                    if lore is not None:
                        directions.extend(entry.content for entry in lore.entries if entry.enabled)
                    legacy_mvu = block is not None or any("<UpdateVariable>" in text and "_." in text for text in directions)
                    if block is not None:
                        opening = prose
                        try:
                            mvu = mvu.model_copy(update={"values": apply_literal_update(mvu.values, block)})
                        except (ValueError, RecursionError):
                            mvu = mvu.model_copy(update={"issues": {**mvu.issues, "invalid_opening_update": 1}})
                play = TavernSession(cardId=choice.cardId, card=card.fields, player=choice.player,
                                     greeting=expand(opening, card.fields.name, choice.player.name, ""),
                                     lore=lore, notes="", greetingIndex=choice.greetingIndex, hasPortrait=card.portrait is not None,
                                     portrait_rules=rules_for(card.portraits), state_fields=card.state_fields,
                                     media=card.media, media_issues=card.media_issues,
                                     scene_media_rules=card.scene_media_rules, native_panels=card.native_panels,
                                     invalid_native_panels=card.invalid_native_panels, mvu=mvu, mvu_legacy=legacy_mvu)
                self._save(play.model_dump())
                if play.greeting:
                    await self.publish_opening(play.greeting)
                    latest = TavernSession.model_validate(self._record())
                    self._save(latest.model_copy(update={"openingSent": True}).model_dump())
            elif action == "set_worldbook" and self.mode == "tavern" and self._record() is not None:
                if "book" not in args or (args["book"] is not None and not isinstance(args["book"], dict)):
                    raise OwnerArgumentError("Expected a world-info object or null to remove the book")
                existing = TavernSession.model_validate(self._record())
                book = read_worldbook(args["book"]) if args["book"] is not None else None
                self._save(existing.model_copy(update={"worldbook": book}).model_dump())
                self.binding.set_state("loreView", None)
            elif action == "set_notes" and self.mode == "tavern" and self._record() is not None:
                existing = TavernSession.model_validate(self._record())
                self._save(existing.model_copy(update=Notes.model_validate(args).model_dump()).model_dump())
            else:
                raise OwnerArgumentError(f"Action {action!r} is not available in the current {self.mode} session")
        except (ValidationError, CardError, CardNotFound, SceneError) as exc:
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

    async def pre_llm_call(self, messages: list[dict], **kwargs: object) -> list[dict] | None:
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
            books = [book for book in (play.lore, play.worldbook) if book is not None]
            chat_count = None
            if any(entry.delay_messages for book in books for entry in book.entries):
                host = self.binding.host_agent if self.binding else None
                if host and host.controller:
                    chat_count = sum(
                        message.role in ("user", "assistant") and bool(message.content)
                        and (message.metadata or {}).get("kind") != TOOL_FEEDBACK_KIND
                        for message in host.controller.conversation.get_messages()
                    )
            entries = []
            remaining = 2048

            def lore_cost(text: str) -> int:
                return _cost(render_tavern_text(text, play.card, play.player))

            for book in books:
                chosen = active_entries(book, history, lore_cost, remaining, chat_messages=chat_count)
                entries.extend(chosen)
                remaining -= sum(lore_cost(e.content) for e in chosen)
            content = story_context(play.card, play.player, entries, play.notes)
            messages = insert_depth_lore(messages, entries, play.card, play.player)
            if play.state_fields:
                content += "\nUse rp_set_card_state for changed declared fields only. Keep private fields out of prose.\n" + json.dumps(model_fields(play.state_fields, play.values), ensure_ascii=False)
            gameplay = public_panels([panel for panel in play.native_panels if isinstance(panel, (InventoryPanel, QuestPanel))],
                                     play.state_fields, play.values)
            if gameplay:
                content += ("\nFor an inventory or quest action, use rp_apply_gameplay with these panel IDs; "
                            "do not repeat it through rp_set_card_state.\n" + json.dumps(gameplay, ensure_ascii=False))
            if play.mvu is not None and play.mvu.values:
                content += ("\nThese are initialized variables in the current fictional session only. Use rp_update_mvu to "
                            "record only justified changes. Variables not selected for display are private; do not copy "
                            "their values into prose.\n" + json.dumps({"mvu_variables": play.mvu.values,
                                                                       "mvu_displayed_paths": [json.loads(key) for key in play.mvu_public]},
                                                                      ensure_ascii=False))
            if play.mvu_legacy:
                content += "\nIf the card requests literal <UpdateVariable> commands, call rp_apply_mvu_update instead of printing the block. Do not apply the same change through both update tools."
            if books and self.binding:
                lore_view = {"totalEntries": sum(len(book.entries) for book in books), "activeTitles": [e.name or e.comment or ", ".join(e.keys) for e in entries], "usedTokens": 2048 - remaining, "budgetTokens": min(2048, sum(book.token_budget for book in books))}
                if self.binding.get_state("loreView") != lore_view:
                    self.binding.set_state("loreView", lore_view)
                    self.ui_emit("state", self.ui_state())
        index = next((i for i, message in enumerate(messages) if message.get("role") not in ("system", "developer")), len(messages))
        return [*messages[:index], {"role": "user", "content": content}, *messages[index:]]
