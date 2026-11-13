"""Streams: values arrive in chunks split anywhere (the cases of the Rust and TypeScript readers)."""

from __future__ import annotations

import io
import time
from pathlib import Path

import pytest

import haus
from haus import Array, Limits, Number, String, Value, Variant

SUITE = Path(__file__).resolve().parents[2] / "test-suite"


def chunked(data: bytes, size: int) -> list[Value]:
    """All values of `data`, read in chunks of `size` bytes."""
    return list(haus.parse_stream(data[at : at + size] for at in range(0, len(data), size)))


def read(text: str, reader: haus.StreamReader | None = None) -> list[Value]:
    """All values of `text`, pushed in one chunk."""
    reader = reader or haus.StreamReader()
    return reader.push(text) + reader.finish()


def suite(kind: str) -> list[Path]:
    return sorted((SUITE / kind).glob("*.haus"))


@pytest.mark.parametrize("path", suite("valid"), ids=lambda p: p.stem)
def test_any_chunking_gives_the_same_values(path: Path) -> None:
    data = path.read_bytes()
    whole = haus.parse_bytes(data)
    for size in [*range(1, 10), max(1, len(data))]:
        assert chunked(data, size) == whole, f"chunk size {size}"


@pytest.mark.parametrize("path", suite("invalid"), ids=lambda p: p.stem)
def test_invalid_input_is_rejected_in_any_chunking(path: Path) -> None:
    data = path.read_bytes()
    for size in [*range(1, 10), max(1, len(data))]:
        with pytest.raises(haus.HausSyntaxError):
            chunked(data, size)


def test_emits_each_value_as_soon_as_its_comma_arrives() -> None:
    r = haus.StreamReader()
    assert r.push(b"UserCreated { id: 1 ") == []
    assert r.push(b"}") == []  # a payload could still follow
    assert len(r.push(b",\nHeart")) == 1
    assert r.push(b"beat") == []
    assert r.finish() == [Variant("Heartbeat")]


def test_does_not_split_on_commas_inside_strings_comments_or_payloads() -> None:
    text = '"a,b", /* , */ Pair(1, 2), // ,\n"""\n  x,\n  """,'
    assert chunked(text.encode(), 1) == [
        String("a,b"),
        Variant("Pair", (Number("1"), Number("2"))),
        String("x,"),
    ]


def test_reads_comments_between_values_split_anywhere() -> None:
    text = (
        "// header, with a comma\nA { x: 1 }, // after A, [unbalanced\n"
        '/* block, with } and " and /* nested, */ */\nB(2),\n\n// before C\n'
        'C { s: "// not a comment" } /* before the comma */ ,\n// trailing comment, {'
    )
    whole = haus.parse_all(text)
    assert len(whole) == 3
    for k in range(len(text) + 1):
        r = haus.StreamReader()
        assert r.push(text[:k]) + r.push(text[k:]) + r.finish() == whole, f"split at {k}"


def test_errors_have_positions_in_the_whole_stream() -> None:
    r = haus.StreamReader()
    r.push(b"A,\nB,\n")
    with pytest.raises(haus.HausSyntaxError) as info:
        r.push(b"{ ok: true },")
    assert (info.value.line, info.value.column, info.value.offset) == (3, 7, 12)


def test_error_positions_match_parsing_the_whole_text() -> None:
    for text in ["1, 2, [3,, 4]", "A,\n  B { x: ] },", "1,\n2 3,", '"é", "😀" x', "1,\n\n,"]:
        with pytest.raises(haus.HausSyntaxError) as whole:
            haus.parse_all(text)
        with pytest.raises(haus.HausSyntaxError) as streamed:
            chunked(text.encode(), 1)
        assert (streamed.value.line, streamed.value.column) == (whole.value.line, whole.value.column), text


def test_require_terminator_reports_a_cut_off_last_value() -> None:
    r = haus.StreamReader(require_terminator=True)
    assert len(r.push(b"1000,\n100")) == 1
    with pytest.raises(haus.HausSyntaxError, match="truncated") as info:
        r.finish()
    assert (info.value.line, info.value.column) == (2, 4)
    assert read("1, 2,\n// done\n", haus.StreamReader(require_terminator=True)) == [Number("1"), Number("2")]


