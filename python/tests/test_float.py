"""Floats (spec §15): decoding a literal to binary64 and binary32, and the one
spelling of a float. Checked against the Lean model's cases
(spec/lean/Haus/Schema/Float.lean), vectors from the TypeScript binding, and
an independent oracle with `fractions` and `decimal`."""

from __future__ import annotations

import math
import random
import struct
from decimal import ROUND_CEILING, ROUND_FLOOR, Context, Decimal
from fractions import Fraction

import pytest

from haus._float import float_text, to_float32, to_float64

# ── helpers ──────────────────────────────────────────────────

EXACT = Context(prec=5000)
"""Enough digits for any sum here: decimal arithmetic without rounding."""


def f32(bits: int) -> float:
    return float(struct.unpack(">f", bits.to_bytes(4, "big"))[0])


def bits32(x: float) -> int:
    return int.from_bytes(struct.pack(">f", x), "big")


def f64(bits: int) -> float:
    return float(struct.unpack(">d", bits.to_bytes(8, "big"))[0])


def bits64(x: float) -> int:
    return int.from_bytes(struct.pack(">d", x), "big")


def literal(d: Decimal) -> str:
    """An exact decimal as a normalized haus literal: `1.5e-7`, `255`."""
    sign, digits, exponent = d.as_tuple()
    assert isinstance(exponent, int)
    text = "".join(map(str, digits))
    return ("-" if sign else "") + text + (f"e{exponent}" if exponent else "")


def exact(x: float) -> str:
    """The exact decimal value of a float, as a literal."""
    return literal(Decimal(x))


def same(a: float | None, b: float | None) -> bool:
    """The same float, telling 0 from -0."""
    return (a is None and b is None) or (a is not None and b is not None and bits64(a) == bits64(b))


def nearest32(text: str) -> float | None:
    """An oracle for `to_float32`: the closest binary32 value to the exact decimal
    among the neighbours of a first guess, ties to the even bit pattern."""
    x = Fraction(Decimal(text))
    limit = Fraction(2**128 - 2**103)
    if abs(x) >= limit:
        return None
    guess = bits32(struct.unpack(">f", struct.pack(">f", float(x)))[0]) & 0x7FFFFFFF
    candidates = [b for b in (guess - 1, guess, guess + 1) if 0 <= b < 0x7F800000]
    best = min(candidates, key=lambda b: (abs(abs(x) - Fraction(f32(b))), b % 2))
    return -f32(best) if x < 0 or text.startswith("-") else f32(best)


def significant(text: str) -> str:
    """The significant digits of a spelling: `-1.5e-7` is `15`."""
    mantissa = text.lstrip("-").partition("e")[0].replace(".", "")
    return mantissa.strip("0")


# ── decoding ─────────────────────────────────────────────────

# The cases of test-suite/schema/numbers.cases.haus and of the Lean model: literal, spelling.
RESPELL_64: list[tuple[str, str | None]] = [
    ("0.10", "0.1"),
    ("1e2", "100"),
    ("123000", "123000"),
    ("12.25", "12.25"),
    ("0.000001", "0.000001"),
    ("1e-7", "1e-7"),
    ("0.00000015", "1.5e-7"),
    ("1e20", "100000000000000000000"),
    ("1e21", "1e21"),
    ("1.5e300", "1.5e300"),
    ("0.30000000000000004", "0.30000000000000004"),
    ("0.1000000000000000055", "0.1"),
    ("5e-324", "5e-324"),
    ("3e-324", "5e-324"),
    ("2e-324", "0"),
    ("-1e-400", "-0"),
    ("-0.0", "-0"),
    ("-0", "-0"),
    ("0", "0"),
    ("1.7976931348623157e308", "1.7976931348623157e308"),
    ("1.7976931348623158e308", "1.7976931348623157e308"),
    ("1.7976931348623159e308", None),
    ("1e400", None),
    ("-1e400", None),
    ("1690060720831323.25", "1690060720831323.2"),
    ("123456789012345680000", "123456789012345680000"),
    ("1.2345678901234568e21", "1.2345678901234568e21"),
    ("2.2250738585072014e-308", "2.2250738585072014e-308"),
    ("2.225073858507201e-308", "2.225073858507201e-308"),
    ("9007199254740993", "9007199254740992"),
    ("-123.456e-10", "-1.23456e-8"),
    ("19.90", "19.9"),
    ("255", "255"),
]

