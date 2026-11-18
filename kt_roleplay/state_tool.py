"""An opt-in model action for session state on a typed tavern card."""

from typing import Protocol

from pydantic import Field
from kohakuterrarium.modules.tool.base import BaseTool, ExecutionMode, ToolResult

from .card_state import FieldUpdate
from .novel import StoryModel


class TavernChanges(StoryModel):
    changes: list[FieldUpdate] = Field(min_length=1, description="Absolute new values of declared fields that changed this turn.")


class StateHost(Protocol):
    def apply_card_changes(self, changes: list[FieldUpdate]) -> None: ...


class SetCardState(BaseTool):
    tool_name = "rp_set_card_state"
    description = "Record changes to this card's declared fields for the current session. Do not publish private fields."
    execution_mode = ExecutionMode.DIRECT

    def __init__(self, host: StateHost):
        super().__init__()
        self.host = host

    def get_parameters_schema(self) -> dict:
        return TavernChanges.model_json_schema()

    async def _execute(self, args: dict) -> ToolResult:
        self.host.apply_card_changes(TavernChanges.model_validate(args).changes)
        return ToolResult(output="Updated this session's character state. Continue the story without repeating the update.")
