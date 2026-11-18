"""Typed card-authored fields, session values and the read-only player projection."""

from math import isfinite
from typing import Annotated, Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, model_validator

from .errors import CardError

Value: TypeAlias = str | int | float | list[str]
FieldKey = Annotated[str, Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_-]{0,63}$")]


class StateField(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    key: FieldKey
    label: str = Field(min_length=1)
    type: Literal["text", "number", "enum", "list"]
    initial: Value
    visibility: Literal["public", "private"]
    min: int | float | None = None
    max: int | float | None = None
    options: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def valid_definition(self) -> "StateField":
        if self.type != "number" and (self.min is not None or self.max is not None):
            raise ValueError(f"{self.key}: only numeric fields accept bounds")
        if self.type == "number":
            if any(isinstance(v, float) and not isfinite(v) for v in (self.min, self.max)):
                raise ValueError(f"{self.key}: bounds must be finite")
            if self.min is not None and self.max is not None and self.max < self.min:
                raise ValueError(f"{self.key}: max is below min")
        if self.type == "enum":
            if not self.options or len(set(self.options)) != len(self.options):
                raise ValueError(f"{self.key}: enum options must be non-empty and distinct")
        elif self.options:
            raise ValueError(f"{self.key}: only enum fields accept options")
        self.check(self.initial)
        return self

    def check(self, value: Value) -> None:
        if self.type == "number":
            if type(value) not in (int, float) or (isinstance(value, float) and not isfinite(value)):
                raise ValueError(f"{self.key}: expected a finite number")
            if (self.min is not None and value < self.min) or (self.max is not None and value > self.max):
                raise ValueError(f"{self.key}: number outside the declared bounds")
        elif self.type == "list":
            if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
                raise ValueError(f"{self.key}: expected a list of strings")
        elif not isinstance(value, str) or (self.type == "enum" and value not in self.options):
            raise ValueError(f"{self.key}: invalid {self.type} value")


class FieldUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    key: FieldKey
    value: Value


def decode_fields(extensions: object) -> list[StateField]:
    if not isinstance(extensions, dict) or "kohaku-roleplay" not in extensions:
        return []
    namespace = extensions["kohaku-roleplay"]
    if not isinstance(namespace, dict):
        raise CardError("extensions.kohaku-roleplay must be an object")
    try:
        fields = TypeAdapter(list[StateField]).validate_python(namespace.get("state", []), strict=True)
    except ValidationError as exc:
        issue = exc.errors(include_input=False)[0]
        raise CardError(f"Invalid card state at {issue['loc']}: {issue['msg']}") from exc
    if len({f.key for f in fields}) != len(fields):
        raise CardError("Duplicate card state key")
    return fields


def update_values(fields: list[StateField], stored: dict[str, Value], changes: list[FieldUpdate]) -> dict[str, Value]:
    definitions = {f.key: f for f in fields}
    patch: dict[str, Value] = {}
    for change in changes:
        if change.key not in definitions or change.key in patch:
            raise ValueError(f"Unknown or repeated card state key: {change.key}")
        definitions[change.key].check(change.value)
        patch[change.key] = change.value
    return {**stored, **patch}


def public_fields(fields: list[StateField], values: dict[str, Value]) -> list[dict[str, object]]:
    return [
        {**f.model_dump(include={"key", "label", "type", "min", "max"}, exclude_none=True),
         "value": values.get(f.key, f.initial)}
        for f in fields if f.visibility == "public"
    ]


def model_fields(fields: list[StateField], values: dict[str, Value]) -> list[dict[str, object]]:
    return [
        {**f.model_dump(exclude={"initial"}, exclude_none=True), "value": values.get(f.key, f.initial)}
        for f in fields
    ]
