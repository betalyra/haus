"""Decoding and encoding with a schema (spec §15): host types, secrets, errors and limits."""

from __future__ import annotations

import datetime as dt
import logging
import pickle
from decimal import Decimal

import pytest

import haus
from haus import Array, Bytes, Limits, Number, Record, String, Variant
from haus.schema import (
    DateCodec,
    DecimalCodec,
    HausDecodeError,
    HausEncodeError,
    InstantCodec,
    Nothing,
    Schema,
    Secret,
    Some,
    Tagged,
    Unknown,
    compile_schema,
)

SCHEMA = compile_schema("""
    import std/time (Date, Instant)
    type User = { id: Int, name: String, nick?: String, note?: Maybe String }
    type Nested = Maybe (Maybe Int)
    type Shape = < Circle { r: Float64 } | Point Float64 Float64 | Empty | Wrap User >
    type Level = closed < Debug | Info >
    type AnyTag = < >
    type Payload = Any
    type Config = closed { name: String, key: Secret String, pins?: Secret (Map Int), raw?: Secret Any }
    type Key = Secret String
    type List = < Nil | Cons Int List >
    type Tree = { children: Array Tree }
    type Day = Date
    type At = Instant
    type Amount = Decimal
    type Small = UInt8
    type F32 = Float32
    type Counts = Map Int
    type Blob = Bytes
    type Flag = Bool
    type Events = Stream Shape
""")


def roundtrip(type_name: str, text: str, schema: Schema = SCHEMA) -> str:
    t = schema[type_name]
    return haus.canonical(t.encode(t.parse(text)))


# ── host types ───────────────────────────────────────────────


def test_records_keep_missing_optional_fields_missing() -> None:
    user = SCHEMA["User"].parse('{ id: 1, name: "Ada", extra: 3 }')
    assert user == {"id": 1, "name": "Ada"}
    assert "nick" not in user


def test_optional_maybe_has_three_states() -> None:
    t = SCHEMA["User"]
    assert "note" not in t.parse('{ id: 1, name: "Ada" }')
    assert t.parse('{ id: 1, name: "Ada", note: None }')["note"] == Nothing()
    assert t.parse('{ id: 1, name: "Ada", note: Some("x") }')["note"] == Some("x")
    assert t.canonical({"id": 1, "name": "Ada"}) == '{id:1,name:"Ada"}'
    assert t.canonical({"id": 1, "name": "Ada", "note": Nothing()}) == '{id:1,name:"Ada",note:None}'


def test_none_is_not_a_missing_field() -> None:
    with pytest.raises(HausEncodeError, match=r"at \$\.nick"):
        SCHEMA["User"].encode({"id": 1, "name": "Ada", "nick": None})


def test_maybe_nesting_keeps_some_none_apart() -> None:
    t = SCHEMA["Nested"]
    assert t.parse("None") == Nothing()
    assert t.parse("Some(None)") == Some(Nothing())
    assert t.parse("Some(Some(1))") == Some(Some(1))
    assert t.parse("Some(None)") != t.parse("None")
    assert t.canonical(Some(Nothing())) == "Some(None)"
    assert t.canonical(Nothing()) == "None"
    match t.parse("Some(None)"):
        case Some(Nothing()):
            pass
        case _:
            pytest.fail("Some(None) didn't match")
    with pytest.raises(HausEncodeError):
        t.encode(None)


def test_variants_are_tagged() -> None:
    t = SCHEMA["Shape"]
    assert t.parse("Circle { r: 1.5 }") == Tagged("Circle", {"r": 1.5})
    assert t.parse("Circle({ r: 1.5 })") == Tagged("Circle", {"r": 1.5})
    assert t.parse("Point(1, 2)") == Tagged("Point", (1.0, 2.0))
    assert t.parse("Empty") == Tagged("Empty")
    assert t.parse('Wrap { id: 1, name: "a" }') == Tagged("Wrap", ({"id": 1, "name": "a"},))
    assert t.canonical(Tagged("Point", (1.0, 2.5))) == "Point(1,2.5)"
    assert SCHEMA["Level"].parse("Info") == Tagged("Info")
    with pytest.raises(HausEncodeError):
        t.encode(Tagged("Point", (1.0,)))
    with pytest.raises(HausEncodeError):
        t.encode(Tagged("Empty", (1,)))
    with pytest.raises(HausEncodeError):
        t.encode("Empty")


