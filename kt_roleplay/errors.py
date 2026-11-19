"""Character import errors for the library and runtime adapters."""


class CardError(ValueError):
    """An input file is not a supported, readable character card."""


class SettlementRejected(ValueError):
    """A single tool call failed validation before its state could be saved."""

    def __str__(self) -> str:
        return f"{super().__str__()}. No changes from this call were saved. Do not repeat other successful calls."
