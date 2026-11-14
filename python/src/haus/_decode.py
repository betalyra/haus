"""Decoding and encoding with a schema (spec §15): the resolved types of a
schema file (`_schema_file`) built into a tree of nodes, each with `decode`
(haus `Value` → Python) and `encode` (Python → `Value`).

Linear whatever the schema (spec §9.8): a variant's case is one dict lookup
on its tag, the nesting depth is limited (256 by default), and every call has
a work budget, 16 steps per value of the input when decoding. A secret's
errors never show its value. The host types are described in `haus.schema`.
"""

from __future__ import annotations

import json
import math
import re
import struct
from collections.abc import Iterable, Mapping, Sequence
from decimal import Decimal
from typing import Final, Never, Protocol, cast

from ._float import FloatKind, float_text, to_float32, to_float64
from ._host import Nothing, Secret, Some, Tagged, Unknown
from ._number import INTEGER, int_text, normalize_number, number_limit_issue, to_int
from ._parser import Limits
from ._schema_file import (
    ArrayType,
    BuiltinType,
    MapType,
    MaybeType,
    NoPayload,
    ParamType,
    PositionalPayload,
    RecordPayload,
    RecordType,
    RefType,
    SecretType,
    StdType,
    Type,
    VariantType,
)
from ._schema_file import Instance as _Instance
from ._time import check as check_time
from ._value import Array, Bytes, Number, Record, String, Value, Variant

PathKey = str | int

_KEY = re.compile(r"[a-z_][A-Za-z0-9_]*")
_TAG = re.compile(r"[A-Z][A-Za-z0-9_]*")
_SURROGATE = re.compile(r"[\ud800-\udfff]")

STEPS_PER_VALUE: Final = 16
DEFAULT_ENCODE_STEPS: Final = 16 * 1024 * 1024
_MAX_VALUES: Final = 64 * 1024 * 1024


def format_path(path: Iterable[PathKey]) -> str:
    """`$.items[2].price`, `$["x-y"]`."""
    parts = (
        f"[{p}]" if isinstance(p, int) else f".{p}" if _KEY.fullmatch(p) else f"[{json.dumps(p, ensure_ascii=False)}]"
        for p in path
    )
    return "$" + "".join(parts)


class HausDecodeError(ValueError):
    """A value the type doesn't accept, with the place of the failing value (spec §15)."""

    reason: str
    """The message without the path."""
    path: tuple[PathKey, ...]
    """Where the mismatch is: `("items", 2, "price")`."""

    def __init__(self, reason: str, path: tuple[PathKey, ...]) -> None:
        super().__init__(f"{reason} at {format_path(path)}")
        self.reason = reason
        self.path = path


class HausEncodeError(ValueError):
    """A Python value that doesn't fit its type when encoding."""

    reason: str
    path: tuple[PathKey, ...]

    def __init__(self, reason: str, path: tuple[PathKey, ...]) -> None:
        super().__init__(f"{reason} at {format_path(path)}")
        self.reason = reason
        self.path = path


class Codec(Protocol):
    """A host type chosen by the application for a named type without arguments (spec §13.4).

    `decode` runs after the type's own decoding, on its default host value, and may reject
    more values (raise `ValueError`); `encode` gives back a default host value.
    """

    def decode(self, value: object, /) -> object: ...

    def encode(self, value: object, /) -> object: ...


# ── where a node is applied ──────────────────────────────────


class _Context:
    __slots__ = ("ancestors", "decoding", "limits", "max_steps", "steps")

    def __init__(self, *, decoding: bool, limits: Limits, max_steps: int) -> None:
        self.decoding = decoding
        self.limits = limits
        self.max_steps = max_steps
        self.steps = 0
        self.ancestors: set[int] = set()
        """Encoding: the ids of the containers on the current path, to detect values that contain themselves."""


_NO_KEY: Final = object()