RESPELL_32: list[tuple[str, str | None]] = [
    ("0.1", "0.1"),
    ("16777217", "16777216"),
    ("1.000000059604644775390625", "1"),
    ("1.00000005960464477539062500000001", "1.0000001"),
    ("-1.00000005960464477539062500000001", "-1.0000001"),
    ("3.40282356e38", "3.4028235e38"),
    ("3.4028236e38", None),
    ("1e39", None),
    ("1e400", None),
    ("1e-46", "0"),
    ("-1e-46", "-0"),
    ("1e-400", "0"),
    ("1e21", "1e21"),
    ("2097152.25", "2097152.2"),
    ("2097152.75", "2097152.8"),
    ("-2097152.25", "-2097152.2"),
    ("1.4e-45", "1e-45"),
    ("7.1e-46", "1e-45"),
    ("7e-46", "0"),
    ("1.17549435e-38", "1.1754944e-38"),
    ("3.14159265358979", "3.1415927"),
    ("-0", "-0"),
]


@pytest.mark.parametrize(("lit", "text"), RESPELL_64)
def test_float64(lit: str, text: str | None) -> None:
    x = to_float64(lit)
    assert (None if x is None else float_text(x, "Float64")) == text


@pytest.mark.parametrize(("lit", "text"), RESPELL_32)
def test_float32(lit: str, text: str | None) -> None:
    x = to_float32(lit)
    assert (None if x is None else float_text(x, "Float32")) == text


def test_float32_rounds_from_the_exact_decimal() -> None:
    # 1 + 2^-24 is half way between 1 and 1 + 2^-23: as binary64 the literal just
    # above it is that tie, which binary32 would round down to 1.
    assert to_float32("1.000000059604644775390625") == 1
    assert to_float32("1.00000005960464477539062500000001") == 1 + 2**-23
    assert to_float32("-1.00000005960464477539062500000001") == -(1 + 2**-23)
    assert to_float32("1.00000017881393432617187499999999") == 1 + 2**-23
    assert to_float32("1.000000178813934326171875") == 1 + 2**-22
    # A double-rounding literal: binary64 lands on a tie that ties-to-even resolves the wrong way.
    lit = "1.00000005960464477539062500000001"
    assert struct.unpack(">f", struct.pack(">f", float(lit)))[0] == 1


def test_overflow_thresholds() -> None:
    # Binary64: half way between the largest value and 2^1024 rounds (to even) to infinity.
    half = 2**1024 - 2**970
    assert to_float64(str(half)) is None
    assert to_float64(str(half - 1)) == 1.7976931348623157e308
    assert to_float64("-" + str(half - 1)) == -1.7976931348623157e308
    # Binary32: half way between the largest value and 2^128.
    half32 = 2**128 - 2**103
    assert str(half32) == "340282356779733661637539395458142568448"
    assert to_float32(str(half32)) is None
    assert to_float32(str(half32 - 1)) == f32(0x7F7FFFFF)
    assert to_float32("-" + str(half32 - 1)) == -f32(0x7F7FFFFF)
    assert to_float32("3.40282356779733661637539395458142568448e38") is None
    assert to_float32("3.40282356779733661637539395458142568447999e38") == f32(0x7F7FFFFF)


def test_subnormals() -> None:
    # Binary64: half the smallest subnormal rounds (to even) to 0, anything above it up.
    assert to_float64(exact(2.0**-1074)) == 5e-324
    half = EXACT.divide(Decimal(2.0**-1074), 2)  # 2^-1075, below every double
    assert same(to_float64(literal(half)), 0.0)
    assert same(to_float64("-" + literal(half)), -0.0)
    assert to_float64(literal(EXACT.add(half, Decimal("1e-1100")))) == 5e-324
    assert float_text(5e-324, "Float64") == "5e-324"
    assert float_text(-5e-324, "Float64") == "-5e-324"
    assert float_text(2.225073858507201e-308, "Float64") == "2.225073858507201e-308"
    # Binary32: the same at 2^-149.
    smallest = f32(1)
    assert smallest == 2.0**-149
    assert to_float32(exact(smallest)) == smallest
    assert same(to_float32(exact(2.0**-150)), 0.0)
    assert same(to_float32("-" + exact(2.0**-150)), -0.0)
    assert to_float32(literal(EXACT.add(Decimal(2.0**-150), Decimal("1e-200")))) == smallest
    assert same(to_float32(literal(EXACT.subtract(Decimal(2.0**-150), Decimal("1e-200")))), 0.0)
    assert to_float32(exact(3 * 2.0**-150)) == 2 * smallest  # a tie: to the even one
    assert to_float32(exact(5 * 2.0**-150)) == 2 * smallest
    assert to_float32(exact(7 * 2.0**-150)) == 4 * smallest
    assert float_text(smallest, "Float32") == "1e-45"
    assert float_text(f32(0x007FFFFF), "Float32") == "1.1754942e-38"  # the largest subnormal
    assert float_text(f32(0x00800000), "Float32") == "1.1754944e-38"  # the smallest normal


