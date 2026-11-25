"""Prepare a tavern snapshot without publishing or writing the session."""
import json
from asyncio import to_thread
from collections.abc import Callable
from pathlib import Path

from kohakuterrarium.modules.ui_owner import OwnerArgumentError

from .card_scripts import CardScript, script_fingerprint
from .cards import CardError, ParsedCard
from .legacy_web import (
    LegacyOpeningState,
    has_mvu_status_adapter,
    selected_message_values,
)
from .library import card_scripts_default
from .lore import LoreBook
from .module_linker import ModuleLinkError, link_card_scripts
from .mvu import MvuInit, inspect_initializers, is_initializer, public_options
from .mvu_legacy import split_opening
from .mvu_settlement import settle_mvu_candidate
from .opening_mvu_schema import (
    OpeningSchemaSnapshot,
    derive_opening_schema,
    link_opening_schema,
)
from .opening_page_library import CALLBACK_RUNTIME, cached_opening_panel
from .pinned_mvu import (
    PinnedHelperMissing,
    calculate_pinned_mvu,
    compile_pinned_mvu,
    initializer_entries,
    pinned_card_author,
)
from .pinned_mvu_setup import SETUP_MARKER, setup_projection
from .pinned_mvu_status import STATUS_MARKER
from .portraits import rules_for
from .projections import expand
from .script_session import SessionScripts, approved
from .script_tool import CardScriptError
from .tavern_state import Play, TavernSession
from .worldbook_library import (
    WorldbookReference,
    default_worldbook_for_play,
    worldbook_for_play,
)

SCRIPT_CLOCK_UNAVAILABLE = 'Card scripts require a KT host with a persisted conversation turn counter'
WorldbookSnapshot = tuple[WorldbookReference | None, LoreBook | None]


def resolve_tavern_worldbook(directory: Path, choice: Play) -> WorldbookSnapshot:
    if 'worldbookId' not in choice.model_fields_set:
        return default_worldbook_for_play(directory, choice.cardId)
    return worldbook_for_play(directory, choice.worldbookId) if choice.worldbookId is not None else (None, None)


def card_scripts_unavailable(scripts: list[CardScript], mvu: MvuInit | None) -> OwnerArgumentError:
    detail = ', '.join(f'{script.id}: {script.issue}' for script in scripts if script.enabled and script.issue)
    if not mvu or not mvu.values:
        message = 'Card scripts need non-empty variables from a valid [InitVar] entry'
    elif detail:
        message = 'No enabled card script can run'
    else:
        message = 'This card has no enabled compatible scripts'
    return OwnerArgumentError(f'{message} ({detail})' if detail else message)


