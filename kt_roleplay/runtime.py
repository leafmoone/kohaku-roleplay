"""Bind confirmed character data to a live KT creature without mutating its config."""

import json
from pathlib import Path
from typing import Literal

from kohakuterrarium.builtins.plugins.ui_declarative.plugin import attached_renderers
from kohakuterrarium.modules.output.event import OutputEvent
from kohakuterrarium.modules.tool.base import ToolContext
from kohakuterrarium.terrarium.tools.context import resolve_group_context, resolve_group_target
from pydantic import TypeAdapter

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from kohakuterrarium.core.conversation.elide import estimate_message_tokens
from kohakuterrarium.llm.message import UserMessage
from kohakuterrarium.modules.plugin.base import BasePlugin, PluginBlockError, PluginContext, ToolVisibility
from kohakuterrarium.modules.ui_owner import OwnerArgumentError, OwnerForbiddenError
from kohakuterrarium.utils.config_dir import config_dir

from .cards import CardError, CardFields
from .cast import NovelBinding
from .novel import SceneError, Story
from .library_view import card_detail, cards_view, portrait_view
from .library import CardNotFound, get_card
from .lore import LoreBook, active_entries, load_book
from .projections import Persona, Player, expand, persona_context, story_context
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


class TavernSession(Arguments):
    cardId: str
    card: CardFields
    player: Player
    greeting: str
    greetingIndex: int = 0
    openingSent: bool = False
    hasPortrait: bool = False
    lore: LoreBook | None
    worldbook: LoreBook | None = None
    notes: str


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

    async def on_load(self, context: PluginContext) -> None:
        self.binding = context

    async def on_event(self, event) -> None:
        if self.mode == "novel" and event.type == "user_input":
            self.can_open_scene = True
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

    def presentation_contribution(self, context: PluginContext) -> str | None:
        if self.mode not in ("tavern", "novel") or "kt_roleplay.choices" not in attached_renderers(context.host_agent):
            return None
        return 'Optional reader choices after finished prose: a closed kt_roleplay.choices code fence containing JSON {"prompt":"…","options":["…","…"]}. Free text remains available.'

    def get_tool_visibility(self, context: PluginContext) -> ToolVisibility | None:
        if self.mode == "tavern":
            return ToolVisibility(allowed_tools=frozenset(), allowed_subagents=frozenset())
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
        return self.novel.tools(self) if self.novel else []

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

    def save_adjudication(self, context: ToolContext, story: Story, recipients: tuple[str, ...]) -> None:
        """Commit the world and addressed NPC memories without waking a creature."""
        group = resolve_group_context(context)
        director = self.binding
        if self.mode != "novel" or director is None or director.host_agent is not group.caller.agent:
            raise SceneError("Only the bound director can commit an adjudication")
        store = director.session_store
        if store is None:
            raise SceneError("A persistent novel session is required")
        rows = [(director._state_key("novel"), story.model_dump())]
        for actor in recipients:
            target = resolve_group_target(group, actor)
            plugin = target.agent.plugins.get_plugin("roleplay")
            binding = plugin.binding if isinstance(plugin, RoleplayPlugin) else None
            if binding is None or plugin.mode != "npc" or binding.session_store is not store or binding.agent_name != actor:
                raise SceneError(f"Cannot deliver an adjudication to the session of {actor!r}")
            receipt = {"throughScene": story.completed, "known": story.knowledge[actor]}
            rows.append((binding._state_key("privateKnowledge"), receipt))
        store.state.put_many(rows)
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
        return {"mode": self.mode, "active": True, "cardId": play.cardId, "name": play.card.name, "player": play.player.model_dump(), "greeting": play.greeting, "greetingIndex": play.greetingIndex, "openingSent": play.openingSent, "hasPortrait": play.hasPortrait, "notes": play.notes, "worldbookEntries": len(play.worldbook.entries) if play.worldbook else None, "lore": self.binding.get_state("loreView") if self.binding else None}

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
            if action in ("detail", "portrait") and self.mode != "npc":
                key = args.get("id")
                if not isinstance(key, str) or not key:
                    raise OwnerArgumentError("A card id is required")
                if self.mode == "novel" and (action != "portrait" or key not in {m.cardId for m in self.novel.members(self.binding)}):
                    raise OwnerArgumentError("The reader can only request portraits from this cast")
                return card_detail(library_dir(), key) if action == "detail" else portrait_view(library_dir(), key)
            if action == "apply_persona" and self.mode == "persona":
                request = Attach.model_validate(args)
                get_card(library_dir(), request.cardId)
                self._save(request.model_dump())
            elif action == "remove_persona" and self.mode == "persona":
                self._save(None)
            elif action == "start_tavern" and self.mode == "tavern":
                if self._record() is not None:
                    raise OwnerArgumentError("This session already has an opening; start a new session for another game")
                choice = Play.model_validate(args)
                card = get_card(library_dir(), choice.cardId)
                greetings = [card.fields.first_mes, *card.fields.alternate_greetings]
                if choice.greetingIndex >= len(greetings):
                    raise OwnerArgumentError("Opening index is out of range")
                play = TavernSession(cardId=choice.cardId, card=card.fields, player=choice.player, greeting=expand(greetings[choice.greetingIndex], card.fields.name, choice.player.name, ""), lore=load_book(card.book) if card.book is not None else None, notes="")
                play = play.model_copy(update={"greetingIndex": choice.greetingIndex, "hasPortrait": card.portrait is not None})
                self._save(play.model_dump())
                if play.greeting:
                    await self.publish_opening(play.greeting)
                    self._save(play.model_copy(update={"openingSent": True}).model_dump())
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
            raise OwnerArgumentError("Opening requires a live controller")
        await self.binding.emit(OutputEvent(type="assistant_round_start"))
        self.binding.controller.conversation.append("assistant", text)
        await self.binding.emit(OutputEvent(type="text", content=text))
        await self.binding.emit(OutputEvent(type="assistant_message", payload={"message": {"role": "assistant", "content": text}}))

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
            entries = []
            remaining = 2048
            for book in books:
                chosen = active_entries(book, history, _cost, remaining)
                entries.extend(chosen)
                remaining -= sum(_cost(e.content) for e in chosen)
            content = story_context(play.card, play.player, entries, play.notes)
            if books and self.binding:
                lore_view = {"totalEntries": sum(len(book.entries) for book in books), "activeTitles": [e.name or e.comment or ", ".join(e.keys) for e in entries], "usedTokens": 2048 - remaining, "budgetTokens": min(2048, sum(book.token_budget for book in books))}
                if self.binding.get_state("loreView") != lore_view:
                    self.binding.set_state("loreView", lore_view)
                    self.ui_emit("state", self.ui_state())
        index = next((i for i, message in enumerate(messages) if message.get("role") not in ("system", "developer")), len(messages))
        return [*messages[:index], {"role": "user", "content": content}, *messages[index:]]