def test_negative_zero() -> None:
    assert same(to_float64("-0"), -0.0)
    assert same(to_float32("-0"), -0.0)
    assert same(to_float32("-0.000"), -0.0)
    assert same(to_float32("0"), 0.0)
    assert float_text(-0.0, "Float64") == "-0"
    assert float_text(-0.0, "Float32") == "-0"
    assert float_text(0.0, "Float32") == "0"


def test_literals_only() -> None:
    for text in ["inf", "nan", "1_0", " 1", "1e+5", "+1", ".5", "1.", "0x10", "1E5"]:
        with pytest.raises(ValueError):
            to_float64(text)
        with pytest.raises(ValueError):
            to_float32(text)


def test_float32_oracle_near_ties() -> None:
    """Literals at, just above and just below the midpoints between binary32 values."""
    r = random.Random(1)
    for _ in range(3000):
        lo = r.randrange(0, 0x7F7FFFFF)
        a, b = Fraction(f32(lo)), Fraction(f32(lo + 1))
        mid = (a + b) / 2
        nudge = r.choice([0, 1, -1])
        value = mid + nudge * mid / 10**60
        text = literal(EXACT.divide(Decimal(value.numerator), Decimal(value.denominator)))
        if nudge == 0:
            assert Fraction(Decimal(text)) == mid, "the midpoint is written exactly"
        for t in (text, "-" + text):
            assert same(to_float32(t), nearest32(t)), t


# ── spelling ─────────────────────────────────────────────────


def test_layout() -> None:
    """The examples of the §15 layout table, and the edges of its rows."""
    cases = {
        1.0: "1",
        100.0: "100",
        123000.0: "123000",
        1.5: "1.5",
        12.25: "12.25",
        0.1: "0.1",
        0.000001: "0.000001",
        1e21: "1e21",
        1.5e-7: "1.5e-7",
        1e-7: "1e-7",
        1e20: "100000000000000000000",
        1.5e20: "150000000000000000000",
        1.5e21: "1.5e21",
        123456789012345680000.0: "123456789012345680000",
        0.0000015: "0.0000015",
        -2.5: "-2.5",
        -1.5e300: "-1.5e300",
        1e16: "10000000000000000",
        1.7976931348623157e308: "1.7976931348623157e308",
    }
    for x, text in cases.items():
        assert float_text(x, "Float64") == text


def test_float32_spellings() -> None:
    cases = {
        0x3DCCCCCD: "0.1",
        0x3F800001: "1.0000001",
        0x7F7FFFFF: "3.4028235e38",
        0x4B800000: "16777216",
        0x4A000001: "2097152.2",
        0x4A000003: "2097152.8",
        0xCA000001: "-2097152.2",
        0x49800001: "1048576.1",  # not a tie: the closer one
    }
    for bits, text in cases.items():
        assert float_text(f32(bits), "Float32") == text
    # A double that isn't a binary32 value is written as its nearest one.
    assert float_text(0.1, "Float32") == "0.1"
    assert float_text(1 + 2**-24 + 2**-50, "Float32") == "1.0000001"


def test_ties() -> None:
    assert float_text(1690060720831323.25, "Float64") == "1690060720831323.2"
    assert float_text(-1690060720831323.25, "Float64") == "-1690060720831323.2"
    assert float_text(2097152.25, "Float32") == "2097152.2"
    assert float_text(2097152.75, "Float32") == "2097152.8"


def test_not_numbers() -> None:
    for x in [math.nan, math.inf, -math.inf]:
        with pytest.raises(ValueError):
            float_text(x, "Float64")
        with pytest.raises(ValueError):
            float_text(x, "Float32")
    with pytest.raises(ValueError):
        float_text(1e39, "Float32")


