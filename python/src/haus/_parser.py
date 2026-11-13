"""The haus parser: recursive descent over one complete text (spec §1 to §8).

A port of typescript/packages/haus/src/parser.ts, with the same error
messages. Runs of ordinary characters are matched with regular expressions,
so the Python loop only runs at delimiters, escapes and errors. Every pattern
is linear: the possessive quantifiers (`*+`, `++`) never give back input.

Each nesting level costs two Python frames (`_value` → `_record` / `_list` →
`_value`; the `_items` generator is suspended, not on the stack, while an item
is parsed), so the default depth of 256 stays well within Python's recursion
limit.
"""

from __future__ import annotations

import re
import string
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from decimal import Decimal
from typing import Never

from ._errors import HausSyntaxError
from ._value import Array, Bytes, Number, Record, String, Value, Variant


@dataclass(frozen=True, slots=True, kw_only=True)
class Limits:
    """Resource limits, enforced while parsing (spec §7)."""

    max_depth: int = 256
    """Nesting depth of records, arrays and payloads."""
    max_number_length: int = 1000
    """Characters in one number literal, including sign, separators and exponent."""
    max_exponent: int = 6144
    """Largest absolute exponent: 6144 allows `1e6144` but not `1e6145`."""
    max_string_length: int = 16 * 1024 * 1024
    """Characters in one decoded string, or between the quotes of a byte string."""


DEFAULT_LIMITS = Limits()

_WHITESPACE = re.compile(r"[ \t\n]*+")
_BLANKS = re.compile(r"[ \t]*+")
_IDENT = re.compile(r"[A-Za-z0-9_]*+")
_IDENT_OR_DOT = re.compile(r"[A-Za-z0-9_.]*+")

_HEX = re.compile(r"-?0x([0-9A-Fa-f](?:_?[0-9A-Fa-f])*+)")
_BIN = re.compile(r"-?0b([01](?:_?[01])*+)")
_DEC = re.compile(r"-?(?:0|[1-9](?:_?[0-9])*+)(?:\.[0-9](?:_?[0-9])*+)?(?:[eE][+-]?[0-9](?:_?[0-9])*+)?")
_NUMBER_CHARS = re.compile(r"[-+0-9A-Za-z_.]*+")
_EXPONENT = re.compile(r"-?(?:0|[1-9][0-9_]*+)(?:\.[0-9_]++)?[eE][+-]?([0-9_]++)")

# Characters a string may hold raw: no quote, backslash, control or bidi character.
_STRING_RUN = re.compile(r'[^"\\\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]*+')
# Block string lines also allow tabs and quotes.
_BLOCK_RUN = re.compile(r"[^\\\x00-\x08\x0a-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]*+")
# Everything up to the closing `"""`, skipping escaped characters.
_BLOCK_BODY = re.compile(r'(?:[^\\"]++|\\.|"(?!""))*+', re.DOTALL)
_BLANK_LINE = re.compile(r"[ \t]*+")
_UNICODE_ESCAPE = re.compile(r"\{([0-9A-Fa-f]{1,6})\}")
_BYTES_RUN = re.compile(r"(?:[0-9A-Fa-f]{2}|[ \t])*+")

# Not allowed raw in comments: controls (tab and LF are fine; CR only before LF) and bidi.
_COMMENT_SUSPECT = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]")
_COMMENT_DELIMITER = re.compile(r"/\*|\*/")

_NUMBER_START = frozenset("-" + string.digits)
_TAG_START = frozenset(string.ascii_uppercase)
_KEY_START = frozenset(string.ascii_lowercase + "_")
_HEX_DIGITS = frozenset(string.hexdigits)
_SIMPLE_ESCAPES = {'"': '"', "\\": "\\", "n": "\n", "r": "\r", "t": "\t"}
_BOOLEAN_HINT = " (booleans are the variants True / False)"
_HINTS = {"true": _BOOLEAN_HINT, "false": _BOOLEAN_HINT, "null": " (use the variant None)"}
_TRIVIA_START = frozenset("\r/")  # what can follow whitespace and still be trivia (or a trivia error)


