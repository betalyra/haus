"""The haus data model, exactly as written in the source (spec §1).

No schema has been applied: numbers keep their exact literal text, and
variants are generic. Equality follows spec §2: field order doesn't matter,
`1.0` and `1` are different numbers, and `Tag { … }` equals `Tag({ … })`.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import TypeAlias


@dataclass(frozen=True, slots=True)
class Number:
    """An exact number: the normalized literal (spec §2).

    Digit separators are removed, the exponent is written as its value, and
    hex and binary literals become decimal integers: `"19.90"`, `"-1e10"`, `"255"`.
    """

    text: str

    def is_integer_literal(self) -> bool:
        """Whether the literal is written as an integer (no fraction, no exponent)."""
        return "." not in self.text and "e" not in self.text

    def to_int(self) -> int:
        """The value as an `int`. Raises `ValueError` unless it is written as an integer."""
        if not self.is_integer_literal():
            raise ValueError(f"not an integer literal: {self.text}")
        return int(self.text)

    def to_decimal(self) -> Decimal:
        """The exact value. `Decimal` keeps the scale: `19.90` stays `19.90`."""
        return Decimal(self.text)


@dataclass(frozen=True, slots=True)
class String:
    value: str


@dataclass(frozen=True, slots=True)
class Bytes:
    """A byte string, written `x"0b34ff"`."""

    data: bytes


@dataclass(frozen=True, slots=True)
class Array:
    items: tuple[Value, ...]


@dataclass(frozen=True, slots=True)
class Record:
    """Fields in source order. Keys are data: they never become attributes (spec §9.4)."""

    fields: Mapping[str, Value]


@dataclass(frozen=True, slots=True)
class Variant:
    """A tag with zero or more arguments. `Tag { … }` has one `Record` argument."""

    tag: str
    args: tuple[Value, ...] = ()


Value: TypeAlias = Number | String | Bytes | Array | Record | Variant
