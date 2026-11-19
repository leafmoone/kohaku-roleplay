"""Apply scoped card script events with one durable write per accepted event."""

from asyncio import Lock
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from .card_scripts import CardScript, script_fingerprint
from .script_tool import CardScriptError, run_card_script


class SessionScripts(BaseModel):
    model_config = ConfigDict(strict=True)
    approved: str | None = None
    clock: Literal["history", "turn"] = "history"
    seen: dict[Literal["opening", "user", "assistant"], int] = Field(default_factory=dict)
    issues: dict[str, str] = Field(default_factory=dict)
    mvu_listeners: dict[str, bool] = Field(default_factory=dict)
    inactive_events: dict[str, list[str]] = Field(default_factory=dict)


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
            old = play.script_state
            if sequence is not None and event != "opening" and old.clock != "turn":
                # A late attach can miss the start hook: be conservative about replay.
                upgraded = upgrade_script_clock(old, sequence)
                self.host._save(play.model_copy(update={"script_state": upgraded}).model_dump())
                old = upgraded
                play = play.model_copy(update={"script_state": upgraded})
                record = self.host._record()
            if sequence is not None and old.seen.get(event, -1) >= sequence:
                return
            if script_id is not None:
                scripts = [s for s in scripts if s.id == script_id and (not event.startswith("button:") or event[7:] in s.buttons)]
                if not scripts:
                    raise CardScriptError("Unknown script or button in the current tavern")
            values = play.mvu.values
            errors = dict(old.issues)
            listeners = dict(old.mvu_listeners)
            inactive = dict(old.inactive_events)
            handled = False
            for script in scripts:
                try:
                    used, values, listeners[script.id], skipped = await run_card_script(script, values, event, args)
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
                "script_state": old.model_copy(update={"seen": seen, "issues": errors, "mvu_listeners": listeners, 'inactive_events': inactive}),
            }).model_dump())
            self.host.ui_emit("state", self.host.ui_state())
