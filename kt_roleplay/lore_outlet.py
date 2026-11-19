"""Finite, one-pass expansion of named world-info outlets in approved fields."""

import re
from collections.abc import Callable, Iterable

from .lore import LoreEntry

_OUTLET = re.compile(r"\{\{outlet::([^{}\r\n]{1,120})\}\}")


def referenced_outlets(*sources: str) -> frozenset[str]:
    return frozenset(match[1].strip() for source in sources for match in _OUTLET.finditer(source))


def outlet_expander(entries: Iterable[LoreEntry], render: Callable[[str], str]) -> Callable[[str], str]:
    items: dict[str, list[str]] = {}
    for entry in sorted(entries, key=lambda item: item.insertion_order):
        if entry.position == "outlet":
            items.setdefault(entry.outlet_name, []).append(_OUTLET.sub("", render(entry.content)))

    def expand(text: str) -> str:
        # Each named outlet expands at most once: duplicate references cannot bypass the token budget.
        return _OUTLET.sub(lambda match: "\n".join(items.pop(match[1].strip(), [])), text)

    return expand