def test_unknown_values_keep_the_raw_value() -> None:
    t = SCHEMA["Shape"]
    hexagon = t.parse('Hexagon(0x10, { b: 1, a: [x"ff"] })')
    assert isinstance(hexagon, Unknown)
    assert hexagon.tag == "Hexagon"
    assert hexagon.value == Variant(
        "Hexagon", (Number("16"), Record({"b": Number("1"), "a": Array((Bytes(b"\xff"),))}))
    )
    assert t.canonical(hexagon) == 'Hexagon(16,{a:[x"ff"],b:1})'
    assert isinstance(SCHEMA["AnyTag"].parse("EUR"), Unknown)
    match SCHEMA["AnyTag"].parse('Custom("XBT")'):
        case Unknown(Variant("Custom", (String(code),))):
            assert code == "XBT"
        case _:
            pytest.fail("not an Unknown")


def test_unknown_values_are_not_listed_cases() -> None:
    with pytest.raises(HausEncodeError, match="listed tag 'Empty'"):
        SCHEMA["Shape"].encode(Unknown(Variant("Empty")))
    with pytest.raises(HausEncodeError, match="closed"):
        SCHEMA["Level"].encode(Unknown(Variant("Warn")))
    with pytest.raises(HausDecodeError, match="unknown tag 'Warn'"):
        SCHEMA["Level"].parse("Warn")


def test_unknown_values_are_checked_before_writing() -> None:
    t = SCHEMA["Shape"]
    with pytest.raises(HausEncodeError, match="tag name"):
        t.encode(Unknown(Variant("lower")))
    with pytest.raises(HausEncodeError, match="number literal"):
        t.encode(Unknown(Variant("X", (Number("1."),))))
    assert t.canonical(Unknown(Variant("X", (Number("1E+5"),)))) == "X(1e5)"


def test_any_keeps_the_value_tree() -> None:
    t = SCHEMA["Payload"]
    value = haus.parse('Invoice { total: 19.90, lines: [Line(1, "A1")], n: -0 }')
    decoded = t.decode(value)
    assert decoded is value
    assert t.encode(decoded) is value  # unchanged, the same objects
    assert t.canonical(Number("0x10")) == "16"


def test_any_is_checked_before_writing() -> None:
    t = SCHEMA["Payload"]
    with pytest.raises(HausEncodeError, match="haus value"):
        t.encode(42)
    with pytest.raises(HausEncodeError, match="surrogate"):
        t.encode(String("\ud800"))
    with pytest.raises(HausEncodeError, match="exponent"):
        t.encode(Number("1e9999"))
    with pytest.raises(HausEncodeError, match="longer than 3"):
        t.encode(String("abcd"), limits=Limits(max_string_length=3))
    with pytest.raises(HausEncodeError, match="string key"):
        t.encode(Record({1: Number("1")}))  # type: ignore[dict-item]
    deep: haus.Value = Number("1")
    for _ in range(300):
        deep = Array((deep,))
    with pytest.raises(HausEncodeError, match="nesting deeper than 256"):
        t.encode(deep)


def test_scalars() -> None:
    assert SCHEMA["Amount"].parse("19.90") == "19.90"
    assert SCHEMA["Amount"].parse("1.5e3") == "1.5e3"
    assert SCHEMA["Amount"].canonical("1E+05") == "1e5"
    assert SCHEMA["Amount"].canonical(Decimal("19.90")) == "19.90"
    assert SCHEMA["Day"].parse('Date("2024-02-29")') == "2024-02-29"
    assert SCHEMA["Day"].canonical("2024-02-29") == 'Date("2024-02-29")'
    assert SCHEMA["Counts"].parse('{ "__proto__": 1, "pt-BR": 2 }') == {"__proto__": 1, "pt-BR": 2}
    assert SCHEMA["Blob"].parse('x"00ff"') == b"\x00\xff"
    assert SCHEMA["Flag"].parse("True") is True
    assert SCHEMA["F32"].parse("0.1") == 0.100000001490116119384765625
    assert SCHEMA["F32"].canonical(0.1) == "0.1"
    assert roundtrip("F32", "NegInfinity") == "NegInfinity"
    assert SCHEMA["Small"].parse("-0") == 0
    with pytest.raises(HausDecodeError, match="out of range for UInt8"):
        SCHEMA["Small"].parse("256")
    with pytest.raises(HausEncodeError):
        SCHEMA["Small"].encode(True)
    with pytest.raises(HausEncodeError):
        SCHEMA["Flag"].encode(1)
    with pytest.raises(HausEncodeError, match="not a valid Date"):
        SCHEMA["Day"].encode("2026-02-30")


