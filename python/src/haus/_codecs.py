"""Opt-in host types (codecs, spec §13.4). Each keeps less than the haus value,
so encoding what it decoded can give a different value (another hash): the
application chooses them explicitly, by type id.

    schema.compile_schema(text, codecs={"prelude#Decimal": DecimalCodec()})
"""

from __future__ import annotations

import datetime as dt
import re
from decimal import Decimal, InvalidOperation

_FRACTION = re.compile(r"(\.[0-9]{6})[0-9]+")


class DecimalCodec:
    """`Decimal` as `decimal.Decimal`. Drops the spelling of the exponent.

    `decimal.Decimal` keeps the scale (`19.90`) and `-0`, but not how the exponent was
    written: `15e2` and `1.5e3` are both `Decimal('1.5E+3')`, written back as `1.5e3`.
    Its `==` also ignores scale (`Decimal("19.90") == Decimal("19.9")`), unlike haus (§3).
    """

    def decode(self, value: object, /) -> Decimal:
        assert isinstance(value, str)
        try:
            return Decimal(value)
        except InvalidOperation:
            raise ValueError("not a decimal") from None

    def encode(self, value: object, /) -> object:
        if not isinstance(value, Decimal) or not value.is_finite():
            raise TypeError("expected a finite decimal.Decimal")
        return value


class DateCodec:
    """std/time `Date` as `datetime.date`. Keeps the value; rejects the year 0000, which Python lacks."""

    def decode(self, value: object, /) -> dt.date:
        assert isinstance(value, str)
        return dt.date.fromisoformat(value)

    def encode(self, value: object, /) -> object:
        if not isinstance(value, dt.date) or isinstance(value, dt.datetime):
            raise TypeError("expected a datetime.date")
        return value.isoformat()


class InstantCodec:
    """std/time `Instant` as an aware `datetime.datetime`. Keeps the instant and its offset.

    Drops: digits of the fraction beyond microseconds (truncated), the spelling of the
    fraction (`.25` is written `.250000`), and `Z` versus `+00:00` (written `Z`).
    Rejects the year 0000.
    """

    def decode(self, value: object, /) -> dt.datetime:
        assert isinstance(value, str)
        return dt.datetime.fromisoformat(_FRACTION.sub(r"\1", value))

    def encode(self, value: object, /) -> object:
        if not isinstance(value, dt.datetime) or value.utcoffset() is None:
            raise TypeError("expected an aware datetime.datetime")
        text = value.isoformat()
        return text.removesuffix("+00:00") + "Z" if value.utcoffset() == dt.timedelta(0) else text
