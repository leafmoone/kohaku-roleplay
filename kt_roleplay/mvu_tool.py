"""Expose typed MVU updates through a native KT tool, never script execution."""

from typing import Protocol

from kohakuterrarium.modules.tool.base import BaseTool, ExecutionMode, ToolResult
from pydantic import BaseModel, ConfigDict, Field

from .mvu import MvuChange


class MvuChanges(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    changes: list[MvuChange] = Field(min_length=1, max_length=32)


class MvuHost(Protocol):
    def apply_mvu_changes(self, changes: list[MvuChange]) -> None: ...


class UpdateMvu(BaseTool):
    tool_name = "rp_update_mvu"
    description = (
        "Update initialized variables in this tavern session. Provide the existing key path as a list. "
        "Use set to replace a value with the same type, or add to adjust a number. Never include "
        "private variable values or commentary about this update in the story."
    )
    execution_mode = ExecutionMode.DIRECT

    def __init__(self, host: MvuHost):
        super().__init__()
        self.host = host

    def get_parameters_schema(self) -> dict:
        return MvuChanges.model_json_schema()

    async def _execute(self, args: dict) -> ToolResult:
        self.host.apply_mvu_changes(MvuChanges.model_validate(args).changes)
        return ToolResult(output="Updated session variables. Continue the story without repeating the update.")