class _At:
    """The place a node is applied: the path (linked to its parent, built only for errors) and the depth."""

    __slots__ = ("ctx", "depth", "key", "parent")

    def __init__(self, ctx: _Context, parent: _At | None, key: PathKey | None, depth: int) -> None:
        self.ctx = ctx
        self.parent = parent
        self.key = key
        self.depth = depth

    def child(self, key: PathKey) -> _At:
        if self.depth >= self.ctx.limits.max_depth:
            self.fail(f"nesting deeper than {self.ctx.limits.max_depth} levels", key)
        return _At(self.ctx, self, key, self.depth + 1)

    def container(self) -> None:
        """Encoding a record, array or payload here: it is one more level of nesting when written."""
        if self.depth >= self.ctx.limits.max_depth:
            self.fail(f"nesting deeper than {self.ctx.limits.max_depth} levels")

    def step(self) -> None:
        ctx = self.ctx
        ctx.steps += 1
        if ctx.steps > ctx.max_steps:
            mode = "decode" if ctx.decoding else "encode"
            self.fail(f"{mode} budget of {ctx.max_steps} steps exceeded (a schema doing more work than the input)")

    def path(self) -> tuple[PathKey, ...]:
        out: list[PathKey] = []
        at: _At | None = self
        while at is not None:
            if at.key is not None:
                out.append(at.key)
            at = at.parent
        return tuple(reversed(out))

    def fail(self, reason: str, child: object = _NO_KEY) -> Never:
        path = self.path() if child is _NO_KEY else (*self.path(), _path_key(child))
        raise (HausDecodeError if self.ctx.decoding else HausEncodeError)(reason, path)

    def enter(self, obj: object) -> None:
        """Encoding: `obj` is being written here; meeting it again further down is a cycle."""
        if id(obj) in self.ctx.ancestors:
            self.fail("cyclic value: an object contains itself")
        self.ctx.ancestors.add(id(obj))

    def leave(self, obj: object) -> None:
        self.ctx.ancestors.discard(id(obj))


def _path_key(k: object) -> PathKey:
    return k if isinstance(k, str | int) and not isinstance(k, bool) else _describe_py(k)


# ── descriptions for errors (bounded, spec §9.8) ─────────────


def _short(text: str, n: int = 30) -> str:
    return text if len(text) <= n else text[:n] + "…"


def _describe(v: Value) -> str:
    match v:
        case Number(text):
            return f"number {_short(text)}"
        case String(s):
            return f"string {json.dumps(_short(s), ensure_ascii=False)}"
        case Bytes(data):
            return f"bytes ({len(data)})"
        case Array():
            return "array"
        case Record():
            return "record"
        case Variant(tag):
            return f"variant {_short(tag)}"


def _describe_py(x: object) -> str:
    """A short description of a Python value. Never calls the value's own methods."""
    match x:
        case None:
            return "None"
        case bool():
            return repr(x)
        case int():
            return int_text(x) if x.bit_length() < 64 else f"an int of {x.bit_length()} bits"
        case float():
            return float.__repr__(x)
        case str():
            return json.dumps(_short(x), ensure_ascii=False)
        case _:
            return f"a {type(x).__name__}"


def _mismatch(expected: str, v: Value, at: _At) -> Never:
    at.fail(f"expected {expected}, found {_describe(v)}")


def _invalid(what: str, x: object, at: _At) -> Never:
    at.fail(f"expected {what}, got {_describe_py(x)}")


def _tag_list(tags: Iterable[str]) -> str:
    ts = list(tags)
    return " | ".join(ts) if len(ts) <= 10 else " | ".join(ts[:10]) + f" | … ({len(ts)} tags)"


# ── values written from Python: within the limits (spec §9.8) ──


def _checked_string(s: object, at: _At, what: str = "a string") -> str:
    if not isinstance(s, str):
        _invalid(what, s, at)
    limit = at.ctx.limits.max_string_length
    if len(s) > limit:
        at.fail(f"string longer than {limit} characters")
    if not s.isascii() and _SURROGATE.search(s):
        at.fail("string with a lone surrogate (not Unicode text)")
    return s


def _checked_bytes(b: object, at: _At) -> bytes:
    if not isinstance(b, bytes | bytearray):
        _invalid("bytes", b, at)
    if 2 * len(b) > at.ctx.limits.max_string_length:
        at.fail(f"byte string longer than {at.ctx.limits.max_string_length} characters")
    return bytes(b)


def _checked_number(text: object, at: _At, what: str) -> str:
    if not isinstance(text, str) or (normalized := normalize_number(text, at.ctx.limits)) is None:
        _invalid(what, text, at)
    if (issue := number_limit_issue(normalized, at.ctx.limits)) is not None:
        at.fail(issue)
    return normalized


