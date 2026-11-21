"""Compute an MVU update and its script receipts without committing a session."""

from asyncio import to_thread

from .card_scripts import CardScript
from .mvu import MvuChange, MvuInit, apply_changes
from .mvu_legacy import apply_literal_update
from .script_session import SessionScripts, settled_mvu_scripts
from .script_tool import run_mvu_update


async def settle_mvu_candidate(mvu: MvuInit, state: SessionScripts, update: str | list[MvuChange],
                               scripts: list[CardScript]) -> tuple[MvuInit, SessionScripts]:
    if scripts:
        wire = update if isinstance(update, str) else [change.model_dump() for change in update]
        values, notices, added = await to_thread(run_mvu_update, scripts, mvu.values, wire, state.appended_buttons)
        state = settled_mvu_scripts(state, notices, added)
    elif isinstance(update, str):
        values = apply_literal_update(mvu.values, update)
    else:
        values = apply_changes(mvu.values, update)
    return mvu.model_copy(update={'values': values}), state