def test_max_value_length_bounds_memory_for_a_value_that_never_ends() -> None:
    r = haus.StreamReader(max_value_length=100)
    with pytest.raises(haus.HausSyntaxError, match="value longer than 100"):
        r.push("[" + "1, " * 100)
    assert (
        len(read("[" + "1," * 48 + "11],", haus.StreamReader(max_value_length=100))) == 1
    )  # 100 characters before the comma


def test_limits_apply_to_each_value() -> None:
    r = haus.StreamReader(limits=Limits(max_number_length=5))
    with pytest.raises(haus.HausSyntaxError, match="number literal longer than 5"):
        r.push(b"12345, 123456,")


def test_utf8_split_across_chunks() -> None:
    assert chunked('"Olá 😀",'.encode(), 1) == [String("Olá 😀")]


def test_invalid_utf8_is_an_error_at_its_position() -> None:
    for data, position in [(b'1,\n"a\xff",', (2, 3)), (b'1, "\xc3', (1, 5)), (b"[\xe2\x82", (1, 2))]:
        with pytest.raises(haus.HausSyntaxError, match="invalid UTF-8") as info:
            chunked(data, 1)
        assert (info.value.line, info.value.column) == position


def test_bytes_and_text_chunks_mix() -> None:
    r = haus.StreamReader()
    assert r.push(b"1, ") + r.push("2, ") + r.push(b"3") + r.finish() == [Number("1"), Number("2"), Number("3")]
    r = haus.StreamReader()
    r.push(b'"\xc3')
    with pytest.raises(haus.HausSyntaxError, match="invalid UTF-8"):
        r.push('"')


def test_reads_from_files() -> None:
    assert list(haus.parse_stream(io.BytesIO(b"Some(1),\nNone,\nSome(3),\n"))) == [
        Variant("Some", (Number("1"),)),
        Variant("None"),
        Variant("Some", (Number("3"),)),
    ]
    assert list(haus.parse_stream(io.StringIO("[1], [2]"))) == [Array((Number("1"),)), Array((Number("2"),))]


def test_yields_the_values_before_an_error() -> None:
    values = haus.parse_stream([b"1, 2, ", b"]"])
    assert [next(values), next(values)] == [Number("1"), Number("2")]
    with pytest.raises(haus.HausSyntaxError, match="found ']'"):
        next(values)


def test_a_slash_at_the_end_is_an_error() -> None:
    for text in ["1 /", "/", "[1] /", "1, /"]:
        with pytest.raises(haus.HausSyntaxError):
            read(text)


def test_a_byte_order_mark_is_only_skipped_at_the_start() -> None:
    assert read("\ufeffA, B") == [Variant("A"), Variant("B")]
    assert chunked("\ufeffA, B".encode(), 1) == [Variant("A"), Variant("B")]
    for text in ["A,\ufeff", "A,\ufeff B, C", "\ufeff\ufeffA"]:
        with pytest.raises(haus.HausSyntaxError):
            read(text)


def test_push_after_finish_is_a_mistake() -> None:
    r = haus.StreamReader()
    r.finish()
    with pytest.raises(RuntimeError):
        r.push("1")


def test_many_values_in_one_chunk_take_linear_time() -> None:
    """Design review S17: dropping each value's text from the front of the buffer was quadratic."""
    text = "".join(f"{{ id: {i} }},\n" for i in range(200_000))
    started = time.perf_counter()
    values = haus.StreamReader().push(text.encode())
    assert len(values) == 200_000
    assert time.perf_counter() - started < 10


def test_a_large_value_in_small_chunks_takes_linear_time() -> None:
    text = "[" + "1, " * 300_000 + "]"
    started = time.perf_counter()
    r = haus.StreamReader()
    for at in range(0, len(text), 7):
        r.push(text[at : at + 7])
    [value] = r.finish()
    assert isinstance(value, Array)
    assert len(value.items) == 300_000
    assert time.perf_counter() - started < 10