def check_spelling(x: float, kind: str) -> None:
    """The spelling reads back, has the fewest digits, and is the closest of them (ties to even)."""
    assert kind in ("Float64", "Float32")
    read = to_float64 if kind == "Float64" else to_float32
    text = float_text(x, "Float64" if kind == "Float64" else "Float32")
    assert same(read(text), x), f"{x!r} written as {text}"
    k = len(significant(text))
    if x == 0:
        return
    exact_x = Decimal(abs(x))
    neighbours = {
        Context(prec=p, rounding=r).plus(exact_x) for p in (k - 1, k) if p > 0 for r in (ROUND_FLOOR, ROUND_CEILING)
    }
    reading = {n for n in neighbours if same(read(literal(n)), abs(x))}
    assert all(len(significant(literal(n))) >= k for n in reading), f"{text} isn't the shortest"
    best = min(reading, key=lambda n: (abs(n - exact_x), int(significant(literal(n))[-1]) % 2))
    assert Decimal(text.lstrip("-")) == best, f"{x!r}: {text}, expected {best}"


def test_random_float32() -> None:
    r = random.Random(1)
    values = [f32(r.getrandbits(32)) for _ in range(20000)]
    # Powers of two, where the rounding interval is lopsided.
    values += [s * 2.0**e for e in range(-149, 128) for s in (1, -1)]
    for x in values:
        if math.isfinite(x):
            check_spelling(x, "Float32")
            assert len(significant(float_text(x, "Float32"))) <= 9


def test_random_float64() -> None:
    r = random.Random(2)
    values = [f64(r.getrandbits(64)) for _ in range(20000)]
    values += [s * 2.0**e for e in range(-1074, 1024) for s in (1, -1)]
    for x in values:
        if math.isfinite(x):
            check_spelling(x, "Float64")
            assert len(significant(float_text(x, "Float64"))) <= 17


def test_float64_ties() -> None:
    """Exact ties between two shortest spellings, where `repr` must pick the even one."""
    r = random.Random(3)
    # Few binary fraction digits: about one in ten of these is a tie.
    values = [r.randrange(2**49, 2**53) + r.choice([0.25, 0.75, 0.125, 0.375]) for _ in range(5000)]
    ties = 0
    for x in values:
        check_spelling(x, "Float64")
        text = float_text(x, "Float64")
        digits = int(significant(text))
        unit = Decimal(text) / digits
        ties += any(
            Decimal(x) == (2 * digits + side) * unit / 2 and to_float64(literal((digits + side) * unit)) == x
            for side in (-1, 1)
        )
    assert ties > 100
    assert float_text(1690060720831323.25, "Float64") == "1690060720831323.2"


# ── TypeScript ───────────────────────────────────────────────

# floatText of the TypeScript binding (typescript/packages/haus/src/float.ts) on
# pseudo-random bit patterns.
TS_FLOAT64 = [
    ("cc6c5534264e4f5d", "-1.422784299750805e60"),
    ("2a7450d2589295a3", "3.5431823648642096e-104"),
    ("7f1390a08d258459", "1.3416967763509173e304"),
    ("7d22a81e7c2ee8ff", "5.957731867352355e294"),
    ("1f3116ccaaa10d15", "1.9448247636573067e-158"),
    ("2bcd282ae313161b", "1.0664311712771351e-97"),
    ("73bed3b8e5126591", "3.448643114259863e249"),
    ("82ed9cf60142f8f7", "-1.4489671791060474e-294"),
    ("376973645c66c9cd", "9.130008853028915e-42"),
    ("cace92829d242d93", "-2.28769149738408e52"),
    ("80fc61d0482335c9", "-6.4667887615094945e-304"),
    ("13d754cef3da0fef", "4.3315336960885014e-213"),
    ("468dcafc39206585", "7.553400332725187e31"),
    ("7b97efdac761bc0b", "2.2780558525168525e287"),
    ("e76a9ae8bb06d501", "-1.481741349130318e190"),
    ("b6952fa6326e0de7", "-9.277528448247671e-46"),
    ("68c27d94918ac03d", "4.319335847286293e196"),
    ("6ad4a032de03a183", "4.1387323662728965e206"),
    ("d113df008d682339", "-3.769821489884127e82"),
    ("a7288d7ef4d4d2df", "-4.7541329479502705e-120"),
    ("ce57eb2cb51eb9f5", "-2.5793822139414596e69"),
    ("833c038af05dbdfb", "-4.38628510507595e-293"),
    ("92ee8e183d6e0071", "-1.731156166744124e-217"),
    ("b45ece561bc03ed7", "-1.9630716664207587e-56"),
    ("954a73c48d9132ad", "-4.11960020007872e-206"),
    ("a31179e2685ff173", "-9.172058457415192e-140"),
    ("9e5d08304b3b4ca9", "-2.0165969659473307e-162"),
    ("4d51522ef03e31cf", "2.8501831702656494e64"),
    ("52c2775c2a530a65", "4.7020519704556305e90"),
    ("01a4633a42161beb", "9.513506266812346e-301"),
    ("22adad48fc6ee7e1", "1.2168316857320755e-141"),
    ("bee5790653388bc7", "-0.000010239006406348006"),
    ("4c9455f43c11211d", "8.169575787136586e60"),
    ("c4d01f92b3281d63", "-3.045611345162255e23"),
    ("5e9add600fa3b219", "5.36735904529999e147"),
    ("a14ca2de5cf52cbf", "-2.7994171350336537e-148"),
    ("62c06f8c803456d5", "4.845926266393779e167"),
    ("c67c0eea4259d5db", "-3.556807268019277e31"),
    ("a1caf8785ff08b51", "-6.749669480707769e-146"),
    ("75842fb66c95f4b7", "1.2123965396496426e258"),
]

