"""The public API, limits, error positions and the Python-specific edge cases."""

from __future__ import annotations

from decimal import Decimal

import pytest

import haus
from haus import Array, Bytes, Limits, Number, Record, String, Variant


def error(text: str, limits: Limits = haus.DEFAULT_LIMITS) -> haus.HausSyntaxError:
    with pytest.raises(haus.HausSyntaxError) as info:
        haus.parse_all(text, limits=limits)
    return info.value


def test_parse_reads_one_value() -> None:
    assert haus.parse('{ name: "Ada", tags: [A, B(1)] }') == Record(
        {"name": String("Ada"), "tags": Array((Variant("A"), Variant("B", (Number("1"),))))}
    )


def test_parse_rejects_a_stream() -> None:
    with pytest.raises(haus.HausSyntaxError, match="expected exactly one value, found 2"):
        haus.parse("1, 2")
    with pytest.raises(haus.HausSyntaxError, match="found 0"):
        haus.parse("// nothing")


def test_equality_follows_the_spec() -> None:
    assert haus.parse("{ a: 1, b: 2 }") == haus.parse("{ b: 2, a: 1 }")
    assert haus.parse("Tag { a: 1 }") == haus.parse("Tag({ a: 1 })")
    assert haus.parse("0xFF") == haus.parse("255")
    assert haus.parse("1E+05") == Number("1e5")
    assert haus.parse("1.0") != haus.parse("1")
    assert haus.parse('x"0B 34"') == Bytes(b"\x0b\x34")


def test_numbers_convert_exactly() -> None:
    assert haus.parse("1_000").to_int() == 1000  # type: ignore[union-attr]
    assert str(Number("19.90").to_decimal()) == "19.90"
    with pytest.raises(ValueError):
        Number("1e5").to_int()


def test_columns_count_code_points() -> None:
    e = error('{ "😀": 1, x: ? }')
    assert (e.line, e.column, e.offset) == (1, 14, 13)
    assert str(e) == "expected a value, found '?' at 1:14"


def test_invalid_utf8_is_located() -> None:
    with pytest.raises(haus.HausSyntaxError) as info:
        haus.parse_bytes(b'[1,\n "\xc3\x28"]')
    assert (info.value.reason, info.value.line, info.value.column) == ("invalid UTF-8", 2, 3)


def test_byte_order_mark_only_at_the_start() -> None:
    assert haus.parse_bytes(b"\xef\xbb\xbf1") == [Number("1")]
    assert error("1,\ufeff2").reason == "expected a value, found '\ufeff'"


def test_limits_are_configurable() -> None:
    assert error("[[[1]]]", Limits(max_depth=2)).reason == "nesting deeper than 2 levels"
    assert error("12345", Limits(max_number_length=4)).reason == "number literal longer than 4 characters"
    assert error("1e11", Limits(max_exponent=10)).reason == "exponent larger than 10"
    assert error('"abcd"', Limits(max_string_length=3)).reason == "string longer than 3 characters"
    assert error('x"0102 0304"', Limits(max_string_length=8)).reason == "byte string longer than 8 characters"


def test_recursion_limit_is_a_syntax_error() -> None:
    e = error("[" * 5000 + "]" * 5000, Limits(max_depth=10_000))
    assert "recursion limit" in e.reason


def test_default_depth_fits_the_recursion_limit() -> None:
    nested = "A(" * 128 + "{ a: [" * 64 + "1" + "] }" * 64 + ")" * 128
    assert haus.parse(nested) is not None


def test_huge_hex_beyond_cpython_digit_limit() -> None:
    # 4000 hex digits are about 4800 decimal digits: more than CPython's int-to-str limit.
    value = haus.parse("0x" + "f" * 4000, limits=Limits(max_number_length=5000))
    assert isinstance(value, Number)
    assert value.text == str(Decimal(16**4000 - 1))


def test_huge_exponent_is_checked_without_converting() -> None:
    e = error("1e" + "9" * 5000, Limits(max_number_length=6000))
    assert e.reason == "exponent larger than 6144"
