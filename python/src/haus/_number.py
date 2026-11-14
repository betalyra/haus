"""Number literals built in code (spec §9.8): normalized as the parser would,
and checked against the same limits before they are written.

    >>> normalize_number("1E+05"), normalize_number("0xFF"), normalize_number("1.")
    ('1e5', '255', None)
"""

from __future__ import annotations

import math
import re
from decimal import Decimal

from ._parser import DEFAULT_LIMITS, Limits, Parser

INTEGER = re.compile(r"-?[0-9]+")
"""A normalized literal that is a whole number: digits with an optional `-` (`-0` included)."""

# Exactly what the parser writes: no `_`, `+`, `E`, hex or binary, no leading zeros in the exponent.
_NORMALIZED = re.compile(r"-?(?:0|[1-9][0-9]*+)(?:\.[0-9]++)?(?:e(?:0|-?[1-9][0-9]*+))?")
_EXPONENT = re.compile(r"e-?([0-9]+)$")
# A whole number of d decimal digits has at least floor((d - 1) * log16(10)) + 1 hex digits.
_HEX_PER_DECIMAL = math.log(10) / math.log(16)


def normalize_number(text: str, limits: Limits = DEFAULT_LIMITS) -> str | None:
    """The normalized text of one number literal (`1_000` → `1000`), or None if `text` isn't one."""
    if _NORMALIZED.fullmatch(text):
        return text
    return Parser(text, limits).number_literal()


def to_int(text: str) -> int:
    """A whole-number literal as an `int`, also beyond CPython's 4300-digit limit of `int(str)`."""
    return int(text) if len(text) < 4000 else int(Decimal(text))


def int_text(n: int) -> str:
    """`str(n)`, also beyond CPython's 4300-digit limit."""
    return str(n) if n.bit_length() < 13000 else str(Decimal(n))


def _shortest_length(text: str, limit: int) -> int:
    """The length of the shortest literal of a normalized number: long whole numbers can be hex (spec §12)."""
    if len(text) <= limit or not INTEGER.fullmatch(text):
        return len(text)
    sign = 1 if text.startswith("-") else 0
    digits = len(text) - sign
    at_least = sign + 2 + math.floor((digits - 1) * _HEX_PER_DECIMAL) + 1
    if at_least > limit:
        return at_least  # too long either way
    return min(len(text), sign + 2 + (abs(to_int(text)).bit_length() + 3) // 4)


def number_limit_issue(text: str, limits: Limits) -> str | None:
    """Why the normalized number `text` is outside `limits`, or None. Parsed numbers are always within."""
    if (m := _EXPONENT.search(text)) and (len(m[1]) > 15 or int(m[1]) > limits.max_exponent):
        return f"exponent larger than {limits.max_exponent}"
    if _shortest_length(text, limits.max_number_length) > limits.max_number_length:
        return f"number literal longer than {limits.max_number_length} characters"
    return None