def _sequence(x: object, at: _At, what: str) -> Sequence[object]:
    """`x` as a list or tuple of anything (each element is checked where it is used)."""
    if not isinstance(x, list | tuple):
        _invalid(what, x, at)
    return cast("Sequence[object]", x)


def _mapping(x: object, at: _At, what: str) -> Mapping[object, object]:
    if not isinstance(x, Mapping):
        _invalid(what, x, at)
    return cast("Mapping[object, object]", x)


def _checked_tag(tag: object, at: _At) -> str:
    if not isinstance(tag, str) or not _TAG.fullmatch(tag):
        _invalid("a tag name", tag, at)
    return tag


def checked_value(raw: object, at: _At) -> Value:
    """A raw `Value` to write again (an `Any`, an unknown value): a haus value within the limits.

    A `Value` built in code may hold anything, so it is checked node by node; number
    literals are normalized as the parser would. Parts without a change are kept as
    they are, so a parsed value comes back unchanged (the same objects).
    """
    at.step()
    match raw:
        case Number(text):
            normalized = _checked_number(text, at, "a number literal")
            return raw if normalized == text else Number(normalized)
        case String(s):
            _checked_string(s, at)
            return raw
        case Bytes(data):
            return raw if _checked_bytes(data, at) is data else Bytes(bytes(data))
        case Array(items):
            new_items = _checked_items(raw, _sequence(items, at, "a tuple of items"), at)
            return raw if new_items is None else Array(new_items)
        case Record():
            return _checked_record(raw, at)
        case Variant(tag, args):
            _checked_tag(tag, at)
            match _sequence(args, at, "a tuple of arguments"):
                case (Record() as record,):
                    # `Tag { … }` is one level, as in the parser.
                    checked = _checked_record(record, at)
                    return raw if checked is record else Variant(tag, (checked,))
                case values:
                    new_args = _checked_items(raw, values, at)
                    return raw if new_args is None else Variant(tag, new_args)
        case _:
            _invalid("a haus value", raw, at)


def _checked_items(raw: Value, items: Sequence[object], at: _At) -> tuple[Value, ...] | None:
    """The elements or arguments of `raw`, checked; None when nothing changed."""
    if items:
        at.container()
    at.enter(raw)
    out: list[Value] = []
    for i, x in enumerate(items):
        out.append(checked_value(x, at.child(i)))
    at.leave(raw)
    return None if isinstance(items, tuple) and all(map(_same, out, items)) else tuple(out)


def _same(a: object, b: object) -> bool:
    return a is b


def _checked_record(raw: Record, at: _At) -> Record:
    fields = _mapping(raw.fields, at, "a mapping of fields")
    at.container()
    at.enter(raw)
    out: dict[str, Value] = {}
    changed = False
    for k, x in fields.items():
        key = _checked_string(k, at, "a string key")
        y = checked_value(x, at.child(key))
        changed = changed or y is not x
        out[key] = y
    at.leave(raw)
    return Record(out) if changed else raw


# ── nodes ────────────────────────────────────────────────────


class _Node:
    """One type: `decode` a value at a place, `encode` a Python value. Each application is one step."""

    __slots__ = ("expected",)

    def __init__(self, expected: str) -> None:
        self.expected = expected
        """What it accepts, for error messages."""

    def decode(self, v: Value, at: _At) -> object:
        raise NotImplementedError

    def encode(self, x: object, at: _At) -> Value:
        raise NotImplementedError


class _String(_Node):
    __slots__ = ()

    def decode(self, v: Value, at: _At) -> object:
        at.step()
        if isinstance(v, String):
            return v.value
        _mismatch("String", v, at)

    def encode(self, x: object, at: _At) -> Value:
        at.step()
        return String(_checked_string(x, at))


class _Bytes(_Node):
    __slots__ = ()

    def decode(self, v: Value, at: _At) -> object:
        at.step()
        if isinstance(v, Bytes):
            return v.data
        _mismatch("Bytes", v, at)

    def encode(self, x: object, at: _At) -> Value:
        at.step()
        return Bytes(_checked_bytes(x, at))


_TRUE, _FALSE = Variant("True"), Variant("False")