# ── secrets ──────────────────────────────────────────────────


def test_secret_is_redacted() -> None:
    config = SCHEMA["Config"].parse('{ name: "a", key: "sk-123456" }')
    key: Secret[str] = config["key"]
    assert isinstance(key, Secret)
    assert key.expose() == "sk-123456"
    for shown in (str(key), repr(key), f"{key}", f"{key!r}", "%s" % key, repr(config), str([key])):  # noqa: UP031
        assert "sk-123456" not in shown
        assert "<redacted>" in shown
    assert not hasattr(key, "__dict__")
    assert key != Secret("sk-123456")  # equal only to itself: no comparing secrets by accident


def test_secret_is_redacted_in_logs(caplog: pytest.LogCaptureFixture) -> None:
    key = Secret("sk-123456")
    with caplog.at_level(logging.INFO):
        logging.getLogger("test").info("key %s, %r", key, key)
        logging.getLogger("test").info("config %s", {"key": key})
    assert "sk-123456" not in caplog.text


def test_secret_errors_never_show_the_value() -> None:
    t = SCHEMA["Config"]
    with pytest.raises(HausDecodeError) as e:
        t.parse('{ name: "a", key: 123456789, pins: {} }')
    assert e.value.path == ("key",)
    assert "123456789" not in str(e.value)
    assert e.value.__context__ is None and e.value.__cause__ is None
    # A map key inside a secret would show up in a path into it.
    with pytest.raises(HausDecodeError) as e:
        t.parse('{ name: "a", key: "k", pins: { "sk-hidden-name": "1234" } }')
    assert e.value.path == ("pins",)
    assert "sk-hidden-name" not in str(e.value) and "1234" not in str(e.value)
    with pytest.raises(HausDecodeError) as e:
        SCHEMA["Key"].parse('Secret("sk-123456")')
    assert e.value.path == () and "sk-123456" not in str(e.value)


def test_secret_encode_errors_never_show_the_value() -> None:
    t = SCHEMA["Config"]
    with pytest.raises(HausEncodeError) as e:
        t.encode({"name": "a", "key": Secret(987654321)})
    assert e.value.path == ("key",) and "987654321" not in str(e.value)
    assert e.value.__context__ is None
    with pytest.raises(HausEncodeError) as e:
        t.encode({"name": "a", "key": "sk-plain-value"})
    assert "sk-plain-value" not in str(e.value)
    with pytest.raises(HausEncodeError) as e:
        t.encode({"name": "a", "key": Secret("k"), "raw": Secret(String("\ud800 sk-raw"))})
    assert e.value.path == ("raw",) and "sk-raw" not in str(e.value)


def test_secret_encodes_in_full() -> None:
    t = SCHEMA["Config"]
    assert (
        t.canonical({"name": "a", "key": Secret("sk-1"), "pins": Secret({"a": 1})})
        == '{key:"sk-1",name:"a",pins:{a:1}}'
    )
    assert pickle.loads(pickle.dumps(Secret("x"))).expose() == "x"


# ── errors ───────────────────────────────────────────────────


def test_errors_have_paths() -> None:
    s = compile_schema('type Order = { items: Array { price: Decimal }, "x-y"?: Map Int }')
    with pytest.raises(HausDecodeError) as e:
        s["Order"].parse('{ items: [{ price: 1 }, { price: 2 }, { price: "3" }] }')
    assert e.value.path == ("items", 2, "price")
    assert str(e.value) == 'expected Decimal, found string "3" at $.items[2].price'
    with pytest.raises(HausDecodeError) as e:
        s["Order"].parse('{ items: [], "x-y": { "a b": "1" } }')
    assert str(e.value).endswith('at $["x-y"]["a b"]')
    with pytest.raises(HausEncodeError) as encoding:
        s["Order"].encode({"items": [{"price": 1}]})
    assert encoding.value.path == ("items", 0, "price")


def test_decoding_never_converts_kinds() -> None:
    with pytest.raises(HausDecodeError):
        SCHEMA["User"].parse('{ id: "1", name: "Ada" }')
    with pytest.raises(HausDecodeError):
        SCHEMA["Nested"].parse("1")
    with pytest.raises(HausDecodeError, match="missing field 'name'"):
        SCHEMA["User"].parse("{ id: 1 }")
    with pytest.raises(HausDecodeError, match="exactly one value"):
        SCHEMA["User"].parse("{ id: 1 }, { id: 2 }")


