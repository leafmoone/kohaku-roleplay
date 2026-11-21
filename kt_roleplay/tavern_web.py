"""Owner calls for a standalone author page, not a chat message renderer."""
from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import uuid4

from kohakuterrarium.modules.ui_owner import OwnerArgumentError

from .card_state import public_fields
from .gameplay import Actions
from .legacy_plugins import LegacyWebRequest
from .legacy_web import OpeningCounterWrite, legacy_web_message
from .mvu import public_values
from .panels import public_panels
from .pinned_mvu_setup import MvuSetupWrite, render_setup_template, setup_projection
from .tavern_state import TavernSession

if TYPE_CHECKING:
    from .runtime import RoleplayPlugin


WEB_ACTIONS = frozenset({'card_web_panel', 'card_web_state', 'card_web_gameplay', 'card_web_plugin_request',
                         'card_web_mvu_counter', 'card_web_mvu_setup'})


def pinned_status_view(play: TavernSession) -> dict | None:
    if not (play.pinned_mvu_status and play.pinned_mvu and play.mvu and play.web_panel_ready):
        return None
    return {'title': play.pinned_mvu_status.panel.title,
            'data': {'stat_data': play.pinned_mvu_status.project(play.mvu.values)}}


async def call_web_panel(plugin: RoleplayPlugin, action: str, args: dict[str, object]) -> dict:
    record = plugin._record()
    play = TavernSession.model_validate(record) if record is not None else None
    scope = plugin._web_panel_scope
    if play is None or play.web_panel is None or not play.web_panel_ready or not scope:
        raise OwnerArgumentError('This tavern has no ready card web panel')
    if action == 'card_web_panel':
        if args == {'target': 'status'}:
            if not (status := pinned_status_view(play)):
                raise OwnerArgumentError('This tavern has no supported author status panel')
            # A status mount has no redeemable gameplay or setup scope.
            return {**play.pinned_mvu_status.panel.model_dump(), 'panelScope': uuid4().hex,
                    'pinnedMvuStatus': {'data': status['data']}}
        if args:
            raise OwnerArgumentError('Choose the opening web panel or its author status view')
        panel = {**play.web_panel.model_dump(), 'panelScope': scope}
        if legacy := play.legacy_opening_web:
            if legacy.pinned_setup and play.pinned_mvu and play.mvu and (projected := setup_projection(play.mvu.values)):
                panel['html'] = render_setup_template(play.web_panel.html, play.player.name)
                panel['pinnedMvuSetup'] = {'mode': 'mvu-setup-v1', 'writable': plugin._can_write_mvu_setup(play),
                                           'data': {'stat_data': projected}}
            panel['legacyOpening'] = plugin._opening_web_message(play, legacy.values)
            panel['legacyMarker'] = legacy.marker
            if plugin._opening_counter_value(play) is not None and play.mvu and legacy.counter:
                panel['legacyOpening'] = plugin._opening_web_message(play, play.mvu.values)
                panel['legacyMvuCounter'] = {'messageId': 0, **legacy.counter.model_dump(),
                                             'revision': legacy.counter_revision}
            if latest := play.legacy_reply_web:
                panel['legacyLatest'] = legacy_web_message(latest.turn, latest.text, latest.values, play.mvu_public)
            if legacy.mvu_read_enabled and any(
                panel[key]['data']['stat_data'] for key in ('legacyOpening', 'legacyLatest') if key in panel
            ):
                panel['legacyMvuRead'] = {'mode': 'kt-message-stat-data-v1'}
        return panel
    if args.get('panelScope') != scope:
        raise OwnerArgumentError('The card web panel session changed; open the panel again')
    payload = {key: value for key, value in args.items() if key != 'panelScope'}
    if action == 'card_web_mvu_setup':
        return await plugin._write_mvu_setup(MvuSetupWrite.model_validate(payload), scope)
    if action == 'card_web_mvu_counter':
        return await plugin._write_opening_counter(OpeningCounterWrite.model_validate(payload), scope)
    if action == 'card_web_plugin_request':
        if play.legacy_opening_web and play.legacy_opening_web.pinned_setup:
            raise OwnerArgumentError('Character setup does not use external plugin requests')
        call = LegacyWebRequest.model_validate(payload).to_plugin_request()
        if play.legacy_opening_web is not None and call.method != 'GET':
            raise OwnerArgumentError('The legacy opening page is read-only')
        return await plugin._request_legacy_plugin(call, scope)
    if action == 'card_web_gameplay':
        if play.legacy_opening_web is not None:
            raise OwnerArgumentError('The legacy opening page is read-only')
        agent = plugin.binding.host_agent if plugin.binding else None
        if agent and agent.is_processing:
            raise OwnerArgumentError('Wait for this tavern before using a card web action')
        plugin.apply_gameplay_actions(Actions.model_validate(payload).actions)
        play = TavernSession.model_validate(plugin._record())
    elif payload:
        raise OwnerArgumentError('The card web state does not take arguments')
    return {'fields': public_fields(play.state_fields, play.values),
            'panels': public_panels(play.native_panels, play.state_fields, play.values),
            'mvu': public_values(play.mvu.values, play.mvu_public) if play.mvu else []}