class _Bool(_Node):
    __slots__ = ()

    def decode(self, v: Value, at: _At) -> object:
        at.step()
        match v:
            case Variant("True", ()):
                return True
            case Variant("False", ()):
                return False
            case _:
                _mismatch("Bool (True | False)", v, at)

    def encode(self, x: object, at: _At) -> Value:
        at.step()
        if not isinstance(x, bool):
            _invalid("a bool", x, at)
        return _TRUE if x else _FALSE


class _Int(_Node):
    """`Int` (any size) and the sized integers, as `int`. Out of range is an error, never clamped."""

    __slots__ = ("high", "low")

    def __init__(self, name: str, low: int | None = None, high: int | None = None) -> None:
        super().__init__(name)
        self.low = low
        self.high = high

    def _range(self) -> str:
        return f"{self.expected} ({self.low} to {self.high})"

    def decode(self, v: Value, at: _At) -> object:
        at.step()
        if not isinstance(v, Number) or not INTEGER.fullmatch(v.text):
            _mismatch(self.expected, v, at)
        if self.low is not None and self.high is not None:
            # A literal longer than the bounds' can't be in range: no need to convert it.
            n = to_int(v.text) if len(v.text) <= 21 else None
            if n is None or not self.low <= n <= self.high:
                at.fail(f"{_short(v.text)} is out of range for {self._range()}")
            return n
        return to_int(v.text)

    def encode(self, x: object, at: _At) -> Value:
        at.step()
        if not isinstance(x, int) or isinstance(x, bool):
            _invalid("an int", x, at)
        if self.low is not None and self.high is not None and not self.low <= x <= self.high:
            _invalid(f"an int from {self.low} to {self.high}", x, at)
        text = int_text(x)
        if (issue := number_limit_issue(text, at.ctx.limits)) is not None:
            at.fail(issue)
        return Number(text)


_SPECIAL_FLOATS: Final = {"NaN": math.nan, "Infinity": math.inf, "NegInfinity": -math.inf}
_NAN, _INFINITY, _NEG_INFINITY = Variant("NaN"), Variant("Infinity"), Variant("NegInfinity")
_FLOAT32 = struct.Struct("<f")


class _Float(_Node):
    """`Float64`, `Float32` as `float`: the nearest value; too large is an error (spec §15)."""

    __slots__ = ("kind",)

    def __init__(self, kind: FloatKind) -> None:
        super().__init__(kind)
        self.kind: FloatKind = kind

    def decode(self, v: Value, at: _At) -> object:
        at.step()
        match v:
            case Number(text):
                x = to_float32(text) if self.kind == "Float32" else to_float64(text)
                if x is None:
                    at.fail(f"{_short(text)} is too large for {self.kind}")
                return x
            case Variant(tag, ()) if tag in _SPECIAL_FLOATS:
                return _SPECIAL_FLOATS[tag]
            case _:
                _mismatch(f"{self.kind} (a number, NaN, Infinity or NegInfinity)", v, at)

    def encode(self, x: object, at: _At) -> Value:
        at.step()
        if not isinstance(x, float | int) or isinstance(x, bool):
            _invalid("a float", x, at)
        try:
            f = float(x)
            if self.kind == "Float32" and math.isfinite(f):
                (f,) = _FLOAT32.unpack(_FLOAT32.pack(f))
        except OverflowError:
            _invalid(f"a float within the range of {self.kind}", x, at)
        if math.isnan(f):
            return _NAN
        if math.isinf(f):
            return _INFINITY if f > 0 else _NEG_INFINITY
        return Number(float_text(f, self.kind))


class _Decimal(_Node):
    """`Decimal` as the normalized literal text: `"19.90"`, `"1.5e3"` (spec §15)."""

    __slots__ = ()

    def decode(self, v: Value, at: _At) -> object:
        at.step()
        if isinstance(v, Number):
            return v.text
        _mismatch("Decimal", v, at)

    def encode(self, x: object, at: _At) -> Value:
        at.step()
        if isinstance(x, Decimal):
            x = str(x)
        if not isinstance(x, str):
            _invalid('a decimal literal like "19.90"', x, at)
        return Number(_checked_number(x, at, 'a decimal literal like "19.90"'))


