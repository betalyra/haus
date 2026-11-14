"""The canonical form, equality and hashing (spec §12): one exact text per
value, the same in every binding. Equal values (§2) have identical canonical
forms, so `hash` is the same whatever the layout, comments, key order or
spelling of the document the value came from.

    >>> import haus
    >>> haus.canonical(haus.parse('Order { total: 19.90, id: 0xFF, "x-y": 1e+5 }'))
    'Order{id:255,total:19.90,"x-y":1e5}'
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable, Mapping
from decimal import Decimal
from typing import Self

from ._parser import DEFAULT_LIMITS
from ._value import Array, Bytes, Number, Record, String, Value, Variant

_BARE_KEY = re.compile(r"[a-z_][A-Za-z0-9_]*")
_INTEGER = re.compile(r"-?[0-9]+")
# What a string can't hold raw: quote, backslash, control and bidi characters.
_ESCAPED = re.compile(r'["\\\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]')
_SHORT_ESCAPES = {'"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def _escape(m: re.Match[str]) -> str:
    c = m[0]
    return _SHORT_ESCAPES.get(c) or f"\\u{{{ord(c):X}}}"


def quote(s: str) -> str:
    """A `"…"` string with the minimal escapes; the rest as `\\u{…}` in uppercase hex."""
    return '"' + _ESCAPED.sub(_escape, s) + '"'


def number_text(text: str) -> str:
    """A normalized literal, or an integer too long for the default number limit in lowercase hex."""
    if len(text) <= DEFAULT_LIMITS.max_number_length or not _INTEGER.fullmatch(text):
        return text
    sign, digits = ("-", text[1:]) if text.startswith("-") else ("", text)
    # Via Decimal: `int(str)` refuses more than 4300 digits.
    return f"{sign}0x{int(Decimal(digits)):x}"


def _write(v: Value) -> str:
    match v:
        case Number(text):
            return number_text(text)
        case String(s):
            return quote(s)
        case Bytes(data):
            return f'x"{data.hex()}"'
        case Array(items):
            return "[" + ",".join(map(_write, items)) + "]"
        case Record(fields):
            return _record(fields)
        case Variant(tag, ()):
            return tag
        case Variant(tag, (Record(fields),)):
            return tag + _record(fields)
        case Variant(tag, args):
            return f"{tag}(" + ",".join(map(_write, args)) + ")"


def _key(k: str) -> str:
    return k if _BARE_KEY.fullmatch(k) else quote(k)


def _record(fields: Mapping[str, Value]) -> str:
    # `str` order is code point order, which is the order of the UTF-8 bytes.
    return "{" + ",".join(f"{_key(k)}:{_write(fields[k])}" for k in sorted(fields)) + "}"


def canonical(value: Value) -> str:
    """The canonical form of a value (spec §12)."""
    return _write(value)


def equals(a: Value, b: Value) -> bool:
    """Whether two values are equal (spec §2): the same canonical form."""
    return canonical(a) == canonical(b)


def compare(a: Value, b: Value) -> int:
    """Orders values by the bytes of their canonical forms (spec §12): -1, 0 or 1.

    A total order consistent with `equals`, for sorting
    (`sorted(values, key=functools.cmp_to_key(compare))`) and ordered maps.
    Not numeric order: `10` sorts before `9`.
    """
    x, y = canonical(a), canonical(b)
    return (x > y) - (x < y)


def hash(value: Value) -> str:
    """The SHA-256 digest of the canonical form, as 64 lowercase hex digits (spec §12)."""
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


class Hasher:
    """Hashes a list of values as it grows, e.g. a stream while it is read (spec §12).

    `digest()` gives `hash_all` of the values added so far, at any time.
    Memory stays bounded by the largest value.

        >>> import haus
        >>> h = haus.Hasher()
        >>> for v in haus.parse_all("1, 2,"):
        ...     _ = h.add(v)
        >>> h.digest() == haus.hash_all(haus.parse_all("1, 2"))
        True
    """

    __slots__ = ("_empty", "_sha")

    def __init__(self) -> None:
        self._sha = hashlib.sha256()
        self._empty = True

    def add(self, value: Value) -> Self:
        """Add the next value."""
        if not self._empty:
            self._sha.update(b",")
        self._empty = False
        self._sha.update(canonical(value).encode("utf-8"))
        return self

    def digest(self) -> str:
        """`hash_all` of the values added so far, as 64 lowercase hex digits."""
        return self._sha.copy().hexdigest()


def hash_all(values: Iterable[Value]) -> str:
    """The hash of a list of values, such as a whole file or stream (spec §12).

    The SHA-256 digest of their canonical forms joined by `,`. A list of one
    value hashes like the value: `hash_all([v]) == hash(v)`.
    """
    hasher = Hasher()
    for v in values:
        hasher.add(v)
    return hasher.digest()
