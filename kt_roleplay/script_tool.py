"""Invoke one opted-in card script and validate its proposed variable changes."""

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Protocol

from kohakuterrarium.modules.tool.base import BaseTool, ExecutionMode, ToolResult
from pydantic import BaseModel, ConfigDict, Field, JsonValue

from .card_scripts import CardScript
from .mvu import MvuChange, _kind, apply_changes
from .mvu_patch import json_equal

_MAX_SAFE_INTEGER = 2**53 - 1
_MAX_CHANGES = 32


class CardScriptError(ValueError):
    pass


def _assert_js_numbers(value: JsonValue) -> None:
    if type(value) is int and abs(value) > _MAX_SAFE_INTEGER:
        raise CardScriptError("Scripts cannot receive integers outside JavaScript's exact range")
    if isinstance(value, (list, dict)):
        for part in value if isinstance(value, list) else value.values():
            _assert_js_numbers(part)


def _run_worker(script: CardScript, values: dict[str, JsonValue], event: str, args: JsonValue) -> dict:
    if not script.enabled or script.issue:
        raise CardScriptError("This card script is not runnable")
    _assert_js_numbers(values)
    _assert_js_numbers(args)
    data = {"values": values, "event": event, "args": args, "buttons": script.buttons,
            "code": script.content, "module": script.module}
    try:
        # User/reply text is already bounded in characters by the host, before JSON escaping.
        if event == "tool" and len(json.dumps(args, ensure_ascii=True, allow_nan=False).encode("ascii")) > 4096:
            raise CardScriptError("Card script arguments are too large")
        payload = json.dumps(data, ensure_ascii=True, allow_nan=False).encode("ascii")
        worker = Path(__file__).with_name("script_vm.py").resolve()
        env = {k: os.environ[k] for k in ("SYSTEMROOT", "WINDIR") if k in os.environ}
        process = subprocess.run([sys.executable, "-I", "-B", str(worker)], cwd=worker.parent, env=env,
                                 input=payload, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2.0)
        if process.returncode or len(process.stdout) > 64 * 1024:
            raise CardScriptError("Card script worker stopped without a result")
        result = json.loads(process.stdout)
    except subprocess.TimeoutExpired as exc:
        raise CardScriptError("Card script exceeded its runtime limit") from exc
    except (OSError, RecursionError, json.JSONDecodeError) as exc:
        raise CardScriptError("Card script worker failed") from exc
    if not isinstance(result, dict) or result.get("status") != "ok":
        status = result.get("status") if isinstance(result, dict) else None
        reason = {"engine_missing": "Card script engine is not installed", "script_limit": "Card script exceeded its limits",
                  "unsupported_api": "Card script referenced an unavailable JavaScript or Tavern Helper API"}
        raise CardScriptError(reason.get(status, "Card script used an unsupported API or failed"))
    return result


def _validated(values: dict[str, JsonValue], proposed: JsonValue) -> dict[str, JsonValue]:
    changes = []

    def gather(before: JsonValue, after: JsonValue, path: list[str]) -> None:
        if _kind(before) is not _kind(after):
            raise CardScriptError("Card script changed the type of a declared variable")
        if isinstance(before, dict):
            if before.keys() != after.keys():
                raise CardScriptError("Card scripts can only change declared variable paths")
            for key, value in before.items():
                gather(value, after[key], [*path, key])
        elif not json_equal(before, after):
            if len(changes) == _MAX_CHANGES:
                raise CardScriptError("Too many card script changes in one batch")
            changes.append(MvuChange(path=path, op="set", value=after))

    gather(values, proposed, [])
    return apply_changes(values, changes) if changes else values


async def run_card_script(script: CardScript, values: dict[str, JsonValue], event: str,
                          args: JsonValue = None) -> tuple[bool, dict[str, JsonValue]]:
    try:
        result = await asyncio.to_thread(_run_worker, script, values, event, args)
        if type(result.get("handled")) is not bool or "values" not in result:
            raise CardScriptError("Invalid response from card script worker")
        return result["handled"], _validated(values, result["values"])
    except (RecursionError, UnicodeError) as exc:
        raise CardScriptError("Card script returned invalid variable data") from exc


class ScriptToolArgs(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    scriptId: str = Field(min_length=1, max_length=120)
    args: JsonValue = None


class ScriptHost(Protocol):
    async def invoke_card_script(self, script_id: str, args: JsonValue) -> None: ...


class RunCardScript(BaseTool):
    tool_name = "rp_run_card_script"
    description = "Run one approved, named current-tavern card script by ID with JSON data. Do not send code or URLs."
    execution_mode = ExecutionMode.DIRECT

    def __init__(self, host: ScriptHost):
        super().__init__()
        self.host = host

    def get_parameters_schema(self) -> dict:
        return ScriptToolArgs.model_json_schema()

    async def _execute(self, args: dict) -> ToolResult:
        call = ScriptToolArgs.model_validate(args)
        await self.host.invoke_card_script(call.scriptId, call.args)
        return ToolResult(output="Card script ran in this tavern. Its validated state updates were applied.")