class _StdTime(_Node):
    """A std/time type as its checked text: `Date("2026-11-13")` → `"2026-11-13"`."""

    __slots__ = ()

    def decode(self, v: Value, at: _At) -> object:
        at.step()
        match v:
            case Variant(tag, (String(text),)) if tag == self.expected:
                if (reason := check_time(tag, text)) is not None:
                    at.fail(_short(reason, 200), 0)
                return text
            case _:
                _mismatch(f'{self.expected}("…")', v, at)

    def encode(self, x: object, at: _At) -> Value:
        at.step()
        text = _checked_string(x, at)
        if (reason := check_time(self.expected, text)) is not None:
            at.fail(_short(reason, 200))
        return Variant(self.expected, (String(text),))


class _Any(_Node):
    """`Any`: the parsed value, unchanged. Encoding checks it is a value within the limits."""

    __slots__ = ()

    def decode(self, v: Value, at: _At) -> object:
        at.step()
        return v

    def encode(self, x: object, at: _At) -> Value:
        return checked_value(x, at)


class _Array(_Node):
    __slots__ = ("item",)

    def __init__(self, item: _Node) -> None:
        super().__init__(f"Array {_short(item.expected, 40)}")
        self.item = item

    def decode(self, v: Value, at: _At) -> object:
        at.step()
        if not isinstance(v, Array):
            _mismatch(self.expected, v, at)
        item = self.item
        out: list[object] = []
        for i, x in enumerate(v.items):
            out.append(item.decode(x, at.child(i)))
        return tuple(out)

    def encode(self, x: object, at: _At) -> Value:
        at.step()
        xs = _sequence(x, at, "a list or tuple")
        at.container()
        at.enter(x)
        item = self.item
        out: list[Value] = []
        for i, y in enumerate(xs):
            out.append(item.encode(y, at.child(i)))
        at.leave(x)
        return Array(tuple(out))


class _Map(_Node):
    """`Map v` as a dict with any string keys."""

    __slots__ = ("value",)

    def __init__(self, value: _Node) -> None:
        super().__init__(f"Map {_short(value.expected, 40)}")
        self.value = value

    def decode(self, v: Value, at: _At) -> object:
        at.step()
        if not isinstance(v, Record):
            _mismatch(f"{self.expected} (a record)", v, at)
        value = self.value
        out: dict[str, object] = {}
        for k, x in v.fields.items():
            out[k] = value.decode(x, at.child(k))
        return out

    def encode(self, x: object, at: _At) -> Value:
        at.step()
        entries = _mapping(x, at, "a mapping")
        at.container()
        at.enter(x)
        value = self.value
        out: dict[str, Value] = {}
        for k, y in entries.items():
            key = _checked_string(k, at, "string keys")
            out[key] = value.encode(y, at.child(key))
        at.leave(x)
        return Record(out)


_NONE = Variant("None")


class _Maybe(_Node):
    """`Maybe a`: `Nothing()` or `Some(value)`."""

    __slots__ = ("item",)

    def __init__(self, item: _Node) -> None:
        super().__init__(f"Maybe {_short(item.expected, 40)}")
        self.item = item

    def decode(self, v: Value, at: _At) -> object:
        at.step()
        match v:
            case Variant("None", ()):
                return Nothing()
            case Variant("Some", (x,)):
                return Some(self.item.decode(x, at.child(0)))
            case _:
                _mismatch(f"None | Some({_short(self.item.expected, 40)})", v, at)

    def encode(self, x: object, at: _At) -> Value:
        at.step()
        match x:
            case Nothing():
                return _NONE
            case Some():
                at.container()
                value: object = cast("Some[object]", x).value
                return Variant("Some", (self.item.encode(value, at.child(0)),))
            case _:
                _invalid("a Maybe (Some(value) or Nothing())", x, at)


class _Secret(_Node):
    """`Secret a`: decoded into a `Secret`; errors inside give its place and type, never the value."""

    __slots__ = ("item",)

    def __init__(self, item: _Node) -> None:
        super().__init__(f"Secret {_short(item.expected, 40)}")
        self.item = item

    def _concealed(self, at: _At) -> Never:
        at.fail(f"expected {_short(self.item.expected, 40)} (a Secret: the value is not shown)")

    def decode(self, v: Value, at: _At) -> object:
        at.step()
        try:
            return Secret(self.item.decode(v, at))
        except HausDecodeError:
            pass
        # Raised after the `except`, so the inner error (which may show the value) isn't its context.
        self._concealed(at)

    def encode(self, x: object, at: _At) -> Value:
        at.step()
        if not isinstance(x, Secret):
            # Not even a short description of what was given instead: it may be the secret itself.
            at.fail(f"expected a Secret, got a {type(x).__name__}")
        try:
            return self.item.encode(x.expose(), at)  # pyright: ignore[reportUnknownMemberType, reportUnknownArgumentType]
        except HausEncodeError:
            pass
        self._concealed(at)


