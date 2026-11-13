from __future__ import annotations


class HausSyntaxError(ValueError):
    """Input that isn't valid haus. The position is 1-based; columns count code points (spec §8)."""

    reason: str
    """The message without the position."""
    offset: int
    """Offset in code points from the start of the text."""
    line: int
    column: int

    def __init__(self, reason: str, offset: int, line: int, column: int) -> None:
        super().__init__(f"{reason} at {line}:{column}")
        self.reason = reason
        self.offset = offset
        self.line = line
        self.column = column

    @classmethod
    def at(cls, text: str, pos: int, reason: str) -> HausSyntaxError:
        """An error at code point `pos` of `text`."""
        last_newline = text.rfind("\n", 0, pos)
        return cls(reason, pos, text.count("\n", 0, pos) + 1, pos - last_newline)
