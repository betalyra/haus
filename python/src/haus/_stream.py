"""Streams (spec §6): a file of values, each followed by a comma, read as the
values arrive.

A small scanner finds the commas between top-level values. It tracks only
what decides that: bracket depth, strings, block strings and comments.
Everything else is left to the parser, which parses each piece before such a
comma as exactly one value, and what is left at the end as zero or one value.
The scanner looks at most three characters ahead (`\"\"\"`, `//`, `*/`, `\\"`);
when a chunk ends before it can decide, it waits for the next one. This is
the design modelled and proven correct in spec/lean/Haus/Stream.lean.

Memory is bounded by the largest single value, not by the stream.
"""

from __future__ import annotations

import codecs
import re
from collections.abc import Iterable, Iterator
from enum import Enum, auto
from typing import NamedTuple, Never, Protocol, runtime_checkable

from ._errors import HausSyntaxError
from ._parser import DEFAULT_LIMITS, Limits, Parser
from ._value import Value

DEFAULT_MAX_VALUE_LENGTH = 64 * 1024 * 1024
"""The most characters in one top-level value of a stream (spec §7)."""

_CHUNK_SIZE = 64 * 1024

# Runs the scanner can skip in each mode: everything but the characters that matter there.
_NORMAL_RUN = re.compile(r'[^/"{}\[\](),]*+')
_COMMENT_RUN = re.compile(r"[^/*]*+")
_STRING_RUN = re.compile(r'[^\\"\n]*+')
_BLOCK_RUN = re.compile(r'[^\\"]*+')
_OPEN = frozenset("{[(")
_CLOSE = frozenset("}])")


def _run(pattern: re.Pattern[str], text: str, pos: int, end: int) -> int:
    """Where a run of `pattern` starting at `pos` ends. The patterns match the empty string too."""
    m = pattern.match(text, pos, end)
    assert m is not None
    return m.end()


class _Mode(Enum):
    NORMAL = auto()
    STRING = auto()
    """In a basic string `"…"` or a byte string `x"…"`."""
    BLOCK = auto()
    LINE_COMMENT = auto()
    COMMENT = auto()
    """In a block comment, nested `comment_depth` levels."""


class _Position(NamedTuple):
    """Where a text starts in the whole input: offset in code points, 1-based line and column."""

    offset: int
    line: int
    column: int

    def after(self, text: str) -> _Position:
        """Where the text after `text` starts."""
        newlines = text.count("\n")
        column = len(text) - text.rfind("\n") if newlines else self.column + len(text)
        return _Position(self.offset + len(text), self.line + newlines, column)

    def error(self, reason: str) -> HausSyntaxError:
        return HausSyntaxError(reason, self.offset, self.line, self.column)

    def shift(self, e: HausSyntaxError) -> HausSyntaxError:
        """An error in a text that starts here, as an error in the whole input."""
        column = e.column + self.column - 1 if e.line == 1 else e.column
        return HausSyntaxError(e.reason, self.offset + e.offset, self.line + e.line - 1, column)


_START = _Position(0, 1, 1)