class _Field:
    __slots__ = ("key", "node", "optional")

    def __init__(self, key: str, node: _Node, optional: bool) -> None:
        self.key = key
        self.node = node
        self.optional = optional


class _Record(_Node):
    """`{ … }` as a dict. A missing optional field stays missing: never `None` (spec §1)."""

    __slots__ = ("closed", "fields", "keys")

    def __init__(self, fields: tuple[_Field, ...], closed: bool) -> None:
        super().__init__("closed record" if closed else "record")
        self.fields = fields
        self.keys = frozenset(f.key for f in fields)
        self.closed = closed

    def decode(self, v: Value, at: _At) -> object:
        at.step()
        if not isinstance(v, Record):
            _mismatch("a record", v, at)
        return self.decode_fields(v.fields, at)

    def decode_fields(self, fields: Mapping[str, Value], at: _At) -> dict[str, object]:
        out: dict[str, object] = {}
        for f in self.fields:
            if (x := fields.get(f.key)) is not None:
                out[f.key] = f.node.decode(x, at.child(f.key))
            elif not f.optional:
                at.fail(f"missing field '{f.key}'")
        if self.closed:
            for k in fields:
                if k not in self.keys:
                    at.fail(f"unexpected field '{_short(k)}' (the record is closed)", k)
        return out

    def encode(self, x: object, at: _At) -> Value:
        at.step()
        return Record(self.encode_fields(x, at))

    def encode_fields(self, x: object, at: _At) -> dict[str, Value]:
        given = _mapping(x, at, "a mapping of fields")
        at.container()
        at.enter(x)
        out: dict[str, Value] = {}
        for f in self.fields:
            if f.key in given:
                out[f.key] = f.node.encode(given[f.key], at.child(f.key))
            elif not f.optional:
                at.fail(f"missing field '{f.key}'")
        if self.closed:
            for k in given:
                if k not in self.keys:
                    at.fail("unexpected field (the record is closed)", k)
        at.leave(x)
        return out


_CasePayload = _Record | tuple[_Node, ...] | None


class _Variant(_Node):
    """`< … >`: a listed case is a `Tagged`; another tag is an `Unknown` in an open variant."""

    __slots__ = ("cases", "open", "tags")

    def __init__(self, cases: dict[str, _CasePayload], open: bool) -> None:
        self.tags = _tag_list(cases)
        super().__init__(f"< {self.tags}{' | _' if open and cases else ''} >")
        # Dispatch is one lookup on the tag: never "try each case" (spec §9.8).
        self.cases = cases
        self.open = open

    def decode(self, v: Value, at: _At) -> object:
        at.step()
        if not isinstance(v, Variant):
            _mismatch("a variant" if not self.cases else self.expected, v, at)
        tag, args = v.tag, v.args
        if tag not in self.cases:
            if self.open:
                return Unknown(v)
            at.fail(f"unknown tag '{_short(tag)}', expected one of {self.tags}")
        payload = self.cases[tag]
        if payload is None:
            if args:
                at.fail(f"'{tag}' takes no payload, found {len(args)} argument(s)")
            return Tagged(tag)
        if isinstance(payload, _Record):
            if len(args) != 1:
                at.fail(f"'{tag}' takes a record payload, found {len(args)} argument(s)")
            if not isinstance(args[0], Record):
                _mismatch(f"{tag} {{ … }}", args[0], at.child(0))
            return Tagged(tag, payload.decode_fields(args[0].fields, at))
        if len(args) != len(payload):
            at.fail(f"'{tag}' takes {len(payload)} argument(s), found {len(args)}")
        out: list[object] = []
        for i, node in enumerate(payload):
            out.append(node.decode(args[i], at.child(i)))
        return Tagged(tag, tuple(out))

    def encode(self, x: object, at: _At) -> Value:
        at.step()
        match x:
            case Unknown(raw):
                if not self.open:
                    at.fail(f"an unknown value, but the variant is closed (one of {self.tags})")
                raw_value = cast("object", raw)  # an Unknown built in code may hold anything
                if not isinstance(raw_value, Variant):
                    _invalid("a Variant in the Unknown", raw_value, at)
                if raw_value.tag in self.cases:
                    at.fail(f"an Unknown with the listed tag '{_short(raw_value.tag)}': write it as Tagged")
                return checked_value(raw_value, at)
            case Tagged(tag, payload):
                pass
            case _:
                _invalid("a Tagged" + (" or an Unknown" if self.open else ""), x, at)
        given: object = payload
        if tag not in self.cases:
            _invalid(f"one of {self.tags}", tag, at)
        case = self.cases[tag]
        if case is None:
            if given != ():
                _invalid(f"no payload for {tag}", given, at)
            return Variant(tag)
        if isinstance(case, _Record):
            return Variant(tag, (Record(case.encode_fields(given, at)),))
        args = _sequence(given, at, f"a tuple of {len(case)} argument(s) for {tag}")
        if len(args) != len(case):
            _invalid(f"a tuple of {len(case)} argument(s) for {tag}", given, at)
        at.container()
        at.enter(given)
        out: list[Value] = []
        for i, node in enumerate(case):
            out.append(node.encode(args[i], at.child(i)))
        at.leave(given)
        return Variant(tag, tuple(out))