async def prepare_tavern_opening(
    directory: Path, choice: Play, card: ParsedCard, *, prepared_worldbook: WorldbookSnapshot | None,
    has_script_clock: Callable[[], bool], ensure_current: Callable[[], None],
) -> tuple[TavernSession, bool]:
    greetings = [card.fields.first_mes, *card.fields.alternate_greetings]
    if choice.greetingIndex >= len(greetings):
        raise OwnerArgumentError('Opening index is out of range')
    book_ref, book = prepared_worldbook if prepared_worldbook is not None else resolve_tavern_worldbook(directory, choice)
    lore = card.lore
    mvu = inspect_initializers(card.book)
    if mvu is not None and lore is not None:
        lore = lore.model_copy(update={'entries': [
            entry.model_copy(update={'enabled': False}) if is_initializer(entry.comment, entry.name) else entry
            for entry in lore.entries
        ]})
    opening = greetings[choice.greetingIndex]
    legacy_mvu = False
    block = None
    if mvu is not None and mvu.values:
        prose, block = split_opening(opening)
        directions = [card.fields.mes_example, card.fields.system_prompt, card.fields.post_history_instructions]
        if lore is not None:
            directions.extend(entry.content for entry in lore.entries if entry.enabled)
        legacy_mvu = block is not None or any(
            '<UpdateVariable>' in text and ('_.' in text or '<JSONPatch>' in text) for text in directions
        )
        if block is not None:
            opening = prose
    authored = card.opening_gameplay
    if (authored is not None and (authored.greetingIndex != choice.greetingIndex or not choice.enableOpeningModules
            or {'enableOpeningMvuRead', 'openingMvuCounter', 'openingMvuSchema', 'openingPageRuntime'} & choice.model_fields_set
            or (authored.schema_grant is not None and choice.enableCardScripts))):
        authored = None
    script_host_ok = has_script_clock()
    scripts = card.scripts
    enable_requested = (choice.enableCardScripts if 'enableCardScripts' in choice.model_fields_set
                        else script_host_ok and bool(mvu and mvu.values) and any(s.enabled for s in scripts)
                        and card_scripts_default(directory))
    if authored and authored.schema_grant:
        enable_requested = False  # The declared schema owns this opening's narrow settlement path.
    setup_requested = card.web_panel is None and SETUP_MARKER in opening
    can_run_scripts = bool(enable_requested and script_host_ok and mvu and mvu.values)
    scheme = pinned_card_author(card) if not choice.openingMvuCounter and (can_run_scripts or setup_requested) else None
    pinned_mvu = pinned_mvu_issue = None
    missing_helper = False
    if can_run_scripts:
        if scheme is not None:
            try:
                if mvu.issues:
                    raise CardScriptError('The fixed MVU profile needs valid static [InitVar] entries')
                code = await to_thread(compile_pinned_mvu, directory, choice.cardId, scheme)
                values = await to_thread(calculate_pinned_mvu, code, initializer_entries(card.book), {}, None)
                mvu = mvu.model_copy(update={'values': values})
                pinned_mvu = code
            except (ValueError, RecursionError) as exc:
                if choice.enableCardScripts:
                    raise OwnerArgumentError(str(exc)) from exc
                pinned_mvu_issue = str(exc)
                missing_helper = isinstance(exc, PinnedHelperMissing)
        else:
            scripts = await to_thread(link_card_scripts, directory, choice.cardId, scripts)
        ensure_current()
    script_card_ok = bool(mvu and mvu.values and (pinned_mvu or any(s.enabled and not s.issue for s in scripts)))
    if choice.enableCardScripts and not script_host_ok:
        raise OwnerArgumentError(SCRIPT_CLOCK_UNAVAILABLE)
    if choice.enableCardScripts and not script_card_ok:
        raise card_scripts_unavailable(scripts, mvu)
    enable_scripts = enable_requested and script_host_ok and script_card_ok and pinned_mvu is None
    script_state = SessionScripts(clock='turn', approved=script_fingerprint(scripts) if enable_scripts else None,
                                  button_receipts_current=True)
    if block is not None:
        try:
            if pinned_mvu is not None:
                values = await to_thread(calculate_pinned_mvu, pinned_mvu, [], mvu.values, block)
                mvu = mvu.model_copy(update={'values': values})
            else:
                listeners = approved(scripts, script_state) if enable_scripts else []
                mvu, script_state = await settle_mvu_candidate(mvu, script_state, block, listeners)
        except (ValueError, RecursionError):
            mvu = mvu.model_copy(update={'issues': {**mvu.issues, 'invalid_opening_update': 1}})
        ensure_current()
    opening_gameplay_issue = None
    web_panel, legacy_state, web_panel_issue = card.web_panel, None, None
    if web_panel is None:
        setup = None
        if setup_requested:
            template = next((row for row in card.legacy_mvu_setups if row.marker == SETUP_MARKER), None)
            if not choice.enableOpeningModules:
                web_panel_issue = 'setup_disabled'
            elif not template or not scheme or not mvu or not mvu.values or mvu.issues.get('invalid_initializer'):
                web_panel_issue = 'setup_unsupported'
            elif not script_host_ok:
                web_panel_issue = 'setup_runtime_unavailable'
            elif not enable_requested:
                web_panel_issue = 'setup_disabled'
            elif missing_helper:
                web_panel_issue = 'setup_resources_missing'
            elif pinned_mvu is None:
                web_panel_issue = 'setup_runtime_unavailable'
            elif not setup_projection(mvu.values):
                web_panel_issue = 'setup_unsupported'
            else:
                setup = template
        # The fixed status template never receives an opening-write scope,
        # including for alternate greetings and previously imported rows.
        rule = setup or next((row for row in card.legacy_web_rules if row.marker in opening
                              and not (card.legacy_mvu_status and row.marker == STATUS_MARKER)), None)
        marker, mvu_read_enabled = None, False
        if rule is not None:
            web_panel, marker, web_panel_issue = rule.panel, rule.marker, None
        elif (remote := card.legacy_remote_opening) is not None and remote.marker in opening:
            web_panel, web_panel_issue, _ = await to_thread(
                cached_opening_panel, directory, choice.cardId, remote,
                allow_modules=choice.enableOpeningModules,
                runtime=CALLBACK_RUNTIME if authored else choice.openingPageRuntime,
                require_linked=choice.enableOpeningMvuRead or authored is not None,
            )
            ensure_current()
            if authored and web_panel is None and web_panel_issue != 'entry_unconfirmed':
                opening_gameplay_issue = 'The declared opening gameplay is unavailable; using the ordinary opening page when possible.'
                authored = None
                web_panel, web_panel_issue, _ = await to_thread(
                    cached_opening_panel, directory, choice.cardId, remote, allow_modules=True,
                )
                ensure_current()
            marker = remote.marker
            mvu_read_enabled = choice.enableOpeningMvuRead
        if web_panel is not None and marker is not None:
            legacy_state = LegacyOpeningState(marker=marker, values={},
                                              mvu_status_adapter=has_mvu_status_adapter(marker, card.scripts),
                                              mvu_read_enabled=mvu_read_enabled, pinned_setup=setup is not None)
    if counter := choice.openingMvuCounter:
        if not legacy_state or not legacy_state.mvu_read_enabled or not mvu or counter.current(mvu.values) is None:
            raise OwnerArgumentError('Choose an existing initialized integer in the linked opening for this counter')
        legacy_state = legacy_state.model_copy(update={'counter': counter})
    schema = None
    mvu_public: list[str] = []
    if authored and legacy_state:
        paths = [json.dumps(path, ensure_ascii=False) for path in authored.publicPaths]
        try:
            values = mvu.values if mvu else {}
            if not set(paths) <= {item['id'] for item in public_options(values)}:
                raise CardError('The opening gameplay public paths are not initialized')
            if authored.counter and authored.counter.current(values) is None:
                raise CardError('The opening gameplay counter is not an initialized integer in its range')
            if grant := authored.schema_grant:
                target = values
                for part in grant.outputPath[:-1]:
                    target = target.get(part) if isinstance(target, dict) else None
                if not isinstance(target, dict) or grant.outputPath[-1] in target:
                    raise CardError('The opening schema needs a new derived field in the existing state')
                code = await to_thread(link_opening_schema, directory, choice.cardId, card.scripts, grant)
                source = selected_message_values(values, paths)
                value = await to_thread(derive_opening_schema, code, source, grant)
                schema = OpeningSchemaSnapshot(grant=grant, code=code, value=value, input_ids=paths)
        except (CardError, CardScriptError, ModuleLinkError) as exc:
            opening_gameplay_issue = str(exc)
        else:
            mvu_public = paths
            legacy_state = legacy_state.model_copy(update={'mvu_read_enabled': True, 'counter': authored.counter})
        ensure_current()
    if grant := choice.openingMvuSchema:
        if mvu is None or legacy_state is None:
            raise OwnerArgumentError('The schema needs an initialized linked opening')
        try:
            code = await to_thread(link_opening_schema, directory, choice.cardId, card.scripts, grant)
        except ModuleLinkError as exc:
            raise OwnerArgumentError(f'Opening MVU schema: {exc}') from exc
        value = await to_thread(derive_opening_schema, code, mvu.values, grant)
        ensure_current()
        schema = OpeningSchemaSnapshot(grant=grant, code=code, value=value)
    return TavernSession(
        cardId=choice.cardId, card=card.fields, player=choice.player, enableStoryChoices=choice.enableStoryChoices,
        greeting=expand(opening, card.fields.name, choice.player.name, ''),
        lore=lore, worldbook=book, worldbookRef=book_ref, notes='', greetingIndex=choice.greetingIndex,
        hasPortrait=card.portrait is not None, portrait_rules=rules_for(card.portraits), state_fields=card.state_fields,
        media=card.media, media_issues=card.media_issues, scene_media_rules=card.scene_media_rules,
        native_panels=card.native_panels, invalid_native_panels=card.invalid_native_panels,
        mvu=mvu, mvu_public=mvu_public, mvu_legacy=legacy_mvu or pinned_mvu is not None,
        pinned_mvu=pinned_mvu, pinned_mvu_issue=pinned_mvu_issue,
        pinned_mvu_status=card.legacy_mvu_status if legacy_state and legacy_state.pinned_setup else None,
        gameplay_pack=card.gameplay_pack, web_panel=web_panel, web_panel_ready=web_panel is None,
        web_panel_issue=web_panel_issue, legacy_opening_web=legacy_state, scripts=scripts,
        script_state=script_state, opening_schema=schema, opening_gameplay_issue=opening_gameplay_issue,
    ), enable_scripts
