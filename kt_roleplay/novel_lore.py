"""Select worldbook references within one director-only context budget."""

from asyncio import to_thread
from collections.abc import Callable

from .cards import CardFields
from .cast import NovelSettings, WorldbookSnapshot
from .lore import active_entries
from .lore_regex import MatchBudget
from .lore_templates import render_templates
from .projections import Player, depth_lore, render_tavern_text
from .worldbook import TEMPLATE_BOOK_BUDGET


async def novel_lore(messages: list[dict], books: list[WorldbookSnapshot], settings: NovelSettings,
                     text: Callable[[dict], str], cost: Callable[[str], int]) -> list[str]:
    if not books:
        return []
    history = [text(row) for row in messages if row.get("role") in ("user", "assistant")]
    player = Player(name=settings.playerName)
    narrator = settings.narrator
    voice = CardFields(name=narrator.name if narrator else settings.title, description="", personality="",
                       scenario="", first_mes="", mes_example="")
    templates = list(dict.fromkeys(entry.content for row in books for entry in row.book.entries
                                   if entry.enabled and entry.content_template))
    rendered = (await to_thread(render_templates, templates, {}, player.name))[0] if templates else {}
    remaining = TEMPLATE_BOOK_BUDGET if templates else 2048
    regex_budget = MatchBudget()

    def rendered_cost(value: str) -> int:
        return cost(render_tavern_text(value, voice, player))

    selected = []
    for row in books:
        chosen = active_entries(row.book, history, rendered_cost, remaining,
                                regex_budget=regex_budget, rendered_templates=rendered)
        selected.extend(chosen)
        remaining -= sum(rendered_cost(entry.content) for entry in chosen)
        if remaining <= 0:
            break
    ordered = [*depth_lore(selected), *(entry for entry in selected if entry.position != "at_depth")]
    return [render_tavern_text(entry.content, voice, player) for entry in ordered]
