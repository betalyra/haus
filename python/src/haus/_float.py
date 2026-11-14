"""Floats with a schema (spec §15): a number literal rounded to the nearest
binary64 or binary32 value, and a float written in its one spelling.

Python's `float()` rounds a decimal to binary64 correctly, and `repr` writes
the fewest digits that read back, the closest of them, ties to even. Binary32
has neither, so it is computed exactly with integers, as in the Lean model
(spec/lean/Haus/Schema/Float.lean): rounding to binary64 first and then to
binary32 can be off by one unit.

    >>> to_float32("0.1") == 0.100000001490116119384765625
    True
    >>> float_text(to_float32("0.1") or 0.0, "Float32")
    '0.1'
    >>> float_text(1e21, "Float64"), float_text(1.5e-7, "Float64"), float_text(-0.0, "Float64")
    ('1e21', '1.5e-7', '-0')
"""

from __future__ import annotations

import math
import re
from typing import Literal, NamedTuple

FloatKind = Literal["Float64", "Float32"]


class _Format(NamedTuple):
    """A binary format: finite values are m * 2^q with m < 2^prec and emin ≤ q ≤ emax."""

    prec: int
    emin: int
    emax: int


_BINARY64 = _Format(53, -1074, 971)
_BINARY32 = _Format(24, -149, 104)

_LITERAL = re.compile(r"(-?)([0-9]+)(?:\.([0-9]+))?(?:e(-?[0-9]+))?")


def _decimal(literal: str) -> tuple[bool, int, int]:
    """A normalized number literal as sign, digits and exponent: `-1.50e3` is (True, 150, 1)."""
    m = _LITERAL.fullmatch(literal)
    if m is None:
        raise ValueError(f"not a normalized number literal: {literal!r}")
    sign, whole, fraction, exponent = m.groups()
    fraction = fraction or ""
    return sign == "-", int(whole + fraction), int(exponent or "0") - len(fraction)


def _ratio(m: int, e: int) -> tuple[int, int]:
    """m * 10^e as a fraction a / b."""
    return (m * 10**e, 1) if e >= 0 else (m, 10**-e)


def _round_div(a: int, b: int) -> int:
    """a / b rounded to an integer, ties to even."""
    q, r = divmod(a, b)
    return q + 1 if 2 * r > b or (2 * r == b and q % 2 == 1) else q


def _round(fmt: _Format, a: int, b: int) -> tuple[int, int] | None:
    """The m * 2^q of `fmt` nearest to a / b > 0 (ties to even); None if it rounds to infinity."""
    # ⌊log₂(a / b)⌋ is the difference of the bit lengths, or one less.
    t = a.bit_length() - b.bit_length()
    top = t if (a >= b << t if t >= 0 else a << -t >= b) else t - 1
    q = max(top - (fmt.prec - 1), fmt.emin)
    m = _round_div(a, b << q) if q >= 0 else _round_div(a << -q, b)
    if m == 1 << fmt.prec:  # rounding up carried into the next binade
        m, q = m >> 1, q + 1
    return None if q > fmt.emax else (m, q)


def to_float64(literal: str) -> float | None:
    """The nearest binary64 value of a normalized number literal; None if it is too large.

    >>> to_float64("19.90"), to_float64("-1e-400"), to_float64("1e400")
    (19.9, -0.0, None)
    """
    _decimal(literal)  # only literals: `float` would also read "inf", "1_0" and " 1"
    x = float(literal)
    return x if math.isfinite(x) else None


def to_float32(literal: str) -> float | None:
    """The nearest binary32 value of a normalized number literal, rounded directly
    from its exact decimal value (ties to even), as a `float`; None if it is too large.

    >>> to_float32("16777217"), to_float32("3.4028236e38")
    (16777216.0, None)
    """
    neg, m, e = _decimal(literal)
    # Far outside binary32, binary64 already decides: a literal that is 0 as binary64
    # is at most 2^-1075 (0 as binary32 too), and one that overflows is past 2^1023.
    x = float(literal)
    if x == 0 or m == 0:
        return -0.0 if neg else 0.0
    if math.isinf(x):
        return None
    rounded = _round(_BINARY32, *_ratio(m, e))
    if rounded is None:
        return None
    f = math.ldexp(*rounded)  # exact: 24 bits, and q ≥ -149
    return -f if neg else f


