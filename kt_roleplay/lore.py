"""Select enabled character-book entries for one request, in insertion order."""

from collections.abc import Callable, Sequence

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .errors import CardError


class LoreEntry(BaseModel):
    model_config = ConfigDict(strict=True)
    keys: list[str]
    content: str
    enabled: bool
    insertion_order: int
    name: str = ""
    comment: str = ""
    secondary_keys: list[str] = Field(default_factory=list)
    selective: bool = False
    constant: bool = False
    case_sensitive: bool = False
    priority: int = 0
    position: str = "after_char"

    def matches(self, text: str) -> bool:
        if not self.enabled:
            return False
        if self.constant:
            return True
        haystack = text if self.case_sensitive else text.casefold()
        def found(keys: list[str]) -> bool:
            return any(key and (key if self.case_sensitive else key.casefold()) in haystack for key in keys)
        return found(self.keys) and (not self.selective or found(self.secondary_keys))


class LoreBook(BaseModel):
    model_config = ConfigDict(strict=True)
    entries: list[LoreEntry]
    scan_depth: int = Field(default=4, ge=0)
    token_budget: int = Field(default=512, ge=0)


def load_book(data: dict[str, object]) -> LoreBook:
    try:
        return LoreBook.model_validate(data)
    except ValidationError as exc:
        fields = ", ".join(".".join(map(str, part['loc'])) for part in exc.errors(include_input=False))
        raise CardError(f"Invalid character_book fields: {fields}") from exc


def active_entries(book: LoreBook, history: Sequence[str], cost: Callable[[str], int], allowance: int) -> list[LoreEntry]:
    visible = "\n".join(history[-book.scan_depth:]) if book.scan_depth else ""
    budget = min(book.token_budget, allowance)
    chosen = []
    for entry in sorted(book.entries, key=lambda item: -item.priority):
        if entry.matches(visible):
            size = cost(entry.content)
            if size <= budget:
                chosen.append(entry)
                budget -= size
    return sorted(chosen, key=lambda item: item.insertion_order)
