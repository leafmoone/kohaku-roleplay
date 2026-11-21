"""Prepare the supported resource graph for a selected card without running it."""
from collections.abc import Callable
from pathlib import Path
from time import monotonic

from .errors import CardError
from .library import get_card, original_card
from .module_library import module_sources, save_discovered_module, saved_modules
from .module_linker import RETRYABLE_MODULE_ISSUES, ModuleLinkError, _virtual_graph
from .opening_page_library import opening_module_plan, opening_page_snapshot, prepare_opening_assets
from .pinned_mvu import PINNED_HELPER, cached_pinned_helper, helper_text, pinned_card_author
from .script_values import CardScriptError
from .status_portrait import declared_status_portrait, prepare_status_portrait
from .tavern_artifacts import artifact_issue, inspect_tavern_artifacts


def prepare_card_assets(directory: Path, card_id: str) -> dict:
    card = get_card(directory, card_id, with_scripts=True)
    deadline = monotonic() + 30
    issues = []
    failed_urls: set[str] = set()

    def before_fetch():
        if monotonic() >= deadline:
            raise CardError('Resource preparation timed out; retry to continue from the saved resources')

    def load(url: str, use: Callable[[], bytes], kind: str) -> bytes | None:
        if url in failed_urls:
            return None
        try:
            before_fetch()
            return use()
        except CardError as exc:
            failed_urls.add(url)
            issues.append({'kind': kind, 'id': url, 'message': str(exc)})
            return None

    if page := card.legacy_remote_opening:
        try:
            prepare_opening_assets(directory, card_id, page.url, before_fetch,
                                   lambda url, use: load(url, use, 'opening'))
        except (CardError, ModuleLinkError) as exc:
            issues.append({'kind': 'opening', 'id': page.url, 'message': str(exc)})
    scripts = [s for s in card.scripts if s.enabled and (s.issue is None or s.issue in RETRYABLE_MODULE_ISSUES)]
    if author := pinned_card_author(card):
        # The fixed core and helper dependencies are assembled locally. Cache
        # only the exact helper declaration needed by this profile.
        try:
            if cached_pinned_helper(directory, card_id) is None:
                helper = load(PINNED_HELPER, lambda: save_discovered_module(directory, card_id, PINNED_HELPER), 'script')
                if helper is not None:
                    helper_text(helper)
        except CardScriptError as exc:
            issues.append({'kind': 'script', 'id': author.id, 'name': author.name, 'message': str(exc)})
        if url := declared_status_portrait(card):
            load(url, lambda: prepare_status_portrait(directory, card_id, url), 'status-image')
    elif scripts:
        remote = module_sources(directory, card_id)
        raw = original_card(directory, card_id)
        for script in scripts:
            try:
                _virtual_graph(script.content, remote, raw, prepare=lambda url: load(
                    url, lambda: save_discovered_module(directory, card_id, url), 'script'))
            except (CardError, ModuleLinkError) as exc:
                issues.append({'kind': 'script', 'id': script.id, 'name': script.name, 'message': str(exc)})
    artifacts = inspect_tavern_artifacts(card.book)
    issues.extend({'kind': 'runtime', 'id': item['id'] or item['kind'], 'message': artifact_issue(item)}
                  for item in artifacts)
    return {'modules': saved_modules(directory, card_id),
            'tavernArtifacts': artifacts,
            'openingPage': opening_page_snapshot(directory, card_id) if page else None,
            'openingPlan': opening_module_plan(directory, card_id) if page else None,
            'issues': issues}
