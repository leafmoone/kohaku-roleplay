"""Project card-authored native panels from the current tavern snapshot."""

from collections import Counter
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from .card_state import FieldKey, StateField, Value
from .portraits import MatchValue


class PanelSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: FieldKey
    label: str = Field(min_length=1, max_length=120)


class MeterPanel(PanelSpec):
    type: Literal["meter"]
    field: FieldKey


class InventoryPanel(PanelSpec):
    type: Literal["inventory"]
    field: FieldKey


class Objective(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    label: str = Field(min_length=1, max_length=180)
    field: FieldKey
    equals: MatchValue


class QuestPanel(PanelSpec):
    type: Literal["quest"]
    status: FieldKey
    completed: str
    objectives: list[Objective] = Field(default_factory=list, max_length=24)


class PanelChoice(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    label: str = Field(min_length=1, max_length=120)
    text: str = Field(min_length=1, max_length=600)


class ChoicePanel(PanelSpec):
    type: Literal["choices"]
    options: list[PanelChoice] = Field(min_length=1, max_length=12)


NativePanel = Annotated[MeterPanel | InventoryPanel | QuestPanel | ChoicePanel, Field(discriminator="type")]
_PANEL = TypeAdapter(NativePanel)
_MAX_PANELS = 16


def _public_index(fields: list[StateField]) -> dict[str, StateField]:
    return {field.key: field for field in fields if field.visibility == "public"}


def read_panels(raw: object, fields: list[StateField]) -> tuple[list[NativePanel], int]:
    if not isinstance(raw, list):
        return [], 1
    public = _public_index(fields)
    panels = []
    used = set()
    rejected = max(0, len(raw) - _MAX_PANELS)
    for item in raw[:_MAX_PANELS]:
        try:
            panel = _PANEL.validate_python(item)
            if panel.id in used:
                raise ValueError("Duplicate panel id")
            if isinstance(panel, MeterPanel):
                f = public[panel.field]
                if f.type != "number" or f.min is None or f.max is None or f.min == f.max:
                    raise ValueError("A meter requires a publicly visible bounded number")
            elif isinstance(panel, InventoryPanel):
                if public[panel.field].type != "list":
                    raise ValueError("An inventory requires a publicly visible list")
            elif isinstance(panel, QuestPanel):
                f = public[panel.status]
                if f.type != "enum":
                    raise ValueError("A quest status requires a publicly visible enum")
                f.check(panel.completed)
                for objective in panel.objectives:
                    public[objective.field].check(objective.equals)
            elif any(not option.text.strip() or option.text.lstrip().startswith("/") for option in panel.options):
                raise ValueError("A reader action must be plain text, not a host command")
        except (ValidationError, ValueError, KeyError):
            rejected += 1
            continue
        used.add(panel.id)
        panels.append(panel)
    return panels, rejected


def public_panels(panels: list[NativePanel], fields: list[StateField], stored: dict[str, Value]) -> list[dict[str, object]]:
    public = _public_index(fields)
    values = {key: stored.get(key, f.initial) for key, f in public.items()}
    result = []
    for panel in panels:
        item: dict[str, object] = {"id": panel.id, "label": panel.label, "type": panel.type}
        if isinstance(panel, MeterPanel):
            if (f := public.get(panel.field)) is None:
                continue
            item.update(value=values[panel.field], min=f.min, max=f.max)
        elif isinstance(panel, InventoryPanel):
            items = values.get(panel.field)
            if not isinstance(items, list):
                continue
            item["items"] = [{"label": label, "quantity": count} for label, count in Counter(items).items()]
        elif isinstance(panel, QuestPanel):
            if panel.status not in values or any(obj.field not in values for obj in panel.objectives):
                continue
            status = values[panel.status]
            item.update(status=status, completed=status == panel.completed,
                        objectives=[{"label": obj.label, "done": values[obj.field] == obj.equals} for obj in panel.objectives])
        else:
            item["options"] = [{"label": option.label, "text": option.text} for option in panel.options]
        result.append(item)
    return result
