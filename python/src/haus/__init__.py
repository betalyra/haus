"""haus: a data format for humans, friendly to write and pleasant to read.

Without a schema, `parse_all` reads any haus text into `Value`s:

    >>> import haus
    >>> haus.parse('{ name: "Ada", born: Date("1815-12-10") }')
    Record(fields={'name': String(value='Ada'), 'born': Variant(tag='Date', args=(String(value='1815-12-10'),))})

This is a parser in the sense of spec §13.1: it reads the syntax and knows no
types. `Date("2026-02-30")` is just a tag with a string.
"""

from __future__ import annotations

from ._errors import HausSyntaxError
from ._parser import DEFAULT_LIMITS, Limits, Parser
from ._value import Array, Bytes, Number, Record, String, Value, Variant

__version__ = "0.0.1"

__all__ = [
    "DEFAULT_LIMITS",
    "Array",
    "Bytes",
    "HausSyntaxError",
    "Limits",
    "Number",
    "Record",
    "String",
    "Value",
    "Variant",
    "__version__",
    "parse",
    "parse_all",
    "parse_bytes",
]


def parse_all(text: str, *, limits: Limits = DEFAULT_LIMITS) -> list[Value]:
    """Parse a file: zero or more top-level values, separated by commas."""
    return Parser(text, limits).parse_sequence()


def parse(text: str, *, limits: Limits = DEFAULT_LIMITS) -> Value:
    """Parse a text that must hold exactly one value (spec §6)."""
    values = parse_all(text, limits=limits)
    if len(values) != 1:
        raise HausSyntaxError(f"expected exactly one value, found {len(values)}", 0, 1, 1)
    return values[0]


def parse_bytes(data: bytes, *, limits: Limits = DEFAULT_LIMITS) -> list[Value]:
    """Parse raw bytes, which must be UTF-8. A leading byte order mark is skipped."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as e:
        valid = data[: e.start].decode("utf-8")
        raise HausSyntaxError.at(valid, len(valid), "invalid UTF-8") from None
    return parse_all(text, limits=limits)