def test_closed_records_reject_other_fields_both_ways() -> None:
    with pytest.raises(HausDecodeError, match="unexpected field 'extra'"):
        SCHEMA["Config"].parse('{ name: "a", key: "k", extra: 1 }')
    with pytest.raises(HausEncodeError, match="unexpected field"):
        SCHEMA["Config"].encode({"name": "a", "key": Secret("k"), "extra": 1})


# ── limits ───────────────────────────────────────────────────


def cons(n: int) -> str:
    text = "Nil"
    for i in range(n):
        text = f"Cons({i}, {text})"
    return text


def test_recursion_is_limited_by_the_nesting_depth_only() -> None:
    t = SCHEMA["List"]
    assert haus.canonical(t.encode(t.parse(cons(256)))) == haus.canonical(haus.parse(cons(256)))
    with pytest.raises(HausDecodeError, match="deeper than 10 levels"):
        t.decode(haus.parse(cons(20)), limits=Limits(max_depth=10))


def test_a_value_built_in_code_beyond_the_depth_is_rejected() -> None:
    value: haus.Value = Variant("Nil")
    for i in range(400):
        value = Variant("Cons", (Number(str(i)), value))
    with pytest.raises(HausDecodeError, match="deeper than 256"):
        SCHEMA["List"].decode(value)


def test_values_that_contain_themselves_are_detected() -> None:
    tree: dict[str, list[object]] = {"children": []}
    tree["children"].append(tree)
    with pytest.raises(HausEncodeError, match="cyclic"):
        SCHEMA["Tree"].encode(tree)


def test_work_budget() -> None:
    value = haus.parse("[" + ", ".join(["{ children: [] }"] * 50) + "]")
    s = compile_schema("type Forest = Array { children: Array Int }")
    s["Forest"].decode(value)
    with pytest.raises(HausDecodeError, match="budget of 10 steps"):
        s["Forest"].decode(value, max_steps=10)
    with pytest.raises(HausEncodeError, match="budget"):
        forest: list[dict[str, list[int]]] = [{"children": []}] * 20
        s["Forest"].encode(forest, max_steps=10)


# ── streams and codecs ───────────────────────────────────────


def test_streams_decode_each_value_with_its_index() -> None:
    t = SCHEMA["Events"]
    assert t.stream
    assert list(t.parse_stream([b"Empty,\nPoint(1, 2),", b"\nHexagon,\n"])) == [
        Tagged("Empty"),
        Tagged("Point", (1.0, 2.0)),
        Unknown(Variant("Hexagon")),
    ]
    with pytest.raises(HausDecodeError) as e:
        list(t.parse_stream(['Empty, Circle { r: "1" },']))
    assert e.value.path == (1, "r")
    assert "".join(t.encode_all([Tagged("Empty"), Tagged("Circle", {"r": 1.0})])) == "Empty,\nCircle{r:1},\n"


def test_codecs_are_opt_in_host_types() -> None:
    text = "import std/time (Date, Instant)\ntype T = { d: Date, at: Instant, amount: Decimal }"
    s = compile_schema(
        text,
        codecs={"std/time#Date": DateCodec(), "std/time#Instant": InstantCodec(), "prelude#Decimal": DecimalCodec()},
    )
    t = s["T"].parse('{ d: Date("2026-11-13"), at: Instant("2026-11-13T10:00:00.250+01:00"), amount: 15e2 }')
    assert t["d"] == dt.date(2026, 11, 13)
    assert t["at"] == dt.datetime(2026, 11, 13, 9, 0, 0, 250000, tzinfo=dt.UTC)
    assert t["amount"] == Decimal("1500")
    # Lossy, as documented: the fraction's spelling and the exponent change.
    assert s["T"].canonical(t) == '{amount:1.5e3,at:Instant("2026-11-13T10:00:00.250000+01:00"),d:Date("2026-11-13")}'
    with pytest.raises(HausDecodeError, match="codec for std/time#Date"):
        s["T"].parse('{ d: Date("0000-01-01"), at: Instant("2026-11-13T10:00:00Z"), amount: 1 }')
    with pytest.raises(HausEncodeError, match="codec"):
        s["T"].encode({"d": "2026-11-13", "at": t["at"], "amount": Decimal(1)})
    with pytest.raises(ValueError, match="no such type"):
        compile_schema(text, codecs={"std/time#Duration": DateCodec()})
