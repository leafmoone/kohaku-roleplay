"""Apply scoped card script events with one durable write per accepted event."""

from asyncio import Lock
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from .card_scripts import CardScript, ScriptButton, script_fingerprint, visible_script_buttons
from .script_tool import CardScriptError, effective_buttons, run_card_script


class SessionScripts(BaseModel):
    model_config = ConfigDict(strict=True)
    approved: str | None = None
    clock: Literal["history", "turn"] = "history"
    seen: dict[Literal["opening", "user", "assistant"], int] = Field(default_factory=dict)
    issues: dict[str, str] = Field(default_factory=dict)
    mvu_listeners: dict[str, bool] = Field(default_factory=dict)
    inactive_events: dict[str, list[str]] = Field(default_factory=dict)
    appended_buttons: dict[str, list[ScriptButton]] = Field(default_factory=dict)
    button_receipts_current: bool = False


def upgrade_button_receipts(state: SessionScripts) -> SessionScripts:
    # Early dynamic-button saves could cache registrations from before the append.
    if state.button_receipts_current:
        return state
    return state.model_copy(update={'button_receipts_current': True, 'mvu_listeners': {
        key: value for key, value in state.mvu_listeners.items() if key not in state.appended_buttons
    }})


def settled_mvu_scripts(state: SessionScripts, notices: dict[str, list[str]],
                        added: dict[str, list[ScriptButton]]) -> SessionScripts:
    inactive = {**state.inactive_events, **notices}
    published = {key: [*state.appended_buttons.get(key, []), *rows] for key, rows in added.items() if rows}
    return state.model_copy(update={
        'inactive_events': {key: names for key, names in inactive.items() if names},
        'appended_buttons': {**state.appended_buttons, **published},
        'mvu_listeners': {key: value for key, value in state.mvu_listeners.items() if key not in published},
    })


def upgrade_script_clock(state: SessionScripts, last_turn: int) -> SessionScripts:
    if state.clock == "turn":
        return state
    # Old experimental saves stored context length, which is not a turn number.
    # Mark already seen phases through the restored turn without replaying them.
    return state.model_copy(update={"clock": "turn", "seen": {
        phase: sequence if phase == "opening" else last_turn for phase, sequence in state.seen.items()
    }})


def approved(bundle: list[CardScript], state: SessionScripts) -> list[CardScript]:
    if state.approved is None or state.approved != script_fingerprint(bundle):
        return []
    return [script for script in bundle if script.enabled and not script.issue]


class ScriptSession:
    def __init__(self, host):
        self.host = host
        self.lock = Lock()

    async def fire(self, event: str, *, sequence: int | None = None, script_id: str | None = None,
                   args: JsonValue = None) -> None:
        async with self.lock:
            record, play = self.host.script_record()
            scripts = approved(play.scripts, play.script_state) if play.mvu and play.mvu.values else []
            if not scripts:
                if script_id is not None:
                    raise CardScriptError("This tavern has no approved script with initialized variables")
                return
            old = upgrade_button_receipts(play.script_state)
            if sequence is not None and event != "opening" and old.clock != "turn":
                # A late attach can miss the start hook: be conservative about replay.
                upgraded = upgrade_script_clock(old, sequence)
                self.host._save(play.model_copy(update={"script_state": upgraded}).model_dump())
                old = upgraded
                play = play.model_copy(update={"script_state": upgraded})
                record = self.host._record()
            if sequence is not None and old.seen.get(event, -1) >= sequence:
                return
            published = dict(old.appended_buttons)
            if script_id is not None:
                scripts = [s for s in scripts if s.id == script_id and (
                    not event.startswith('button:') or event[7:] in visible_script_buttons(s, published.get(s.id, [])))]
                if not scripts:
                    raise CardScriptError("Unknown script or button in the current tavern")
            values = play.mvu.values
            errors = dict(old.issues)
            listeners = dict(old.mvu_listeners)
            inactive = dict(old.inactive_events)
            handled = False
            for script in scripts:
                try:
                    buttons = effective_buttons(script, published.get(script.id, []))
                    used, values, listeners[script.id], skipped, added = await run_card_script(script, values, event, args, buttons)
                    if added:
                        published[script.id] = [*published.get(script.id, []), *added]
                        # This receipt predates the buttons just published by the callback.
                        listeners.pop(script.id, None)
                    if skipped:
                        inactive[script.id] = skipped
                    else:
                        inactive.pop(script.id, None)
                    errors.pop(script.id, None)
                    handled = handled or used
                except ValueError as exc:
                    if script_id is not None:
                        raise CardScriptError(str(exc)) from exc
                    errors[script.id] = str(exc)
            if script_id is not None and not handled:
                raise CardScriptError("The script has no compatible handler for this action")
            if self.host._record() != record:
                if script_id is not None:
                    raise CardScriptError("The tavern changed while the script ran; try again")
                return
            seen = {**old.seen, event: sequence} if sequence is not None else old.seen
            self.host._save(play.model_copy(update={
                "mvu": play.mvu.model_copy(update={"values": values}),
                "script_state": old.model_copy(update={"seen": seen, "issues": errors, "mvu_listeners": listeners,
                                                       'inactive_events': inactive, 'appended_buttons': published}),
            }).model_dump())
            self.host.ui_emit("state", self.host.ui_state())