class StreamReader:
    """Reads a stream from chunks of text or UTF-8 bytes, split anywhere.

    `push` returns the values each chunk completed (a value is complete when
    the comma after it arrives); `finish` returns the last value if it had no
    comma after it. Errors carry positions in the whole input. After a
    `HausSyntaxError` the reader must not be used again.
    """

    __slots__ = (
        "_buf",
        "_comment_depth",
        "_decoder",
        "_depth",
        "_done",
        "_done_length",
        "_finished",
        "_first",
        "_limits",
        "_max_value_length",
        "_mode",
        "_origin",
        "_require_terminator",
    )

    def __init__(
        self,
        *,
        limits: Limits = DEFAULT_LIMITS,
        max_value_length: int = DEFAULT_MAX_VALUE_LENGTH,
        require_terminator: bool = False,
    ) -> None:
        """`require_terminator` asks for a comma after every value, the last one too: a stream
        that ends without one is reported as cut off. Recommended for network streams."""
        self._limits = limits
        self._max_value_length = max_value_length
        self._require_terminator = require_terminator
        self._decoder = codecs.getincrementaldecoder("utf-8")()
        self._done: list[str] = []
        """The current value's text already scanned, in pieces (joined once, when it is complete)."""
        self._done_length: int = 0
        self._buf = ""
        """Text not scanned yet: at most a few characters of lookahead between chunks."""
        self._mode = _Mode.NORMAL
        self._depth = 0
        self._comment_depth = 0
        self._origin = _START
        """Where the current value starts in the whole input."""
        self._first = True
        """No value has been cut yet: only the first piece may start with a byte order mark."""
        self._finished = False

    def push(self, chunk: str | bytes) -> list[Value]:
        """Add a chunk; returns the values it completed."""
        if self._finished:
            raise RuntimeError("StreamReader: push() after finish()")
        if isinstance(chunk, str):
            self._flush_decoder()
            return self._scan(chunk, final=False)
        try:
            text = self._decoder.decode(chunk)
        except UnicodeDecodeError as e:
            # Read what was valid first: an error before it comes first.
            self._scan(e.object[: e.start].decode("utf-8"), final=False)
            raise self._end().error("invalid UTF-8") from None
        return self._scan(text, final=False)

    def finish(self) -> list[Value]:
        """The input is complete: returns the last value, if it had no comma after it."""
        if self._finished:
            raise RuntimeError("StreamReader: finish() called twice")
        self._flush_decoder()
        self._finished = True
        out = self._scan("", final=True)
        # Whatever is left has no top-level comma: zero or one value.
        text = "".join(self._done) + self._buf
        rest = self._parse(text)
        if rest and self._require_terminator:
            raise self._origin.after(text).error("stream ended without ',' after the last value (truncated?)")
        out.extend(rest)
        self._done, self._done_length, self._buf = [], 0, ""
        return out

    def _flush_decoder(self) -> None:
        """Bytes of an unfinished UTF-8 sequence can't be followed by text, or by the end."""
        try:
            self._decoder.decode(b"", final=True)
        except UnicodeDecodeError:
            raise self._end().error("invalid UTF-8") from None

    def _end(self) -> _Position:
        """Where the text received so far ends."""
        return self._origin.after("".join(self._done) + self._buf)

    # ── the scanner ────────────────────────────────────────────

    def _scan(self, chunk: str, *, final: bool) -> list[Value]:
        """Finds the commas between values in the text received, and parses what is before them.

        The current value starts at `start` in `buf`. The text of values already returned
        is dropped once per chunk, not after each value: that would make a chunk holding
        many values take quadratic time.
        """
        buf = self._buf + chunk
        n = len(buf)
        out: list[Value] = []
        start = i = 0

        def has(k: int) -> bool:
            """Is the character `k` places ahead there (or will it never come)?"""
            return final or i + k < n

        while i < n:
            # The current value may grow up to here; one more character is an error.
            # A byte order mark at the start of the stream isn't part of the first value.
            bom = self._first and (self._done[0] if self._done else buf[start:])[:1] == "\ufeff"
            limit = start + self._max_value_length + bom - self._done_length
            if i > limit:
                raise self._origin.error(f"value longer than {self._max_value_length} characters")
            end = min(n, limit + 1)
            match self._mode:
                case _Mode.NORMAL:
                    i = _run(_NORMAL_RUN, buf, i, end)
                    if i >= end:
                        continue
                    c = buf[i]
                    if c == "/":
                        if not has(1):
                            break
                        match buf[i + 1 : i + 2]:
                            case "/":
                                self._mode = _Mode.LINE_COMMENT
                                i += 2
                            case "*":
                                self._mode, self._comment_depth = _Mode.COMMENT, 1
                                i += 2
                            case _:
                                i += 1
                    elif c == '"':
                        if not has(2):
                            break
                        block = buf.startswith('"""', i)
                        self._mode = _Mode.BLOCK if block else _Mode.STRING
                        i += 3 if block else 1
                    elif c in _OPEN:
                        self._depth += 1
                        i += 1
                    elif c in _CLOSE:
                        if self._depth == 0:
                            self._unbalanced(buf[start : i + 1])
                        self._depth -= 1
                        i += 1
                    elif self._depth == 0:  # a comma between values
                        out.append(self._cut(buf[start:i]))
                        start = i = i + 1
                    else:
                        i += 1
                case _Mode.LINE_COMMENT:
                    newline = buf.find("\n", i, end)
                    if newline < 0:
                        i = end
                    else:
                        self._mode = _Mode.NORMAL
                        i = newline + 1
                case _Mode.COMMENT:
                    i = _run(_COMMENT_RUN, buf, i, end)
                    if i >= end:
                        continue
                    if not has(1):
                        break
                    if buf.startswith("/*", i):
                        self._comment_depth += 1
                        i += 2
                    elif buf.startswith("*/", i):
                        self._comment_depth -= 1
                        if self._comment_depth == 0:
                            self._mode = _Mode.NORMAL
                        i += 2
                    else:
                        i += 1
                case _Mode.STRING:
                    i = _run(_STRING_RUN, buf, i, end)
                    if i >= end:
                        continue
                    if buf[i] == "\\":
                        if not has(1):
                            break
                        i = min(n, i + 2)
                    else:
                        # A line break can't be in a string: back to normal, the parser reports it.
                        self._mode = _Mode.NORMAL
                        i += 1
                case _Mode.BLOCK:
                    i = _run(_BLOCK_RUN, buf, i, end)
                    if i >= end:
                        continue
                    if buf[i] == "\\":
                        if not has(1):
                            break
                        i = min(n, i + 2)
                    else:
                        if not has(2):
                            break
                        if buf.startswith('"""', i):
                            self._mode = _Mode.NORMAL
                            i += 3
                        else:
                            i += 1
        self._done.append(buf[start:i])
        self._done_length += i - start
        self._buf = buf[i:]
        return out

    # ── parsing the pieces ─────────────────────────────────────

    def _cut(self, tail: str) -> Value:
        """Parse the current value, whose text ends with `tail`; the next one starts after the comma."""
        text = "".join(self._done) + tail
        values = self._parse(text)
        if len(values) != 1:
            raise self._origin.after(text).error("expected a value, found ','")
        self._origin = self._origin.after(text).after(",")
        self._done, self._done_length = [], 0
        self._first = False
        return values[0]

    def _parse(self, text: str) -> list[Value]:
        """The values of one piece. Only the first may start with a byte order mark."""
        if not self._first and text.startswith("\ufeff"):
            raise self._origin.error("byte order mark after the start of the stream")
        try:
            return Parser(text, self._limits).parse_sequence()
        except HausSyntaxError as e:
            raise self._origin.shift(e) from None

    def _unbalanced(self, tail: str) -> Never:
        """A closing bracket that closes nothing, at the end of `tail`: the parser says what's wrong."""
        text = "".join(self._done) + tail
        self._parse(text)
        raise self._origin.after(text[:-1]).error(f"unexpected '{text[-1]}'")


@runtime_checkable
class Readable(Protocol):
    """A file opened for reading, in binary or text mode."""

    def read(self, size: int, /) -> str | bytes: ...


def parse_stream(
    source: Readable | Iterable[str | bytes],
    *,
    limits: Limits = DEFAULT_LIMITS,
    max_value_length: int = DEFAULT_MAX_VALUE_LENGTH,
    require_terminator: bool = False,
) -> Iterator[Value]:
    """The values of a stream, as they arrive: from a file, or any iterable of text or UTF-8 byte chunks.

    with open("events.haus", "rb") as f:
        for event in haus.parse_stream(f):
            ...
    """
    reader = StreamReader(limits=limits, max_value_length=max_value_length, require_terminator=require_terminator)
    for chunk in _chunks(source):
        yield from reader.push(chunk)
    yield from reader.finish()


def _chunks(source: Readable | Iterable[str | bytes]) -> Iterator[str | bytes]:
    if not isinstance(source, Readable):
        yield from source
        return
    while chunk := source.read(_CHUNK_SIZE):
        yield chunk
