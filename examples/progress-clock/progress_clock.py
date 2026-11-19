"""A native KT plugin installed separately from the cards that configure it."""

from typing import Literal

from kohakuterrarium.modules.plugin.base import BasePlugin, PluginContext
from kohakuterrarium.modules.tool.base import BaseTool, ExecutionMode, ToolResult
from pydantic import BaseModel, ConfigDict, Field


class Clock(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    label: str = Field(min_length=1, max_length=80)
    segments: int = Field(ge=2, le=20)


class Move(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    action: Literal['read', 'advance']


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
            if view['filled'] >= view['segments']:
                raise ValueError('The clock is already complete')
            view['filled'] += 1
            self.plugin.context.set_state('filled', view['filled'])
            self.plugin.ui_emit('state', view)
        return ToolResult(output=f"{view['label']}: {view['filled']}/{view['segments']}")


class ProgressClock(BasePlugin):
    name = 'progress-clock'
    roleplay_tool_names = frozenset({ClockTool.tool_name})

    async def on_load(self, context: PluginContext) -> None:
        self.context = context

    def contribute_tools(self):
        return [ClockTool(self)]

    def validate_roleplay_settings(self, settings: dict) -> None:
        Clock.model_validate(settings)

    def ui_state(self) -> dict:
        roleplay = self.context.host_agent.plugins.get_plugin('roleplay')
        settings = roleplay.gameplay_settings(self.name) if roleplay else None
        if settings is None:
            return {'active': False}
        clock = Clock.model_validate(settings)
        return {'active': True, **clock.model_dump(), 'filled': self.context.get_state('filled') or 0}