def _run(pattern: re.Pattern[str], src: str, pos: int, end: int = sys.maxsize) -> re.Match[str]:
    """Match one of the `*+` patterns above. They also match the empty string, so they never fail."""
    m = pattern.match(src, pos, end)
    assert m is not None
    return m


def _is_bidi(c: str) -> bool:
    """Raw bidirectional controls aren't allowed outside escapes ("Trojan Source", spec §4)."""
    return "\u202a" <= c <= "\u202e" or "\u2066" <= c <= "\u2069"


def _code(c: str) -> str:
    return f"U+{ord(c):04X}"


def _raw_character(c: str, where: str) -> str:
    """The error for a raw control or bidi character inside a string."""
    escape = f"\\u{{{ord(c):04X}}}"
    if _is_bidi(c):
        return f"raw bidirectional control character {_code(c)} (write it as {escape})"
    return f"raw control character {_code(c)} {where} (write it as {escape})"


def _describe(c: str) -> str:
    match c:
        case "":
            return "end of input"
        case "\n":
            return "line break"
        case _:
            return f"'{c}'"


def _decimal_text(n: int) -> str:
    """`str(n)` without CPython's 4300-digit limit on int-to-text conversion."""
    return str(Decimal(n))


def _normalize_exponent(text: str) -> str:
    """The exponent of a decimal literal as its value (spec §2): `1e+05` is `1e5`, `1e-0` is `1e0`."""
    mantissa, e, exponent = text.partition("e")
    if not e:
        return text
    digits = exponent.lstrip("+-").lstrip("0") or "0"
    sign = "-" if exponent.startswith("-") and digits != "0" else ""
    return f"{mantissa}e{sign}{digits}"


def _exceeds(digits: str, limit: int) -> bool:
    """Whether the decimal `digits` (maybe with `_`) are larger than `limit`, without a huge `int`."""
    significant = digits.replace("_", "").lstrip("0")
    return len(significant) > len(str(limit)) or (significant != "" and int(significant) > limit)


