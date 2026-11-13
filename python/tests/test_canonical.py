"""The canonical form, equality, hashing and order (spec §12)."""

from __future__ import annotations

from functools import cmp_to_key

import haus
from haus import Number, Record, String


def c(text: str) -> str:
    return haus.canonical(haus.parse(text))


def test_writes_the_spec_example() -> None:
    assert c('Order { total: 19.90, id: 0xFF, "x-y": 1e+5, p: Point(1, 2) }') == (
        'Order{id:255,p:Point(1,2),total:19.90,"x-y":1e5}'
    )


def test_ignores_layout_comments_key_order_and_spelling() -> None:
    a = haus.parse('{ b: [1_000, 0b11], /* c */ a: Tag({ x: x"0B 34" }) }')
    b = haus.parse('{a:Tag{x:x"0b34"},b:[1000,3]}')
    assert haus.canonical(a) == '{a:Tag{x:x"0b34"},b:[1000,3]}'
    assert haus.equals(a, b)


def test_keeps_what_section_2_tells_apart() -> None:
    assert not haus.equals(haus.parse("1.0"), haus.parse("1"))
    assert not haus.equals(haus.parse("{}"), haus.parse("{ x: None }"))
    assert not haus.equals(haus.parse('"caf\\u{E9}"'), haus.parse('"cafe\\u{301}"'))
    assert not haus.equals(haus.parse("-0"), haus.parse("0"))
    assert haus.equals(haus.parse("-0x0"), haus.parse("0"))


def test_escapes_only_what_it_must() -> None:
    assert c('"tab\\tquote\\" \\u{41} \\u{1b} \\u{202e} café 😀"') == '"tab\\tquote\\" A \\u{1B} \\u{202E} café 😀"'
    assert c('"""\n  two\n  lines\n  """') == '"two\\nlines"'
    assert c('"\\u{7f}\\u{9f}\\u{a0}\\r\\\\"') == '"\\u{7F}\\u{9F}\xa0\\r\\\\"'


def test_sorts_keys_by_code_point() -> None:
    # U+FFFD sorts before U+1F600 by code point (as UTF-16 units it's the other way round).
    assert c('{ "😀": 1, "�": 2, a: 3, "Z": 4 }') == '{"Z":4,a:3,"�":2,"😀":1}'


def test_quotes_keys_that_are_not_identifiers() -> None:
    assert c('{ "a-b": 1, "": 2, "_x9": 3, "9": 4 }') == '{"":2,"9":4,_x9:3,"a-b":1}'


def test_writes_a_single_record_payload_as_tag_braces() -> None:
    assert c("[None, Some(1), Circle({ r: 1 }), Pair({ a: 1 }, 2)]") == "[None,Some(1),Circle{r:1},Pair({a:1},2)]"


def test_keeps_a_huge_hex_integer_in_hex() -> None:
    big = "0x" + "f" * 900
    assert c(big) == big
    assert c("-" + big) == "-" + big


def test_writes_integers_beyond_the_number_limit_in_hex() -> None:
    assert haus.canonical(Number("1" + "0" * 999)) == "1" + "0" * 999  # 1000 characters: decimal
    assert haus.canonical(Number("1" + "0" * 1000)) == "0x" + format(10**1000, "x")
    assert haus.canonical(Number("-" + "9" * 5000)) == "-0x" + format(10**5000 - 1, "x")  # past int's str limit
    assert haus.canonical(Number("1." + "0" * 1000)) == "1." + "0" * 1000  # not an integer: as written


def test_parses_back_to_the_same_value() -> None:
    v = Record({"s": String('"\n\u202e'), "n": Number("19.90")})
    assert haus.parse(haus.canonical(v)) == v


def test_compare_orders_by_the_bytes_of_the_canonical_forms() -> None:
    vs = haus.parse_all('9, 10, [], "�", "😀", { b: 1, a: 2 }, { a: 2, b: 1 }, Some(1), -1')
    assert [haus.canonical(v) for v in sorted(vs, key=cmp_to_key(haus.compare))] == [
        '"�"',
        '"😀"',
        "-1",
        "10",
        "9",
        "Some(1)",
        "[]",
        "{a:2,b:1}",
        "{a:2,b:1}",
    ]
    assert haus.compare(vs[5], vs[6]) == 0
    assert haus.compare(haus.parse("1.0"), haus.parse("1")) == 1
    assert haus.compare(haus.parse("1"), haus.parse("1.0")) == -1


def test_hash_is_sha256_of_the_canonical_form() -> None:
    assert haus.hash(haus.parse("{ a: 1 }")) == "f09a9231c12685ac5f0b6f0b06c9154f13dc3a5b3548db5142c19bde1383f261"
    assert (
        haus.hash(haus.parse('Order { total: 19.90, id: 0xFF, "x-y": 1e+5, p: Point(1, 2) }'))
        == "d324549b0e26394cc4f2a1fc7ac2647179da2d244c66763381c9cb63dbf8a104"
    )


def test_hash_is_the_same_for_equal_values() -> None:
    a, b = haus.parse_all("{ x: 1, y: [2] }, { y: [ 2, ], x: 1 }")
    assert haus.hash(a) == haus.hash(b)