TS_FLOAT32 = [
    ("a8f32424", "-2.6994093e-14"),
    ("1c618b8d", "7.462662e-22"),
    ("8a1b9142", "-7.4902985e-33"),
    ("4f0b2553", "2334479000"),
    ("fe505e90", "-6.9242605e37"),
    ("78685389", "1.884855e34"),
    ("72d57f8e", "8.4575374e30"),
    ("a798c3af", "-4.2400636e-15"),
    ("b004d3bc", "-4.8322213e-10"),
    ("e9f99f45", "-3.7721832e25"),
    ("622e069a", "802552300000000000000"),
    ("08b7ebcb", "1.10693465e-33"),
    ("aa296fa8", "-1.5048954e-13"),
    ("1799eac1", "9.946653e-25"),
    ("8455f266", "-2.5149334e-36"),
    ("e95779a7", "-1.6280846e25"),
    ("7f79de54", "3.3213216e38"),
    ("b19971fd", "-4.465845e-9"),
    ("c5becef2", "-6105.868"),
    ("d6780943", "-68179666000000"),
    ("10c08bc0", "7.5945966e-29"),
    ("a31030f9", "-7.816626e-18"),
    ("7666e83e", "1.1708386e33"),
    ("2287f69f", "3.6852944e-18"),
    ("3f02a3ec", "0.51031375"),
    ("5699e3b5", "84601640000000"),
    ("d5e54a4a", "-31513404000000"),
    ("2e7f5dbb", "5.8063537e-11"),
    ("946c12d8", "-1.19186714e-26"),
    ("8ad20631", "-2.0224593e-32"),
    ("5435c116", "3122514000000"),
    ("28bc1a97", "2.0883724e-14"),
    ("8ffb8484", "-2.4801554e-29"),
    ("f28fd46d", "-5.697685e30"),
    ("1344d8a2", "2.4845486e-27"),
    ("dd9dc933", "-1421209400000000000"),
    ("9ce24a69", "-1.497466e-21"),
    ("f53bdcee", "-2.3814465e32"),
    ("f5e1c58f", "-5.723993e32"),
    ("96ece01c", "-3.826929e-25"),
]

# toFloat32 of the TypeScript binding where rounding through binary64 would differ.
TS_TO_FLOAT32 = [
    ("-2.749282970171407214364899562835693359375e-7", "b49399db"),
    ("4.33810143473299785850552319999999999999e26", "6bb36b6f"),
    ("384061167.9999999999999999999", "4db72277"),
    ("49309186047.999999999999", "5137b0e7"),
    ("0.000005226431085247895680367945624755859375", "36af5eb3"),
    ("34011630591.9999999999", "50fd6809"),
    ("-2.2550462830395190384483506679534912109375e-7", "b472223d"),
    ("2.2380378368325182236732052398681640625e-6", "36163133"),
    ("29952818175.9999999", "50df2a77"),
    ("609900791686722927291313534401025664", "7aeaecdd"),
    ("7.11930836875647231206058368e27", "6db807a1"),
    ("211027791500813440104005631.9999999999", "6b2e8edf"),
]


@pytest.mark.parametrize(("bits", "text"), TS_FLOAT64)
def test_typescript_float64(bits: str, text: str) -> None:
    assert float_text(f64(int(bits, 16)), "Float64") == text


@pytest.mark.parametrize(("bits", "text"), TS_FLOAT32)
def test_typescript_float32(bits: str, text: str) -> None:
    assert float_text(f32(int(bits, 16)), "Float32") == text


@pytest.mark.parametrize(("lit", "bits"), TS_TO_FLOAT32)
def test_typescript_to_float32(lit: str, bits: str) -> None:
    x = to_float32(lit)
    assert x is not None
    assert bits32(x) == int(bits, 16)
    assert x != struct.unpack(">f", struct.pack(">f", float(lit)))[0]