class Parser:
    """Recursive-descent parser over one complete text."""

    __slots__ = ("depth", "limits", "pos", "src")

    def __init__(self, src: str, limits: Limits = DEFAULT_LIMITS) -> None:
        self.src = src
        self.limits = limits
        self.pos = 0
        self.depth = 0

    def parse_sequence(self) -> list[Value]:
        """A whole file: zero or more comma-separated values (spec §6)."""
        try:
            return self._sequence()
        except RecursionError:
            self._fail(
                f"nesting too deep for Python's recursion limit ({sys.getrecursionlimit()}); "
                "lower max_depth or raise the limit with sys.setrecursionlimit"
            )

    def _sequence(self) -> list[Value]:
        if self.src.startswith("\ufeff"):
            self.pos = 1
        values: list[Value] = []
        self._skip_trivia()
        while not self._eof():
            values.append(self._value())
            self._skip_trivia()
            if self._eof():
                break
            self._expect(",", "expected ',' between top-level values")
            self._skip_trivia()
        return values

    # ── values ─────────────────────────────────────────────────

    def _value(self) -> Value:
        match self._peek():
            case "{":
                return self._record()
            case "[":
                return Array(self._list("[", "]"))
            case '"' if self.src.startswith('"""', self.pos):
                return self._block_string()
            case '"':
                return String(self._string())
            case "x" if self.src.startswith('"', self.pos + 1):
                return self._bytes()
            case c if c in _NUMBER_START:
                return self._number()
            case c if c in _TAG_START:
                return self._variant()
            case c if c in _KEY_START:
                word = self._ident()
                self._fail(
                    f"unexpected identifier '{word}': lowercase identifiers can only be record keys"
                    + _HINTS.get(word, ""),
                    self.pos - len(word),
                )
            case c:
                self._fail(f"expected a value, found {_describe(c)}")

    def _items(self, open_: str, close: str) -> Iterator[None]:
        """Walk `open item, item, … close` (trailing comma allowed), one nesting level deeper.

        Yields at the start of each item; the caller parses it before resuming.
        """
        start = self.pos
        self.depth += 1
        if self.depth > self.limits.max_depth:
            self._fail(f"nesting deeper than {self.limits.max_depth} levels")
        self.pos += 1
        self._skip_trivia()
        while (c := self._peek()) != close:
            if c == "":
                self._fail(f"unclosed '{open_}'", start)
            yield
            self._skip_trivia()
            match self._peek():
                case ",":
                    self.pos += 1
                    self._skip_trivia()
                case c if c == close:
                    pass
                case "":
                    self._fail(f"unclosed '{open_}'", start)
                case c:
                    self._fail(f"expected ',' or '{close}', found {_describe(c)}")
        self.pos += 1
        self.depth -= 1

    def _record(self) -> Record:
        fields: dict[str, Value] = {}
        for _ in self._items("{", "}"):
            key_pos = self.pos
            key = self._key()
            self._skip_trivia()
            self._expect(":", f"expected ':' after key '{key}'")
            self._skip_trivia()
            value = self._value()
            if key in fields:
                self._fail(f"duplicate key '{key}'", key_pos)
            fields[key] = value
        return Record(fields)

    def _list(self, open_: str, close: str) -> tuple[Value, ...]:
        # A plain loop, not a comprehension: on Python 3.11 a comprehension is one more frame per level.
        items: list[Value] = []
        for _ in self._items(open_, close):
            items.append(self._value())
        return tuple(items)

    def _key(self) -> str:
        match self._peek():
            case '"' if self.src.startswith('"""', self.pos):
                self._fail("block strings can't be record keys")
            case '"':
                return self._string()
            case c if c in _KEY_START:
                return self._ident()
            case c if c in _TAG_START:
                word = self._ident()
                self._fail(
                    f"record keys must start with a lowercase letter or '_'; quote it: \"{word}\"",
                    self.pos - len(word),
                )
            case c:
                self._fail(f"expected a record key, found {_describe(c)}")

    def _variant(self) -> Variant:
        tag = self._ident()
        after_tag = self.pos
        # The payload must follow on the same line: only spaces and tabs in between.
        # Otherwise `Heartbeat⏎{ a: 1 }` with a forgotten comma would silently
        # become one variant with a payload (spec §5).
        self.pos = _run(_BLANKS, self.src, after_tag).end()
        match self._peek():
            case "(":
                paren = self.pos
                if not (args := self._list("(", ")")):
                    self._fail(f"empty payload: write '{tag}' without parentheses", paren)
                return Variant(tag, args)
            case "{":
                return Variant(tag, (self._record(),))
            case _:
                self.pos = after_tag
                return Variant(tag)

    # ── numbers ────────────────────────────────────────────────

    def _number(self) -> Number:
        start = self.pos
        self._check_number_limits(start)
        text = self._radix_number(start) or self._decimal_number(start)
        end = _run(_IDENT_OR_DOT, self.src, self.pos).end()
        if end > self.pos:
            self._fail(f"invalid number '{self.src[start:end]}'", start)
        return Number(text)

    def _radix_number(self, start: int) -> str | None:
        """A hex or binary literal as a decimal integer, or None if it isn't one."""
        for pattern, base in ((_HEX, 16), (_BIN, 2)):
            if m := pattern.match(self.src, start):
                n = int(m[1].replace("_", ""), base)
                self.pos = m.end()
                return ("-" if self.src[start] == "-" and n != 0 else "") + _decimal_text(n)
        return None

    def _decimal_number(self, start: int) -> str:
        if not (m := _DEC.match(self.src, start)):
            self._fail("invalid number", start)
        self.pos = m.end()
        return _normalize_exponent(m[0].replace("_", "").replace("E", "e"))

    def _check_number_limits(self, start: int) -> None:
        """Checked before converting, so huge literals are rejected cheaply."""
        end = _run(_NUMBER_CHARS, self.src, start).end()
        if end - start > self.limits.max_number_length:
            self._fail(f"number literal longer than {self.limits.max_number_length} characters", start)
        if (m := _EXPONENT.fullmatch(self.src, start, end)) and _exceeds(m[1], self.limits.max_exponent):
            self._fail(f"exponent larger than {self.limits.max_exponent}", start)

    # ── bytes ──────────────────────────────────────────────────

    def _bytes(self) -> Bytes:
        """`x"0b34 ff"`: two hex digits per byte; spaces and tabs between bytes."""
        start = self.pos
        body = start + 2  # after x"
        end = _run(_BYTES_RUN, self.src, body).end()
        match self.src[end : end + 1]:
            case '"':
                pass
            case "":
                self._fail("unterminated byte string", start)
            case "\r" | "\n":
                self._fail('line break in byte string (keep x"…" on one line)', end)
            case c if c in _HEX_DIGITS:
                self._fail("a byte needs two hex digits (an odd number of digits, or a space inside a byte)", end)
            case c:
                self._fail(f"invalid character {_describe(c)} in byte string (expected hex digits)", end)
        if end - body > self.limits.max_string_length:
            self._fail(f"byte string longer than {self.limits.max_string_length} characters", start)
        self.pos = end + 1
        return Bytes(bytes.fromhex(self.src[body:end]))

    # ── strings ────────────────────────────────────────────────

    def _string(self) -> str:
        """A `"…"` string, decoded."""
        start = self.pos
        src = self.src
        pos = start + 1
        out: list[str] = []
        while True:
            m = _run(_STRING_RUN, src, pos)
            out.append(m[0])
            pos = m.end()
            match src[pos : pos + 1]:
                case '"':
                    break
                case "\\":
                    text, pos = self._escape(pos)
                    out.append(text)
                case "":
                    self._fail("unterminated string", start)
                case "\n":
                    self._fail('line break in string (use \\n or a """ block string)', pos)
                case "\t":
                    self._fail("raw tab in string (use \\t)", pos)
                case c:
                    self._fail(_raw_character(c, "in string"), pos)
        self.pos = pos + 1
        return self._checked("".join(out), start)

    def _escape(self, at: int) -> tuple[str, int]:
        """At a backslash: the escaped text and the position after the escape."""
        match self.src[at + 1 : at + 2]:
            case e if e in _SIMPLE_ESCAPES:
                return _SIMPLE_ESCAPES[e], at + 2
            case "u":
                if not (m := _UNICODE_ESCAPE.match(self.src, at + 2)):
                    self._fail("invalid unicode escape: expected \\u{1-6 hex digits}", at)
                cp = int(m[1], 16)
                if cp > 0x10FFFF or 0xD800 <= cp <= 0xDFFF:
                    self._fail(f"\\u{{{m[1]}}} is not a Unicode scalar value", at)
                return chr(cp), m.end()
            case e:
                self._fail(f"invalid escape '\\{e}'", at)

    def _block_string(self) -> String:
        start = self.pos
        src = self.src
        self.pos = _run(_BLANKS, src, start + 3).end()
        if src.startswith("\r\n", self.pos):
            self.pos += 2
        elif src.startswith("\n", self.pos):
            self.pos += 1
        else:
            self._fail('opening """ must be followed by a line break', start if self._eof() else self.pos)

        content = self.pos
        close = _run(_BLOCK_BODY, src, content).end()
        if not src.startswith('"""', close):
            self._fail("unterminated block string", start)

        # Split into lines (LF or CRLF), as (start, end) positions in the source.
        lines: list[tuple[int, int]] = []
        at = content
        while (newline := src.find("\n", at, close)) >= 0:
            end = newline - 1 if newline > at and src[newline - 1] == "\r" else newline
            lines.append((at, end))
            at = newline + 1
        indent = src[at:close]
        if not _BLANK_LINE.fullmatch(indent):
            self._fail('closing """ must be on its own line', close)

        out: list[str] = []
        for line_start, line_end in lines:
            if src.startswith(indent, line_start, line_end):
                out.append(self._block_line(line_start + len(indent), line_end))
            elif _BLANK_LINE.fullmatch(src, line_start, line_end):
                out.append("")
            else:
                self._fail('line is indented less than the closing """', line_start)
        self.pos = close + 3
        return String(self._checked("\n".join(out), start))

    def _block_line(self, start: int, end: int) -> str:
        """One block string line without its indentation, escapes decoded."""
        src = self.src
        out: list[str] = []
        pos = start
        while True:
            m = _run(_BLOCK_RUN, src, pos, end)
            out.append(m[0])
            pos = m.end()
            if pos >= end:
                return "".join(out)
            if src[pos] != "\\":
                self._fail(_raw_character(src[pos], "in block string"), pos)
            text, pos = self._escape(pos)
            out.append(text)

    def _checked(self, s: str, start: int) -> str:
        if len(s) > self.limits.max_string_length:
            self._fail(f"string longer than {self.limits.max_string_length} characters", start)
        return s

    # ── trivia ─────────────────────────────────────────────────

    def _skip_trivia(self) -> None:
        src = self.src
        while True:
            self.pos = _run(_WHITESPACE, src, self.pos).end()
            if src[self.pos : self.pos + 1] not in _TRIVIA_START:
                return
            match src[self.pos : self.pos + 2]:
                case "\r\n":
                    self.pos += 2
                case "//":
                    newline = src.find("\n", self.pos)
                    end = len(src) if newline < 0 else newline
                    self._check_comment(self.pos, end)
                    self.pos = end
                case "/*":
                    self._skip_block_comment()
                case next_two if next_two.startswith("\r"):
                    self._fail("carriage return without a line feed (line breaks are LF or CRLF)")
                case _:
                    self._fail("unexpected '/' (comments are // or /* */)")

    def _skip_block_comment(self) -> None:
        """`/* … */`, which nest."""
        start = self.pos
        depth = 0
        for m in _COMMENT_DELIMITER.finditer(self.src, start):
            depth += 1 if m[0] == "/*" else -1
            if depth == 0:
                self._check_comment(start, m.end())
                self.pos = m.end()
                return
        self._fail("unterminated block comment", start)

    def _check_comment(self, start: int, end: int) -> None:
        """Comments are where "Trojan Source" attacks hide reordered text, and where
        control characters (ESC, CSI, NUL) can rewrite what a terminal shows.
        Allowed: tab, and in block comments line breaks (CR only before LF)."""
        for m in _COMMENT_SUSPECT.finditer(self.src, start, end):
            i = m.start()
            match m[0]:
                case "\r" if self.src.startswith("\n", i + 1):
                    continue
                case "\r":
                    self._fail("carriage return without a line feed (line breaks are LF or CRLF)", i)
                case c if _is_bidi(c):
                    self._fail(f"raw bidirectional control character {_code(c)} in comment", i)
                case c:
                    self._fail(f"raw control character {_code(c)} in comment", i)

    # ── helpers ────────────────────────────────────────────────

    def _ident(self) -> str:
        start = self.pos
        self.pos = _run(_IDENT, self.src, start).end()
        return self.src[start : self.pos]

    def _peek(self) -> str:
        """The next character, or "" at the end."""
        return self.src[self.pos : self.pos + 1]

    def _eof(self) -> bool:
        return self.pos >= len(self.src)

    def _expect(self, ch: str, message: str) -> None:
        if self._peek() != ch:
            self._fail(f"{message}, found {_describe(self._peek())}")
        self.pos += 1

    def _fail(self, reason: str, at: int | None = None) -> Never:
        raise HausSyntaxError.at(self.src, self.pos if at is None else at, reason)
