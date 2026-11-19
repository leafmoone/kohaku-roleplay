"""Match bounded Tavern-style regex keywords without running JavaScript."""

import re
from functools import lru_cache
from time import perf_counter

try:
    import regex
except ImportError:  # --no-deps installations can still use literal keywords.
    regex = None

_DELIMITED = re.compile(r"/(.+)/([a-zA-Z]*)", re.S)
_REPEAT = re.compile(r"(?<!\\)\{([0-9]+)(?:,([0-9]*))?\}")
_EXTENSION = re.compile(r"\(\?(?![:=!]|<[=!])|\(\*|\)\{")
_MAX_PATTERN = 256
_MAX_TEXT = 8_192
_FLAGS = frozenset("imsu")


def is_regex_key(key: str) -> bool:
    return _DELIMITED.fullmatch(key) is not None


@lru_cache(maxsize=512)
def _compiled(key: str):
    if regex is None or (match := _DELIMITED.fullmatch(key)) is None:
        return None
    pattern, flags = match.groups()
    if len(pattern) > _MAX_PATTERN or set(flags) - _FLAGS or len(set(flags)) != len(flags):
        return None
    if _EXTENSION.search(pattern) or any(len(n) > 3 or int(n) > 200 for bounds in _REPEAT.findall(pattern) for n in bounds if n):
        return None
    options = regex.VERSION0
    for letter, flag in (("i", regex.I), ("m", regex.M), ("s", regex.S)):
        if letter in flags:
            options |= flag
    try:
        return regex.compile(pattern, options)
    except (regex.error, OverflowError, RecursionError):
        return None


def valid_regex_key(key: str) -> bool:
    return _compiled(key) is not None


class MatchBudget:
    """Limit total regex execution for one prompt, across books and recursion."""

    def __init__(self) -> None:
        self.remaining = 0.025

    def found(self, key: str, text: str) -> bool:
        if self.remaining <= 0 or (pattern := _compiled(key)) is None:
            raise TimeoutError("World-info regex unavailable or exhausted")
        timeout = min(self.remaining, 0.005)
        start = perf_counter()
        try:
            result = bool(pattern.search(text[-_MAX_TEXT:], timeout=timeout))
        except TimeoutError:
            # The engine can reject sub-clock-resolution timeouts immediately on Windows.
            self.remaining -= max(timeout, perf_counter() - start)
            raise
        self.remaining -= perf_counter() - start
        return result
