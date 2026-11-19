"""An opt-in model action for session state on a typed tavern card."""

from typing import Protocol

from pydantic import Field, ValidationError
from kohakuterrarium.modules.tool.base import BaseTool, ExecutionMode, ToolResult

from .card_state import FieldUpdate
from .errors import SettlementRejected
from .novel import StoryModel


class TavernChanges(StoryModel):
    changes: list[FieldUpdate] = Field(min_length=1, description="Absolute field values for one in-world action. Use separate calls for independent actions.")


class StateHost(Protocol):
    def apply_card_changes(self, changes: list[FieldUpdate]) -> None: ...


class SetCardState(BaseTool):
    tool_name = "rp_set_card_state"
    description = ("Record the declared field changes that must succeed together for one in-world action. "
                   "Use a separate call for each independent action; do not publish private fields.")
    execution_mode = ExecutionMode.DIRECT

    def __init__(self, host: StateHost):
        super().__init__()
        self.host = host

    def get_parameters_schema(self) -> dict:
        return TavernChanges.model_json_schema()

    async def _execute(self, args: dict) -> ToolResult:
        try:
            changes = TavernChanges.model_validate(args).changes
        except ValidationError as exc:
            raise SettlementRejected(str(exc)) from exc
        self.host.apply_card_changes(changes)
        return ToolResult(output="Updated this session's character state. Continue the story without repeating the update.")
