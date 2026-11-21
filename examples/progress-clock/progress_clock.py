"""A native KT plugin installed separately from the cards that configure it."""

from typing import Literal
from uuid import uuid4

from kohakuterrarium.modules.plugin.base import BasePlugin, PluginContext
from kohakuterrarium.modules.tool.base import BaseTool, ExecutionMode, ToolResult
from kohakuterrarium.modules.ui_owner import OwnerArgumentError
from pydantic import BaseModel, ConfigDict, Field, ValidationError


class Clock(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    label: str = Field(min_length=1, max_length=80)
    segments: int = Field(ge=2, le=20)


class Move(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    action: Literal['read', 'advance']


class Advance(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    scope: str = Field(min_length=32, max_length=32)
    expectedFilled: int = Field(ge=0, le=20)


class ClockTool(BaseTool):
    tool_name = 'rp_pack_progress_clock_tick'
    description = 'Read the current progress clock or advance it one segment after a completed milestone.'
    execution_mode = ExecutionMode.DIRECT

    def __init__(self, plugin):
        super().__init__()
        self.plugin = plugin

    def get_parameters_schema(self):
        return Move.model_json_schema()

    async def _execute(self, args: dict) -> ToolResult:
        move = Move.model_validate(args)
        view = self.plugin.ui_state()
        if not view['active']:
            raise ValueError('Bind a card requiring this clock before using it')
        if move.action == 'advance':
            view = self.plugin.advance(view['filled'])
        return ToolResult(output=f"{view['label']}: {view['filled']}/{view['segments']}")


class ProgressClock(BasePlugin):
    name = 'progress-clock'
    roleplay_tool_names = frozenset({ClockTool.tool_name})

    async def on_load(self, context: PluginContext) -> None:
        self.context = context
        self._clock_scope = uuid4().hex

    def contribute_tools(self):
        return [ClockTool(self)]

    def validate_roleplay_settings(self, settings: dict) -> None:
        Clock.model_validate(settings)

    def ui_state(self) -> dict:
        plugins = self.context.host_agent.plugins
        roleplay = plugins.get_plugin('roleplay') if plugins.is_enabled('roleplay') else None
        settings = roleplay.gameplay_settings(self.name) if roleplay else None
        if settings is None:
            return {'active': False}
        clock = Clock.model_validate(settings)
        return {'active': True, 'scope': self._clock_scope, **clock.model_dump(),
                'filled': self.context.get_state('filled') or 0}

    def advance(self, expected_filled: int) -> dict:
        view = self.ui_state()
        if not view['active']:
            raise OwnerArgumentError('Bind a card requiring this clock before using it')
        if view['filled'] != expected_filled:
            raise OwnerArgumentError('The clock has changed; refresh before advancing')
        if view['filled'] >= view['segments']:
            raise OwnerArgumentError('The clock is already complete')
        if self.context.session_store is None:
            raise OwnerArgumentError('The clock has no session save')
        view['filled'] += 1
        self.context.set_state('filled', view['filled'])
        self.ui_emit('state', view)
        return view

    def ui_call(self, action: str, args: dict) -> dict:
        if action == 'read' and not args:
            return self.ui_state()
        if action != 'advance':
            raise OwnerArgumentError(f'Unknown clock action: {action}')
        try:
            advance = Advance.model_validate(args)
        except ValidationError as exc:
            raise OwnerArgumentError('Advance requires the displayed clock scope and expectedFilled integer') from exc
        if advance.scope != self._clock_scope:
            raise OwnerArgumentError('The clock belongs to another session; refresh before advancing')
        return self.advance(advance.expectedFilled)
