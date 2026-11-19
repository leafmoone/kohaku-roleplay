"""Atomic gameplay actions on authored inventory and quest panels."""

from typing import Annotated, Literal, Protocol, TypeGuard

from kohakuterrarium.modules.tool.base import BaseTool, ExecutionMode, ToolResult
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .card_state import FieldKey, FieldUpdate, StateField, Value, update_values
from .errors import SettlementRejected
from .panels import InventoryPanel, NativePanel, QuestPanel


class PanelAction(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    panelId: FieldKey


class ItemAction(PanelAction):
    action: Literal['gain_item', 'consume_item']
    item: str = Field(min_length=1, max_length=120)
    quantity: int = Field(default=1, ge=1, le=99)


class ObjectiveAction(PanelAction):
    action: Literal['complete_objective']
    index: int = Field(ge=0)


class QuestAction(PanelAction):
    action: Literal['complete_quest']


Action = Annotated[ItemAction | ObjectiveAction | QuestAction, Field(discriminator='action')]


class Actions(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    actions: list[Action] = Field(min_length=1, max_length=24, description=(
        'Ordered steps of ONE in-world action that must succeed together. Submit unrelated actions in separate calls, '
        'even within the same player turn.'
    ))


def _completes(panel: NativePanel, key: str, value: Value) -> TypeGuard[QuestPanel]:
    return isinstance(panel, QuestPanel) and panel.status == key and panel.completed == value


def apply_field_changes(panels: list[NativePanel], fields: list[StateField], stored: dict[str, Value],
                        changes: list[FieldUpdate]) -> dict[str, Value]:
    for change in changes:
        for panel in panels:
            if isinstance(panel, InventoryPanel) and panel.field == change.key:
                raise ValueError(f'Inventory {panel.id} requires gain_item or consume_item via rp_apply_gameplay')
            if _completes(panel, change.key, change.value):
                raise ValueError(f'Quest {panel.id} requires complete_quest via rp_apply_gameplay')
    return update_values(fields, stored, changes)


def apply_actions(panels: list[NativePanel], fields: list[StateField], stored: dict[str, Value], actions: list[Action]) -> dict[str, Value]:
    public = {field.key: field for field in fields if field.visibility == 'public'}
    declared = {p.id: p for p in panels}
    state = dict(stored)

    def read(key: str) -> Value:
        if key not in public:
            raise ValueError('The action needs a declared public field')
        return state.get(key, public[key].initial)

    for change in actions:
        panel = declared.get(change.panelId)
        if isinstance(change, ItemAction) and isinstance(panel, InventoryPanel):
            current = read(panel.field)
            if not isinstance(current, list) or not change.item.strip():
                raise ValueError('Invalid inventory item or list')
            items = list(current)
            if change.action == 'gain_item':
                if len(items) + change.quantity > 512:
                    raise ValueError('Inventory is full')
                items.extend([change.item] * change.quantity)
            else:
                if items.count(change.item) < change.quantity:
                    raise ValueError('Insufficient inventory quantity')
                for _ in range(change.quantity):
                    items.remove(change.item)
            key, value = panel.field, items
        elif isinstance(change, ObjectiveAction) and isinstance(panel, QuestPanel):
            if change.index >= len(panel.objectives):
                raise ValueError('Unknown quest objective')
            objective = panel.objectives[change.index]
            read(objective.field)
            key, value = objective.field, objective.equals
        elif isinstance(change, QuestAction) and isinstance(panel, QuestPanel):
            read(panel.status)
            key, value = panel.status, panel.completed
        else:
            raise ValueError('This action is not declared by the current tavern card')
        # A status can also be another panel's status or objective field.
        for quest in panels:
            if _completes(quest, key, value):
                if any(read(obj.field) != obj.equals for obj in quest.objectives):
                    raise ValueError(f'Complete all declared objectives before completing the quest: {quest.id}')
        state = update_values(fields, state, [FieldUpdate(key=key, value=value)])
    return state


class GameplayHost(Protocol):
    def apply_gameplay_actions(self, actions: list[Action]) -> None: ...


class PlayActions(BaseTool):
    tool_name = 'rp_apply_gameplay'
    description = ('Settle one in-world action on declared inventory or quest panels. Group only inseparable steps; '
                   'use separate calls for independent actions in the same turn. A rejected call changes nothing '
                   'and does not undo other calls. Use panel IDs and zero-based objective indices.')
    execution_mode = ExecutionMode.DIRECT

    def __init__(self, host: GameplayHost):
        super().__init__()
        self.host = host

    def get_parameters_schema(self) -> dict:
        return Actions.model_json_schema()

    async def _execute(self, args: dict) -> ToolResult:
        try:
            actions = Actions.model_validate(args).actions
        except ValidationError as exc:
            raise SettlementRejected(str(exc)) from exc
        self.host.apply_gameplay_actions(actions)
        return ToolResult(output='Updated the current tavern inventory or quest. Continue without repeating the update.')