def _parts(x: float, fmt: _Format) -> tuple[int, int]:
    """The m * 2^q of `fmt` nearest to |x| > 0, which is x itself when x is a value of `fmt`."""
    rounded = _round(fmt, *abs(x).as_integer_ratio())
    if rounded is None:
        raise ValueError(f"{x!r} is out of range for the float type")
    return rounded


def _reads_back(fmt: _Format, target: tuple[int, int], d: int, e: int) -> bool:
    """Does d * 10^e round to the float m * 2^q of `fmt`?"""
    return d > 0 and _round(fmt, *_ratio(d, e)) == target


def _shortest(fmt: _Format, x: tuple[int, int]) -> tuple[int, int]:
    """The fewest digits d (and e) such that d * 10^e rounds back to x = m * 2^q > 0,
    the closest of them, ties to even. As `shortest` in the Lean model."""
    m, q = x
    a, b = (m << q, 1) if q >= 0 else (m, 1 << -q)
    # n with 10^(n-1) ≤ a / b < 10^n
    n = len(str(a)) - len(str(b))
    if (a >= b * 10**n) if n >= 0 else (a * 10**-n >= b):
        n += 1
    k = 1
    while True:
        e = n - k
        num, den = (a, b * 10**e) if e >= 0 else (a * 10**-e, b)
        lo, r = divmod(num, den)
        ok_lo = _reads_back(fmt, x, lo, e)
        ok_hi = r != 0 and _reads_back(fmt, x, lo + 1, e)
        if ok_lo and ok_hi:
            return (lo if 2 * r < den or (2 * r == den and lo % 2 == 0) else lo + 1), e
        if ok_lo or ok_hi:
            return (lo if ok_lo else lo + 1), e
        k += 1


def _repr_digits(x: float) -> tuple[int, int]:
    """repr's digits d and exponent e of a finite x > 0, with the value d * 10^e."""
    mantissa, _, exponent = repr(x).partition("e")
    whole, _, fraction = mantissa.partition(".")
    return int(whole + fraction), int(exponent or "0") - len(fraction)


def _layout(d: int, e: int) -> str:
    """d * 10^e laid out like JavaScript's `Number.prototype.toString`, without `+` (spec §15)."""
    digits = str(d).rstrip("0")
    e += len(str(d)) - len(digits)
    k = len(digits)
    n = e + k  # the value is 0.d₁…dₖ * 10^n
    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return f"{digits[:n]}.{digits[n:]}"
    if -6 < n <= 0:
        return "0." + "0" * -n + digits
    rest = f".{digits[1:]}" if k > 1 else ""
    return f"{digits[0]}{rest}e{n - 1}"


def float_text(x: float, kind: FloatKind) -> str:
    """The one spelling of a finite float (spec §15): the fewest digits that read back
    as the same value of the type (of two equally close, the even one), in JavaScript's
    layout without `+` in the exponent, and `-0` for negative zero.

    A `Float32` is written as the nearest binary32 value of `x` (`x` itself when it
    holds one). Raises `ValueError` for NaN and the infinities, which are the tags
    `NaN`, `Infinity` and `NegInfinity`, and for a `Float32` out of its range.

    >>> float_text(2097152.25, "Float32"), float_text(1690060720831323.25, "Float64")
    ('2097152.2', '1690060720831323.2')
    """
    if not math.isfinite(x):
        raise ValueError(f"{x!r} has no number spelling; it is written as a tag")
    sign = "-" if math.copysign(1.0, x) < 0 else ""
    if x == 0:
        return sign + "0"
    if kind == "Float64":
        # repr gives the fewest digits that read back, the closest, ties to even (David Gay's dtoa).
        return sign + _layout(*_repr_digits(abs(x)))
    parts = _parts(x, _BINARY32)
    return sign + ("0" if parts[0] == 0 else _layout(*_shortest(_BINARY32, parts)))
