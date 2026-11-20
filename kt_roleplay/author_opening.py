"""Declarative capabilities an author can attach to one opening of their card."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .legacy_web import OpeningCounterGrant


def _valid_path(path: list[str]) -> bool:
    return (0 < len(path) <= 16 and all(0 < len(part) <= 160 and part not in ('__proto__', 'constructor', 'prototype')
                                         for part in path))


class OpeningSchemaGrant(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    profile: Literal['mvu-zod-derived-v1']
    scriptId: str = Field(min_length=1, max_length=120)
    outputPath: list[str] = Field(min_length=2, max_length=16)

    @model_validator(mode='after')
    def _path(self) -> 'OpeningSchemaGrant':
        if not _valid_path(self.outputPath):
            raise ValueError('Choose a bounded new derived field within an existing variable object')
        return self


class AuthorOpeningGameplay(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid', serialize_by_alias=True)
    greetingIndex: int = Field(default=0, ge=0)
    publicPaths: list[list[str]] = Field(min_length=1, max_length=128)
    counter: OpeningCounterGrant | None = None
    schema_grant: OpeningSchemaGrant | None = Field(default=None, alias='schema')

    @model_validator(mode='after')
    def _validate_capabilities(self) -> 'AuthorOpeningGameplay':
        paths = {tuple(path) for path in self.publicPaths}
        if len(paths) != len(self.publicPaths) or any(not _valid_path(path) for path in self.publicPaths):
            raise ValueError('Opening gameplay requires distinct public variable paths')
        if self.counter and tuple(self.counter.path) not in paths:
            raise ValueError('The opening counter must be included in publicPaths')
        if self.schema_grant and (self.counter is None or tuple(self.schema_grant.outputPath) in paths):
            raise ValueError('An opening schema requires a public counter and a separate derived output')
        return self
