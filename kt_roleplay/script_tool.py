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

from .card_scripts import CardScript, ScriptButton
from .mvu import validate_updated_values
from .script_values import CardScriptError, assert_js_numbers, validated_script_values
from .script_vm import OPENING_SCHEMA_RESULT_BYTES


def effective_buttons(script: CardScript, appended: list[ScriptButton]) -> list[ScriptButton]:
    return [*(ScriptButton(name=name, visible=True) for name in script.buttons), *appended]


def _button_rows(buttons: list[ScriptButton]) -> list[dict[str, str | bool]]:
    return [button.model_dump() for button in buttons]


def _run_worker(script: CardScript, values: dict[str, JsonValue], event: str, args: JsonValue,
                buttons: list[ScriptButton]) -> dict:
    if not script.enabled or script.issue:
        raise CardScriptError("This card script is not runnable")
    assert_js_numbers(values)
    assert_js_numbers(args)
    data = {"values": values, "event": event, "args": args, "buttons": _button_rows(buttons),
            "code": script.content, "module": script.module}
    # User/reply text is already bounded in characters by the host, before JSON escaping.
    if event == "tool" and len(json.dumps(args, ensure_ascii=True, allow_nan=False).encode("ascii")) > 4096:
        raise CardScriptError("Card script arguments are too large")
    return _worker_result(data)


def _worker_result(data: dict, *, mvu: bool = False, schema: bool = False) -> dict:
    try:
        payload = json.dumps(data, ensure_ascii=True, allow_nan=False).encode("ascii")
        worker = Path(__file__).with_name("script_vm.py").resolve()
        env = {k: os.environ[k] for k in ("SYSTEMROOT", "WINDIR") if k in os.environ}
        argv = [sys.executable, '-I', '-B', str(worker)] + (['mvu'] if mvu else ['schema'] if schema else [])
        process = subprocess.run(argv, cwd=worker.parent, env=env,
                                 input=payload, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3.0 if mvu else 2.0)
        if process.returncode or (schema and len(process.stdout) > OPENING_SCHEMA_RESULT_BYTES):
            raise CardScriptError("Card script worker stopped without a result")
        result = json.loads(process.stdout)
    except subprocess.TimeoutExpired as exc:
        raise CardScriptError("Card script exceeded its runtime limit") from exc
    except (OSError, RecursionError, json.JSONDecodeError) as exc:
        raise CardScriptError("Card script worker failed") from exc
    if not isinstance(result, dict) or result.get("status") != "ok":
        status = result.get("status") if isinstance(result, dict) else None
        reason = {"engine_missing": "Card script engine is not installed", "script_limit": "Card script exceeded its limits",
                  "worker_dependency_missing": "The card script worker is missing a required package dependency",
                  "unsupported_api": "Card script referenced an unavailable JavaScript or Tavern Helper API"}
        if mvu and status == 'invalid_update':
            raise CardScriptError(result['reason'])
        if schema and status == 'script_error':
            raise CardScriptError('The selected opening schema failed; no derived state was saved')
        raise CardScriptError(reason.get(status, "Card script used an unsupported API or failed"))
    return result


def _inactive(names: object) -> list[str]:
    if not isinstance(names, list) or len(names) > 2 or any(
        name not in ('mag_variable_initialized', 'mag_before_message_update') for name in names
    ):
        raise CardScriptError('Invalid event diagnostics from card script worker')
    return names


def _appended_rows(buttons: list[ScriptButton], proposals: object) -> list[ScriptButton]:
    if not isinstance(proposals, list) or len(proposals) > 8:
        raise CardScriptError('Invalid button list from card script worker')
    next_buttons = [ScriptButton.model_validate(row) for row in proposals]
    if next_buttons[:len(buttons)] != buttons or len({row.name for row in next_buttons}) != len(next_buttons):
        raise CardScriptError('Card scripts may only append new button names')
    added = next_buttons[len(buttons):]
    for row in added:
        try:
            row.name.encode('utf-8')
        except UnicodeError as exc:
            raise CardScriptError('Invalid appended card script button name') from exc
        if row.name.strip() != row.name:
            raise CardScriptError('Invalid appended card script button name')
    return added


def run_mvu_update(scripts: list[CardScript], values: dict[str, JsonValue], update,
                   appended: dict[str, list[ScriptButton]]) -> tuple[dict[str, JsonValue], dict[str, list[str]], dict[str, list[ScriptButton]]]:
    current = {s.id: effective_buttons(s, appended.get(s.id, [])) for s in scripts}
    bundle = [{'id': s.id, 'code': s.content, 'buttons': _button_rows(current[s.id]), 'module': s.module} for s in scripts]
    result = _worker_result({'scripts': bundle, 'values': values, 'update': update}, mvu=True)
    if not isinstance(result.get('values'), dict):
        raise CardScriptError('Invalid response from MVU worker')
    inactive = result.get('inactive')
    if not isinstance(inactive, dict) or set(inactive) != {s.id for s in scripts}:
        raise CardScriptError('Invalid event diagnostics from MVU worker')
    buttons = result.get('buttons')
    if not isinstance(buttons, dict) or not set(buttons).issubset(current):
        raise CardScriptError('Invalid published buttons from MVU worker')
    added = {key: _appended_rows(current[key], rows) for key, rows in buttons.items()}
    return validate_updated_values(result['values']), {k: _inactive(names) for k, names in inactive.items()}, added


async def run_card_script(script: CardScript, values: dict[str, JsonValue], event: str, args: JsonValue,
                          buttons: list[ScriptButton]) -> tuple[bool, dict[str, JsonValue], bool, list[str], list[ScriptButton]]:
    try:
        result = await asyncio.to_thread(_run_worker, script, values, event, args, buttons)
        if type(result.get("handled")) is not bool or type(result.get('listensMvu')) is not bool or "values" not in result:
            raise CardScriptError("Invalid response from card script worker")
        inactive = _inactive(result.get('inactive'))
        added = _appended_rows(buttons, result['buttons']) if 'buttons' in result else []
        return (result['handled'], validated_script_values(values, result['values']), result['listensMvu'], inactive, added)
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