class _BackRef(_Node):
    """A back edge of a recursive type (guarded: the checker made sure), set once its type is built."""

    __slots__ = ("target",)

    def __init__(self, name: str) -> None:
        super().__init__(name)
        self.target: _Node | None = None

    def decode(self, v: Value, at: _At) -> object:
        assert self.target is not None
        return self.target.decode(v, at)

    def encode(self, x: object, at: _At) -> Value:
        assert self.target is not None
        return self.target.encode(x, at)


class _Coded(_Node):
    """A codec around a named type's own node (spec §13.4): after it when decoding, before it when encoding."""

    __slots__ = ("codec", "id", "inner")

    def __init__(self, inner: _Node, codec: Codec, id: str) -> None:
        super().__init__(inner.expected)
        self.inner = inner
        self.codec = codec
        self.id = id

    def decode(self, v: Value, at: _At) -> object:
        x = self.inner.decode(v, at)
        try:
            return self.codec.decode(x)
        except (ValueError, TypeError, OverflowError) as e:
            reason = _short(str(e), 100)
        at.fail(f"the codec for {self.id} rejects it: {reason}")

    def encode(self, x: object, at: _At) -> Value:
        at.step()
        try:
            y = self.codec.encode(x)
        except (ValueError, TypeError, OverflowError) as e:
            reason = _short(str(e), 100)
        else:
            return self.inner.encode(y, at)
        at.fail(f"the codec for {self.id} can't encode it: {reason}")


# ── building nodes from resolved types ───────────────────────


def _integer(name: str, bits: int, *, signed: bool) -> _Int:
    return _Int(name, -(2 ** (bits - 1)), 2 ** (bits - 1) - 1) if signed else _Int(name, 0, 2**bits - 1)


_BUILTINS: Final[Mapping[str, _Node]] = {
    "String": _String("String"),
    "Bytes": _Bytes("Bytes"),
    "Bool": _Bool("Bool"),
    "Decimal": _Decimal("Decimal"),
    "Int": _Int("Int"),
    "Int8": _integer("Int8", 8, signed=True),
    "Int16": _integer("Int16", 16, signed=True),
    "Int32": _integer("Int32", 32, signed=True),
    "Int64": _integer("Int64", 64, signed=True),
    "UInt8": _integer("UInt8", 8, signed=False),
    "UInt16": _integer("UInt16", 16, signed=False),
    "UInt32": _integer("UInt32", 32, signed=False),
    "UInt64": _integer("UInt64", 64, signed=False),
    "Float32": _Float("Float32"),
    "Float64": _Float("Float64"),
    "Any": _Any("Any"),
}


