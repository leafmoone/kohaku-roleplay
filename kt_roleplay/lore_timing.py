"""Session-local activation times for bounded world-info timed effects."""

from dataclasses import dataclass, field


@dataclass
class LoreTiming:
    count: int
    previous: dict[str, int] = field(default_factory=dict)
    next: dict[str, int] = field(default_factory=dict)

    def status(self, index: int, sticky: int, cooldown: int) -> str:
        key = str(index)
        start = self.previous.get(key)
        if start is None or start > self.count or not (sticky or cooldown):
            return "normal"
        age = self.count - start
        # The triggering message is the first slot; same-message tool continuations reuse it.
        active_slots = max(1, sticky)
        if age < active_slots:
            self.next[key] = start
            return "active"
        if age < active_slots + cooldown:
            self.next[key] = start
            return "cooldown"
        return "normal"

    def activate(self, index: int, sticky: int, cooldown: int) -> None:
        if sticky or cooldown:
            self.next.setdefault(str(index), self.count)
