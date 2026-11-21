"""Tavern input and snapshot schemas, independent of the creature runtime."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .card_scripts import CardScript
from .card_state import StateField, Value
from .card_web import WebPanel
from .cards import CardFields
from .charx import CardMedia
from .gameplay_pack import GameplayPack
from .legacy_web import LegacyOpeningState, LegacyReplyState, OpeningCounterGrant
from .lore import LoreBook
from .mvu import MvuInit
from .opening_mvu_schema import OpeningSchemaGrant, OpeningSchemaSnapshot
from .opening_page_library import CALLBACK_RUNTIME, OpeningPageIssue, OpeningPageRuntime
from .panels import NativePanel
from .pinned_mvu_status import StatusPanel
from .portraits import PortraitRule
from .projections import Player
from .script_session import SessionScripts
from .worldbook_library import WorldbookReference


class Arguments(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


class Play(Arguments):
    cardId: str
    player: Player
    greetingIndex: int = Field(ge=0)
    worldbookId: str | None = Field(default=None, min_length=1)
    enableCardScripts: bool = False
    enableOpeningModules: bool = True
    openingPageRuntime: OpeningPageRuntime | None = None
    enableOpeningMvuRead: bool = False
    openingMvuCounter: OpeningCounterGrant | None = None
    openingMvuSchema: OpeningSchemaGrant | None = None

    @model_validator(mode='after')
    def _opening_runtime_consent(self) -> 'Play':
        if self.openingPageRuntime is not None and not self.enableOpeningModules:
            raise ValueError('An opening-page runtime requires opening modules to be enabled')
        if self.enableOpeningMvuRead and self.openingPageRuntime != CALLBACK_RUNTIME:
            raise ValueError('Opening-page MVU reads require the tavern-page-callbacks-v1 runtime')
        if self.openingMvuCounter is not None and not self.enableOpeningMvuRead:
            raise ValueError('An opening counter requires explicit opening-page MVU read permission')
        if self.openingMvuSchema and (not self.openingMvuCounter or self.enableCardScripts
                                      or 'enableCardScripts' not in self.model_fields_set):
            raise ValueError('The opening schema needs a counter and explicit enableCardScripts: false')
        return self


SetupPanelIssue = Literal['setup_resources_missing', 'setup_disabled', 'setup_unsupported', 'setup_runtime_unavailable']


class TavernSession(Arguments):
    cardId: str
    card: CardFields
    player: Player
    greeting: str
    greetingIndex: int = 0
    openingSent: bool = False
    hasPortrait: bool = False
    portrait_rules: list[PortraitRule] = Field(default_factory=list)
    state_fields: list[StateField] = Field(default_factory=list)
    values: dict[str, Value] = Field(default_factory=dict)
    lore: LoreBook | None
    worldbook: LoreBook | None = None
    worldbookRef: WorldbookReference | None = None
    notes: str
    media: list[CardMedia] = Field(default_factory=list)
    media_issues: dict[str, int] = Field(default_factory=dict)
    scene_media_rules: list[PortraitRule] = Field(default_factory=list)
    native_panels: list[NativePanel] = Field(default_factory=list)
    invalid_native_panels: int = 0
    mvu: MvuInit | None = None
    mvu_public: list[str] = Field(default_factory=list)
    header_pins: list[str] = Field(default_factory=list)
    mvu_legacy: bool = False
    pinned_mvu: str | None = Field(default=None, exclude_if=lambda value: value is None)
    pinned_mvu_issue: str | None = Field(default=None, exclude_if=lambda value: value is None)
    pinned_mvu_status: StatusPanel | None = Field(default=None, exclude_if=lambda value: value is None)
    lore_activation: dict[Literal["lore", "worldbook"], dict[str, int]] = Field(default_factory=dict)
    gameplay_pack: GameplayPack | None = None
    legacy_plugins: list[str] = Field(default_factory=list)
    web_panel: WebPanel | None = None
    web_panel_ready: bool = True
    web_panel_issue: OpeningPageIssue | SetupPanelIssue | None = None
    legacy_opening_web: LegacyOpeningState | None = None
    legacy_reply_web: LegacyReplyState | None = None
    opening_schema: OpeningSchemaSnapshot | None = None
    opening_gameplay_issue: str | None = None
    scripts: list[CardScript] = Field(default_factory=list)
    script_state: SessionScripts = Field(default_factory=lambda: SessionScripts(clock="turn"))