class Builder:
    """Builds the nodes of resolved types, once per instance; recursion becomes back references."""

    def __init__(self, codecs: Mapping[str, Codec]) -> None:
        self.codecs = codecs
        self.built: dict[_Instance, _Node] = {}
        self.building: set[_Instance] = set()
        self.back: dict[_Instance, list[_BackRef]] = {}
        self.used: set[str] = set()
        """The ids of the codecs applied."""

    def coded(self, node: _Node, id: str) -> _Node:
        if (codec := self.codecs.get(id)) is None:
            return node
        self.used.add(id)
        return _Coded(node, codec, id)

    def ref(self, inst: _Instance) -> _Node:
        if (done := self.built.get(inst)) is not None:
            return done
        if inst in self.building:
            back = _BackRef(inst.key)
            self.back.setdefault(inst, []).append(back)
            return back
        self.building.add(inst)
        node = self.build(inst.body)
        if not inst.args:
            node = self.coded(node, inst.definition.id)
        self.building.discard(inst)
        self.built[inst] = node
        for back in self.back.pop(inst, []):
            back.target = node
        return node

    def build(self, t: Type) -> _Node:
        match t:
            case BuiltinType(name):
                return self.coded(_BUILTINS[name], f"prelude#{name}")
            case StdType(name):
                return self.coded(_StdTime(name), f"std/time#{name}")
            case ArrayType(item):
                return _Array(self.build(item))
            case MapType(value):
                return _Map(self.build(value))
            case MaybeType(item):
                return _Maybe(self.build(item))
            case SecretType(item):
                return _Secret(self.build(item))
            case RecordType():
                return self.record(t)
            case VariantType(cases, open_):
                payloads: dict[str, _CasePayload] = {}
                for c in cases:
                    match c.payload:
                        case NoPayload():
                            payloads[c.tag] = None
                        case RecordPayload(record):
                            payloads[c.tag] = self.record(record)
                        case PositionalPayload(items):
                            payloads[c.tag] = tuple(self.build(x) for x in items)
                return _Variant(payloads, open_)
            case RefType(inst):
                return self.ref(inst)
            case ParamType(name):
                raise ValueError(f"type parameter {name} in a concrete type")

    def record(self, t: RecordType) -> _Record:
        return _Record(tuple(_Field(f.key, self.build(f.type), f.optional) for f in t.fields), t.closed)


# ── entry points ─────────────────────────────────────────────


def _count_values(root: Value, max_depth: int, at: _At) -> int:
    """The values in a tree, failing beyond `max_depth` (a Value built in code may be deeper than parsed ones)."""
    count = 0
    stack: list[tuple[Value, int]] = [(root, 0)]
    while stack:
        v, depth = stack.pop()
        count += 1
        if count > _MAX_VALUES:
            at.fail(f"value has more than {_MAX_VALUES} nodes")
        if depth > max_depth:
            at.fail(f"value nested deeper than {max_depth} levels")
        match v:
            case Array(items):
                stack += ((x, depth + 1) for x in items)
            case Record(fields):
                stack += ((x, depth + 1) for x in fields.values())
            case Variant(_, (Record() as record,)):
                stack.append((record, depth))  # `Tag { … }` is one level, as in the parser
            case Variant(_, args):
                stack += ((x, depth + 1) for x in args)
            case _:
                pass
    return count


def _too_deep(at: _At) -> Never:
    at.fail("nesting too deep for Python's recursion limit; lower max_depth or raise sys.setrecursionlimit")


def decode(node: _Node, value: Value, limits: Limits, max_steps: int | None, key: PathKey | None = None) -> object:
    probe = _At(_Context(decoding=True, limits=limits, max_steps=_MAX_VALUES), None, key, 0)
    steps = (
        max_steps if max_steps is not None else STEPS_PER_VALUE * _count_values(value, limits.max_depth, probe) + 1024
    )
    at = _At(_Context(decoding=True, limits=limits, max_steps=steps), None, key, 0)
    try:
        return node.decode(value, at)
    except RecursionError:
        pass
    _too_deep(at)


def encode(node: _Node, x: object, limits: Limits, max_steps: int | None, key: PathKey | None = None) -> Value:
    steps = DEFAULT_ENCODE_STEPS if max_steps is None else max_steps
    at = _At(_Context(decoding=False, limits=limits, max_steps=steps), None, key, 0)
    try:
        return node.encode(x, at)
    except RecursionError:
        pass
    _too_deep(at)
