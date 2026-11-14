"""Schema files (`.schema.haus`, spec §14): parse, resolve and check them.

    import std/time (Instant)            built in (spec §13.2)
    import @haus/money (Money)           a schema package, found by a ModuleResolver
    import ./common (Address)            a schema file next to this one
    type Comment = < Comment { author: String, at: Instant, replies: Array Comment } >

The result is a set of resolved types (`Type`) that `haus.schema` turns into
decoders. The checker enforces what keeps decoding linear (spec §9.9, §9.10):
recursion passes through a record field, array element or variant payload,
and a generic type refers to itself only with its own parameters.

A port of typescript/packages/haus/src/schema-file.ts. Errors are
`HausSchemaFileError`, with the position in the schema file.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal, Never, Protocol, TypeAlias, TypeVar

from ._errors import HausSyntaxError
from ._parser import Parser
from ._time import STD_TIME_TYPES
from ._value import String, Value

_T = TypeVar("_T")


class HausSchemaFileError(HausSyntaxError):
    """A schema file that can't be used (spec §14): a syntax error, or a rule it breaks."""


# ── resolved types ───────────────────────────────────────────

BUILTINS: tuple[str, ...] = (
    "String", "Bytes", "Bool", "Decimal", "Int",
    "Int8", "Int16", "Int32", "Int64", "UInt8", "UInt16", "UInt32", "UInt64",
    "Float32", "Float64", "Any",
)  # fmt: skip
"""The prelude's types without parameters."""

STD_MODULES: Mapping[str, tuple[str, ...]] = {"std/time": STD_TIME_TYPES}
"""The standard modules and their types (spec §13.2)."""

ATTRIBUTES: tuple[str, ...] = ("deprecated",)
"""The attributes this version defines (spec §14). Others are accepted, without meaning, with a warning."""

_MOVED_MODULES = {"std/money": "@haus/money"}
_PRELUDE_GENERIC = {"Array": 1, "Map": 1, "Maybe": 1, "Result": 2, "Secret": 1, "Stream": 1}
_MAX_NESTING = 128
_MAX_INSTANCES = 10_000
_MAX_FILES = 256


@dataclass(frozen=True, slots=True)
class Attribute:
    """`@deprecated("use email")` before a type, field or tag: metadata for tools, never for decoding."""

    name: str
    args: tuple[Value, ...] = ()


@dataclass(frozen=True, slots=True)
class BuiltinType:
    """A prelude type without parameters: `String`, `Int8`, `Any`, …"""

    name: str


@dataclass(frozen=True, slots=True)
class StdType:
    """A type of a standard module: `Date`, `Instant`, …"""

    name: str


@dataclass(frozen=True, slots=True)
class ArrayType:
    item: Type


@dataclass(frozen=True, slots=True)
class MapType:
    value: Type


@dataclass(frozen=True, slots=True)
class MaybeType:
    item: Type


@dataclass(frozen=True, slots=True)
class SecretType:
    """`Secret a`: the same data as `a`, hidden on the host side (spec §15)."""

    item: Type


@dataclass(frozen=True, slots=True)
class Field:
    key: str
    optional: bool
    type: Type
    attributes: tuple[Attribute, ...] = ()
    """Its attributes (a spread copies them with the field). Never read when decoding."""


@dataclass(frozen=True, slots=True)
class RecordType:
    fields: tuple[Field, ...]
    closed: bool
    """`closed { … }`: other fields are an error. Otherwise they are ignored."""


@dataclass(frozen=True, slots=True)
class NoPayload:
    """A case without payload: `Empty`."""


@dataclass(frozen=True, slots=True)
class RecordPayload:
    """`Circle { r: Float64 }`."""

    record: RecordType


@dataclass(frozen=True, slots=True)
class PositionalPayload:
    """`Point Float64 Float64`."""

    items: tuple[Type, ...]


Payload: TypeAlias = NoPayload | RecordPayload | PositionalPayload


@dataclass(frozen=True, slots=True)
class Case:
    tag: str
    payload: Payload
    attributes: tuple[Attribute, ...] = ()
    """Its attributes (a spread copies them with the case). Never read when decoding."""


@dataclass(frozen=True, slots=True)
class VariantType:
    cases: tuple[Case, ...]
    open: bool
    """Not `closed`: other tags decode to unknown values."""


@dataclass(frozen=True, slots=True, eq=False)
class RefType:
    """A named type: how recursion is represented. Equal only to itself."""

    instance: Instance


@dataclass(frozen=True, slots=True)
class ParamType:
    """A type parameter, only in the template of a generic type."""

    name: str


Type: TypeAlias = (
    BuiltinType
    | StdType
    | ArrayType
    | MapType
    | MaybeType
    | SecretType
    | RecordType
    | VariantType
    | RefType
    | ParamType
)


@dataclass(frozen=True, slots=True)
class Definition:
    """A type definition of a schema file."""

    name: str
    id: str
    """The type's identity, the same in every language: `@haus/money@1#Money`, `<file id>#Name`, or the name."""
    module: str | None
    """The identity of the file that defines it; None for the root file when it has no id."""
    params: tuple[str, ...]
    doc: str
    """The `//` comment lines just above the definition."""
    source: str
    """The definition's source text, with its comment and attributes."""
    attributes: tuple[Attribute, ...]
    offset: int


class Instance:
    """A named type applied to its arguments: `Comment`, `List Int`. References point here."""

    __slots__ = ("args", "body", "definition", "key", "state", "stream")

    def __init__(self, definition: Definition, args: tuple[Type, ...], key: str) -> None:
        self.definition = definition
        self.args = args
        self.key = key
        self.body: Type = VariantType((), open=False)
        self.stream = False
        """`type Events = Stream Event`: a file of `body` values."""
        self.state: Literal["new", "evaluating", "done"] = "new"

    @property
    def name(self) -> str:
        return self.definition.name

    def __repr__(self) -> str:
        return f"Instance({self.key})"


WarningKind: TypeAlias = Literal["unknown-attribute", "deprecated"]


@dataclass(frozen=True, slots=True)
class SchemaWarning:
    """Something a tool should point out without failing (spec §14)."""

    kind: WarningKind
    """`unknown-attribute`: `@since(…)` and the like; `deprecated`: a use of a `@deprecated` type."""
    message: str
    offset: int
    """Code point offsets into the schema file, `end` exclusive."""
    end: int
    line: int
    column: int


@dataclass(frozen=True, slots=True)
class SchemaFile:
    """A checked schema file."""

    definitions: tuple[Definition, ...]
    """The file's own definitions, in source order."""
    imports: Mapping[str, str]
    """Types imported from standard modules, by name."""
    imported: Mapping[str, Definition]
    """Types imported from other files and packages, by the name they have here."""
    id: str | None
    warnings: tuple[SchemaWarning, ...]
    """Attributes this version doesn't define, and uses of deprecated types, in this file only."""
    instances: Mapping[str, Instance]
    """The template instance of each definition (own and imported), by name here."""

    def definition(self, name: str) -> Definition | None:
        """The definition named `name` here, own or imported."""
        return next((d for d in self.definitions if d.name == name), None) or self.imported.get(name)

    def instance(self, name: str) -> Instance | None:
        """The instance of a definition without parameters, to decode with."""
        inst = self.instances.get(name)
        return inst if inst is not None and not inst.definition.params else None


def deprecation(attributes: Sequence[Attribute]) -> str | None:
    """The message of `@deprecated` among `attributes` ("" without one), or None when it isn't there."""
    for a in attributes:
        if a.name == "deprecated":
            match a.args:
                case (String(why),):
                    return why
                case _:
                    return ""
    return None


def deprecation_note(name: str, attributes: Sequence[Attribute]) -> str | None:
    why = deprecation(attributes)
    return None if why is None else f"{name} is deprecated" + (f": {why}" if why else "")


# ── imports ──────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ResolvedModule:
    """A schema file found for an import."""

    key: str
    """Unique for each file (e.g. its absolute path); passed back as `from_key` for its own imports."""
    id: str
    """The file's identity: `@haus/money@1` for a package's schema, `<package>/<path>` for other files."""
    text: str
    version: str | None = None
    """The package version (semver), checked against an `@major` in the import."""


class ModuleResolver(Protocol):
    """Finds the schema files imports name, when the schema is built (never while data is parsed, §9.2)."""

    def resolve(self, module: str, from_key: str | None) -> ResolvedModule:
        """`module` as written without `@major` (`@haus/money`, `./common`), imported by `from_key`.

        Raise an exception with a readable message when it can't be found.
        """
        ...


# ── lexer ────────────────────────────────────────────────────

Fail: TypeAlias = Callable[[str, int], Never]
TokenKind: TypeAlias = Literal["upper", "lower", "string", "module", "attribute", "punct", "eof"]


@dataclass(frozen=True, slots=True)
class _Token:
    kind: TokenKind
    value: str
    pos: int


_PUNCT = ("...", "{", "}", "<", ">", "(", ")", "|", ":", "?", ",", "=", "/")
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_MODULE = re.compile(r"@[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:@[0-9]+)?|\.\.?/[A-Za-z0-9_./-]*")
_ATTRIBUTE = re.compile(r"@([a-z_][A-Za-z0-9_]*)")
_SPACE = re.compile(r"[ \t\r\n]*")
_PARAM = re.compile(r"[a-z][A-Za-z0-9_]*")


class _Lexer:
    __slots__ = ("fail", "pos", "text")

    def __init__(self, text: str, fail: Fail) -> None:
        self.text = text
        self.fail = fail
        self.pos = 1 if text.startswith("\ufeff") else 0

    def skip(self) -> None:
        """Skip whitespace and comments (block comments nest)."""
        s = self.text
        while True:
            m = _SPACE.match(s, self.pos)
            assert m is not None
            self.pos = m.end()
            if s.startswith("//", self.pos):
                end = s.find("\n", self.pos)
                self.pos = len(s) if end < 0 else end
            elif s.startswith("/*", self.pos):
                start, depth = self.pos, 0
                while True:
                    if self.pos >= len(s):
                        self.fail("unterminated block comment", start)
                    if s.startswith("/*", self.pos):
                        depth, self.pos = depth + 1, self.pos + 2
                    elif s.startswith("*/", self.pos):
                        depth, self.pos = depth - 1, self.pos + 2
                    else:
                        self.pos += 1
                    if depth == 0:
                        break
            else:
                return

    def next(self) -> _Token:
        self.skip()
        s, pos = self.text, self.pos
        if pos >= len(s):
            return _Token("eof", "", pos)
        if m := _IDENT.match(s, pos):
            self.pos = m.end()
            return _Token("upper" if m[0][0].isupper() else "lower", m[0], pos)
        if (s[pos] == "@" or s.startswith(("./", "../"), pos)) and (m := _MODULE.match(s, pos)):
            self.pos = m.end()
            return _Token("module", m[0], pos)
        if s[pos] == "@":
            if not (m := _ATTRIBUTE.match(s, pos)):
                self.fail("expected an attribute name after '@', like @deprecated", pos)
            self.pos = m.end()
            return _Token("attribute", m[1], pos)
        if s[pos] == '"':
            if s.startswith('"""', pos):
                self.fail("block strings can't be field names", pos)
            try:
                value, self.pos = Parser(s).value_at(pos)
            except HausSyntaxError as e:
                self.fail(e.reason, e.offset)
            assert isinstance(value, String)
            return _Token("string", value.value, pos)
        for p in _PUNCT:
            if s.startswith(p, pos):
                self.pos = pos + len(p)
                return _Token("punct", p, pos)
        self.fail(f"unexpected character {json.dumps(s[pos], ensure_ascii=False)}", pos)


# ── syntax tree ──────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class _Name:
    name: str
    pos: int


@dataclass(frozen=True, slots=True)
class _Var:
    name: str
    pos: int


@dataclass(frozen=True, slots=True)
class _App:
    head: str
    args: tuple[_Node, ...]
    pos: int


@dataclass(frozen=True, slots=True)
class _Spread:
    """`...Name`. `at` is how many own fields or cases come before it, to keep the written order."""

    name: str
    at: int
    pos: int


@dataclass(frozen=True, slots=True)
class _AttributeNode:
    attribute: Attribute
    pos: int
    end: int


@dataclass(frozen=True, slots=True)
class _RawWarning:
    kind: WarningKind
    message: str
    pos: int
    end: int


@dataclass(frozen=True, slots=True)
class _FieldNode:
    key: str
    optional: bool
    type: _Node
    pos: int
    attributes: tuple[Attribute, ...]


@dataclass(frozen=True, slots=True)
class _RecordNode:
    fields: tuple[_FieldNode, ...]
    spreads: tuple[_Spread, ...]
    closed: bool
    pos: int


@dataclass(frozen=True, slots=True)
class _CaseNode:
    tag: str
    args: tuple[_Node, ...]
    pos: int
    attributes: tuple[Attribute, ...]


@dataclass(frozen=True, slots=True)
class _VariantNode:
    cases: tuple[_CaseNode, ...]
    spreads: tuple[_Spread, ...]
    closed: bool
    pos: int


_Node: TypeAlias = _Name | _Var | _App | _RecordNode | _VariantNode


@dataclass(frozen=True, slots=True)
class _TypeDecl:
    name: str
    params: tuple[tuple[str, int], ...]
    body: _Node
    pos: int
    end: int
    doc_start: int
    doc: str
    attributes: tuple[Attribute, ...]


@dataclass(frozen=True, slots=True)
class _ImportDecl:
    module: str
    names: tuple[tuple[str, int], ...]
    pos: int


_KEYWORDS = frozenset({"type", "import", "closed"})


class _SchemaParser:
    """Recursive descent over the tokens, following spec/grammar.ebnf."""

    def __init__(self, text: str, fail: Fail) -> None:
        self.text = text
        self.fail = fail
        self.lexer = _Lexer(text, fail)
        self.tok = self.lexer.next()
        self.depth = 0
        self.last_end = 0
        self.attributes: list[_AttributeNode] = []
        """Every attribute, in source order."""
        self.warnings: list[_RawWarning] = []

    def advance(self) -> _Token:
        t = self.tok
        self.last_end = self.lexer.pos
        self.tok = self.lexer.next()
        return t

    def kind(self) -> TokenKind:
        """The current token's kind (a method, so that checks don't narrow it across `advance()`)."""
        return self.tok.kind

    def is_(self, value: str) -> bool:
        return self.kind() == "punct" and self.tok.value == value

    def expect(self, value: str) -> _Token:
        if not self.is_(value):
            self.unexpected(f"'{value}'")
        return self.advance()

    def unexpected(self, what: str) -> Never:
        found = "end of file" if self.kind() == "eof" else f"'{self.tok.value}'"
        self.fail(f"expected {what}, found {found}", self.tok.pos)

    def keyword(self) -> str | None:
        t = self.tok
        return t.value if t.kind == "lower" and t.value in _KEYWORDS else None

    def parse_file(self) -> tuple[list[_ImportDecl], list[_TypeDecl]]:
        imports: list[_ImportDecl] = []
        types: list[_TypeDecl] = []
        while self.kind() != "eof":
            attributes = self.parse_attributes()
            kw = self.keyword()
            if kw == "type":
                types.append(self.parse_type(attributes))
            elif attributes:
                self.unexpected("a type definition after the attribute (attributes go before a type, a field or a tag)")
            elif kw == "import":
                imports.append(self.parse_import())
            else:
                self.unexpected("'type' or 'import'")
        return imports, types

    # ── attributes ──

    def parse_attributes(self) -> list[_AttributeNode]:
        out: list[_AttributeNode] = []
        while self.kind() == "attribute":
            a = self.parse_attribute()
            self.check_attribute(a, out)
            out.append(a)
            self.attributes.append(a)
        return out

    def parse_attribute(self) -> _AttributeNode:
        t = self.advance()
        name_end = t.pos + 1 + len(t.value)
        args: tuple[Value, ...] = ()
        if self.is_("("):
            if self.tok.pos != name_end:
                self.fail(f"no space is allowed between @{t.value} and '('", name_end)
            args = self.parse_attribute_args(self.tok.pos)
        return _AttributeNode(Attribute(t.value, args), t.pos, self.last_end)

    def check_attribute(self, a: _AttributeNode, before: Sequence[_AttributeNode]) -> None:
        """Spec §14: a defined attribute takes its arguments, once; others are accepted with a warning."""
        name = a.attribute.name
        if name not in ATTRIBUTES:
            known = ", ".join(f"@{n}" for n in ATTRIBUTES)
            message = f"unknown attribute @{name}: this version of haus gives it no meaning (it knows {known})"
            self.warnings.append(_RawWarning("unknown-attribute", message, a.pos, a.end))
            return
        if any(b.attribute.name == name for b in before):
            self.fail(f"@{name} appears twice here", a.pos)
        match a.attribute.args:
            case () | (String(),):
                pass
            case _:
                self.fail('@deprecated takes no argument or one string: @deprecated or @deprecated("use email")', a.pos)

    def parse_attribute_args(self, open_: int) -> tuple[Value, ...]:
        """`( value, … )` at `open_`: haus values, read by the data parser."""
        values: list[Value] = []
        lexer, text = self.lexer, self.text
        data = Parser(text)
        lexer.pos = open_ + 1
        while True:
            lexer.skip()
            c = text[lexer.pos : lexer.pos + 1]
            if c == ")":
                if not values:
                    self.fail("an attribute's ( … ) needs at least one value; write it without parentheses", open_)
                break
            if c == "":
                self.fail("unclosed '(' of an attribute", open_)
            try:
                value, lexer.pos = data.value_at(lexer.pos)
            except HausSyntaxError as e:
                self.fail(e.reason, e.offset)
            values.append(value)
            lexer.skip()
            if text.startswith(",", lexer.pos):
                lexer.pos += 1
            elif not text.startswith(")", lexer.pos):
                self.fail("expected ',' or ')' in the attribute's arguments", lexer.pos)
        lexer.pos += 1
        self.last_end = lexer.pos
        self.tok = lexer.next()
        return tuple(values)

    # ── imports and definitions ──

    def parse_import(self) -> _ImportDecl:
        pos = self.advance().pos
        if self.kind() == "module":
            module = self.advance().value
        else:
            parts: list[str] = []
            while True:
                if self.kind() != "lower":
                    self.unexpected("a module like std/time, @org/name or ./file")
                parts.append(self.advance().value)
                if not self.is_("/"):
                    break
                self.advance()
            module = "/".join(parts)
        self.expect("(")
        names: list[tuple[str, int]] = []
        while True:
            if self.kind() != "upper":
                self.unexpected("a type name")
            t = self.advance()
            names.append((t.value, t.pos))
            if self.is_(")"):
                break
            self.expect(",")
            if self.is_(")"):
                break
        self.advance()
        return _ImportDecl(module, tuple(names), pos)

    def parse_type(self, attributes: Sequence[_AttributeNode]) -> _TypeDecl:
        pos = self.advance().pos
        if self.kind() != "upper":
            self.unexpected("a type name (starting with a capital letter)")
        name = self.advance().value
        params: list[tuple[str, int]] = []
        while self.kind() == "lower" and not self.keyword():
            t = self.advance()
            params.append((t.value, t.pos))
        self.expect("=")
        body = self.parse_app()
        doc_start, doc = _doc_comment(self.text, attributes[0].pos if attributes else pos)
        attrs = tuple(a.attribute for a in attributes)
        return _TypeDecl(name, tuple(params), body, pos, self.last_end, doc_start, doc, attrs)

    # ── types ──

    def _nested(self, pos: int) -> None:
        self.depth += 1
        if self.depth > _MAX_NESTING:
            self.fail(f"types nested deeper than {_MAX_NESTING} levels", pos)

    def parse_app(self) -> _Node:
        """`Name atom*`, or a single atom."""
        if self.kind() == "upper":
            head = self.advance()
            args: list[_Node] = []
            while self.starts_atom():
                args.append(self.parse_atom())
            return _App(head.value, tuple(args), head.pos) if args else _Name(head.value, head.pos)
        return self.parse_atom()

    def starts_atom(self) -> bool:
        t = self.tok
        match t.kind:
            case "upper":
                return True
            case "lower":
                return self.keyword() is None or t.value == "closed"
            case "punct":
                return t.value in ("(", "{", "<")
            case _:
                return False

    def parse_atom(self) -> _Node:
        t = self.tok
        if t.kind == "upper":
            self.advance()
            return _Name(t.value, t.pos)
        if t.kind == "lower" and t.value == "closed":
            self.advance()
            if self.is_("{"):
                return self.inner(t.pos, lambda: self.parse_record(closed=True))
            if self.is_("<"):
                return self.inner(t.pos, lambda: self.parse_variant(closed=True))
            self.unexpected("a record { … } or a variant < … > after 'closed'")
        if t.kind == "lower" and not self.keyword():
            if t.value == "_":
                self.fail(
                    "types are open by default, so there is no _: write < > for any tag, or a type parameter", t.pos
                )
            self.advance()
            return _Var(t.value, t.pos)
        if self.is_("("):
            self.advance()
            node = self.inner(t.pos, self.parse_app)
            self.expect(")")
            return node
        if self.is_("{"):
            return self.inner(t.pos, lambda: self.parse_record(closed=False))
        if self.is_("<"):
            return self.inner(t.pos, lambda: self.parse_variant(closed=False))
        self.unexpected("a type")

    def inner(self, pos: int, f: Callable[[], _Node]) -> _Node:
        """`f()` one nesting level deeper."""
        self._nested(pos)
        try:
            return f()
        finally:
            self.depth -= 1

    def parse_spread(self, at: int) -> _Spread:
        t = self.tok
        if t.kind == "lower" and not self.keyword():
            self.fail(
                f"row parameters (...{t.value}) aren't supported; spread a named type instead: ...UserEvent", t.pos
            )
        if t.kind != "upper":
            self.unexpected("a type name after '...': ...UserEvent")
        self.advance()
        return _Spread(t.value, at, t.pos)

    def parse_record(self, *, closed: bool) -> _RecordNode:
        pos = self.advance().pos
        if self.is_("|"):
            self.fail("{| … |} is gone: write closed { … } for a closed record", self.tok.pos)
        fields: list[_FieldNode] = []
        spreads: list[_Spread] = []
        while not self.is_("}"):
            attributes = self.parse_attributes()
            if self.is_("..."):
                if attributes:
                    self.fail(
                        "attributes can't be put on a spread: the fields it copies keep their own", attributes[0].pos
                    )
                self.advance()
                spreads.append(self.parse_spread(len(fields)))
            else:
                k = self.tok
                if k.kind not in ("lower", "string"):
                    self.unexpected(
                        "a field name after the attribute" if attributes else "a field name, ...Name or '}'"
                    )
                self.advance()
                optional = self.is_("?")
                if optional:
                    self.advance()
                self.expect(":")
                type_ = self.parse_app()
                attrs = tuple(a.attribute for a in attributes)
                fields.append(_FieldNode(k.value, optional, type_, k.pos, attrs))
            if self.is_(","):
                self.advance()
            elif not self.is_("}"):
                self.unexpected("',' or '}'")
        self.expect("}")
        return _RecordNode(tuple(fields), tuple(spreads), closed, pos)

    def parse_variant(self, *, closed: bool) -> _VariantNode:
        pos = self.advance().pos
        cases: list[_CaseNode] = []
        spreads: list[_Spread] = []
        if self.is_("|"):
            self.advance()
        while not self.is_(">"):
            attributes = self.parse_attributes()
            if self.kind() == "upper":
                tag = self.advance()
                args: list[_Node] = []
                while self.starts_atom():
                    args.append(self.parse_atom())
                attrs = tuple(a.attribute for a in attributes)
                cases.append(_CaseNode(tag.value, tuple(args), tag.pos, attrs))
            elif self.is_("..."):
                if attributes:
                    self.fail(
                        "attributes can't be put on a spread: the tags it copies keep their own", attributes[0].pos
                    )
                self.advance()
                spreads.append(self.parse_spread(len(cases)))
            else:
                self.unexpected("a tag after the attribute" if attributes else "a tag, ...Name or '>'")
            if self.is_(">"):
                break
            self.expect("|")
        self.advance()
        if closed and not cases and not spreads:
            self.fail("a closed variant needs at least one tag (closed < > would accept nothing)", pos)
        return _VariantNode(tuple(cases), tuple(spreads), closed, pos)


def _children(n: _Node) -> tuple[_Node, ...]:
    match n:
        case _App(args=args):
            return args
        case _RecordNode(fields=fields):
            return tuple(f.type for f in fields)
        case _VariantNode(cases=cases):
            return tuple(a for c in cases for a in c.args)
        case _:
            return ()


def _nodes(n: _Node) -> Iterator[_Node]:
    """`n` and every type node inside it, depth first (nesting is limited to _MAX_NESTING)."""
    yield n
    for child in _children(n):
        yield from _nodes(child)


def _names_in(n: _Node) -> Iterator[tuple[str, int]]:
    """The type names `n` refers to, spreads included, with their positions."""
    for x in _nodes(n):
        match x:
            case _Name(name, pos) | _App(name, _, pos):
                yield name, pos
            case _RecordNode(spreads=spreads) | _VariantNode(spreads=spreads):
                yield from ((s.name, s.pos) for s in spreads)
            case _:
                pass


def _doc_comment(text: str, pos: int) -> tuple[int, str]:
    """The `//` lines directly above `pos` (no blank line in between), and where they start."""
    lines: list[str] = []
    start = text.rfind("\n", 0, pos) + 1
    while start > 0:
        prev = text.rfind("\n", 0, start - 1) + 1
        line = text[prev : start - 1].strip()
        if not line.startswith("//"):
            break
        lines.insert(0, re.sub(r"^// ?", "", line))
        start = prev
    return start, "\n".join(lines)


def _fail_in(text: str) -> Fail:
    def fail(reason: str, pos: int) -> Never:
        e = HausSyntaxError.at(text, pos, reason)
        raise HausSchemaFileError(reason, e.offset, e.line, e.column)

    return fail


def without_attributes(text: str) -> str:
    """The schema file with every attribute replaced by spaces (line breaks kept), so positions stay.

    Decoding with the result is the same as with the file (spec §15, "Attributes don't matter").
    Raises `HausSchemaFileError` when the file can't be parsed.
    """
    parser = _SchemaParser(text, _fail_in(text))
    parser.parse_file()
    out: list[str] = []
    at = 0
    for a in parser.attributes:
        out += [text[at : a.pos], re.sub(r"[^\n]", " ", text[a.pos : a.end])]
        at = a.end
    return "".join(out) + text[at:]


# ── resolution and checking ──────────────────────────────────


@dataclass(slots=True, eq=False)
class _Unit:
    """One schema file: the root, or one it imports."""

    root: bool
    id: str | None
    text: str
    fail: Fail
    warnings: list[_RawWarning]
    own: dict[str, _Def] = field(default_factory=dict[str, "_Def"])
    """Its own definitions: what other files can import."""
    scope: dict[str, _Def] = field(default_factory=dict[str, "_Def"])
    """Every named type in scope: its own and imported ones."""
    std: dict[str, str] = field(default_factory=dict[str, str])


@dataclass(slots=True, eq=False)
class _Def:
    decl: _TypeDecl
    unit: _Unit
    definition: Definition | None = None

    @property
    def params(self) -> tuple[str, ...]:
        return tuple(p for p, _ in self.decl.params)


_MAJOR = re.compile(r"v?([0-9]+)")
_WANTED_MAJOR = re.compile(r"@.+@([0-9]+)")
_PACKAGE_OR_FILE = re.compile(r"@[^/]+/|\.\.?/")


def _plural(n: int) -> str:
    return "" if n == 1 else "s"


class _Checker:
    """Loads every file, then evaluates every definition: the rules of spec §13.3 and §14."""

    def __init__(self, resolver: ModuleResolver | None) -> None:
        self.resolver = resolver
        self.units: dict[str, _Unit] = {}
        self.loading: list[str] = []
        self.all_defs: list[_Def] = []
        self.ids: dict[str, str | None] = {}
        """The file that has each id: two files with one id would give their types the same ids."""
        self.instances: dict[str, Instance] = {}
        self.def_of: dict[Instance, _Def] = {}
        self.queue: list[tuple[Instance, _Def]] = []
        self.pending_streams: list[tuple[Instance, int, _Unit]] = []
        self.current: _Unit | None = None

    # ── loading ──

    def load(self, text: str, key: str | None, id: str | None, fail: Fail, *, root: bool) -> _Unit:
        if len(self.units) >= _MAX_FILES:
            fail(f"more than {_MAX_FILES} schema files are imported", 0)
        parser = _SchemaParser(text, fail)
        imports, types = parser.parse_file()
        unit = _Unit(root, id, text, fail, parser.warnings)
        if key is not None:
            self.units[key] = unit
        if id is not None:
            self.ids[id] = key
        self.loading.append(key or "")
        try:
            for imp in imports:
                self.import_into(unit, imp, key)
            for decl in types:
                self.define(unit, decl)
        finally:
            self.loading.pop()
        return unit

    def import_into(self, unit: _Unit, imp: _ImportDecl, key: str | None) -> None:
        fail = unit.fail

        def check_new(name: str, pos: int) -> None:
            if name in unit.std or name in unit.scope:
                fail(f"{name} is imported twice", pos)

        if imp.module.startswith("std/"):
            names = STD_MODULES.get(imp.module)
            if names is None:
                listed = ", ".join(n for n, _ in imp.names)
                moved = _MOVED_MODULES.get(imp.module)
                fail(
                    f"{imp.module} is no longer a standard module; it is the package {moved}: import {moved} ({listed})"
                    if moved
                    else f"unknown standard module {imp.module} (there is {', '.join(STD_MODULES)})",
                    imp.pos,
                )
            for name, pos in imp.names:
                if name not in names:
                    fail(f"{imp.module} has no type {name} (it has {', '.join(names)})", pos)
                check_new(name, pos)
                unit.std[name] = name
            return
        if not _PACKAGE_OR_FILE.match(imp.module):
            fail(f"unknown module {imp.module}: import std/…, a package @org/name or a file ./name", imp.pos)
        dep = self.load_import(imp, key, fail)
        for name, pos in imp.names:
            if (d := dep.own.get(name)) is None:
                has = f" (it has {', '.join(dep.own)})" if dep.own else ""
                fail(f"{imp.module} has no type {name}{has}", pos)
            check_new(name, pos)
            unit.scope[name] = d

    def load_import(self, imp: _ImportDecl, from_key: str | None, fail: Fail) -> _Unit:
        if self.resolver is None:
            fail(f"can't import {imp.module}: no module resolver (only std modules can be imported here)", imp.pos)
        module = re.sub(r"@[0-9]+$", "", imp.module)
        try:
            r = self.resolver.resolve(module, from_key)
        except Exception as e:  # the resolver's own errors, reported at the import
            fail(f"can't import {imp.module}: {e}", imp.pos)
        if (wanted := _WANTED_MAJOR.fullmatch(imp.module)) and r.version is not None:
            found = _MAJOR.match(r.version)
            if found is None or found[1] != wanted[1]:
                fail(f"{imp.module} wants major version {wanted[1]}, but version {r.version} was found", imp.pos)
        if r.key in self.loading:
            fail(f"import cycle: {imp.module} imports this file again", imp.pos)
        if (cached := self.units.get(r.key)) is not None:
            return cached
        if r.id in self.ids and self.ids[r.id] != r.key:
            fail(
                f"{imp.module} is {r.id}, but another file already is: two copies or two packages with the same name"
                f" ({r.key})",
                imp.pos,
            )

        # Errors inside an imported file are reported at the import, with their place in that file.
        def nested(reason: str, pos: int) -> Never:
            at = HausSyntaxError.at(r.text, pos, reason)
            fail(f"{imp.module} ({at.line}:{at.column}): {reason}", imp.pos)

        return self.load(r.text, r.key, r.id, nested, root=False)

    def define(self, unit: _Unit, decl: _TypeDecl) -> None:
        fail = unit.fail
        if decl.name in unit.own:
            fail(f"type {decl.name} is defined twice", decl.pos)
        if decl.name in unit.scope or decl.name in unit.std:
            fail(f"type {decl.name} is already imported", decl.pos)
        if decl.name in BUILTINS or decl.name in _PRELUDE_GENERIC:
            fail(f"{decl.name} is a prelude type and can't be redefined", decl.pos)
        seen: set[str] = set()
        for p, pos in decl.params:
            if p == "_":
                fail("_ can't be a parameter name", pos)
            if not _PARAM.fullmatch(p):
                fail(f"type parameter {p} must start with a lowercase letter", pos)
            if p in seen:
                fail(f"parameter {p} appears twice", pos)
            seen.add(p)
        d = _Def(decl, unit)
        unit.own[decl.name] = d
        unit.scope[decl.name] = d
        self.all_defs.append(d)

    # ── checks on the syntax tree ──

    def check_params(self, d: _Def) -> None:
        fail, params = d.unit.fail, d.params
        for n in _nodes(d.decl.body):
            if isinstance(n, _Var) and n.name not in params:
                fail(f"unknown type parameter {n.name}", n.pos)
        # §9.10: a generic type refers to itself only with its own parameters.
        for n in _nodes(d.decl.body):
            if not isinstance(n, _App) or d.unit.scope.get(n.head) is not d:
                continue
            if len(n.args) != len(params) or any(
                not isinstance(a, _Var) or a.name != p for a, p in zip(n.args, params, strict=False)
            ):
                own = " ".join((d.decl.name, *params))
                fail(
                    f"{d.decl.name} must refer to itself with its own parameters ({own}); "
                    "other arguments could grow without bound",
                    n.pos,
                )

    # ── evaluation ──

    @property
    def unit(self) -> _Unit:
        assert self.current is not None
        return self.current

    def fail(self, reason: str, pos: int) -> Never:
        self.unit.fail(reason, pos)

    def definition_of(self, d: _Def) -> Definition:
        if d.definition is None:
            decl = d.decl
            d.definition = Definition(
                name=decl.name,
                id=decl.name if d.unit.id is None else f"{d.unit.id}#{decl.name}",
                module=d.unit.id,
                params=d.params,
                doc=decl.doc,
                source=d.unit.text[decl.doc_start : decl.end].strip(),
                attributes=decl.attributes,
                offset=decl.pos,
            )
        return d.definition

    def name_key(self, d: _Def) -> str:
        """Types of other files are keyed by their id, so equal names in two files stay apart."""
        return d.decl.name if d.unit.root else self.definition_of(d).id

    def instance(self, d: _Def, args: tuple[Type, ...], pos: int) -> Instance:
        key = self.name_key(d) if not args else f"{self.name_key(d)}({','.join(map(_key_of, args))})"
        if (inst := self.instances.get(key)) is not None:
            return inst
        if len(self.instances) >= _MAX_INSTANCES:
            self.fail(f"more than {_MAX_INSTANCES} type instances: a generic type grows without bound", pos)
        inst = Instance(self.definition_of(d), args, key)
        self.instances[key] = inst
        self.def_of[inst] = d
        self.queue.append((inst, d))
        return inst

    def evaluate_instance(self, inst: Instance, d: _Def) -> None:
        saved, self.current = self.current, d.unit
        try:
            if inst.state == "done":
                return
            if inst.state == "evaluating":
                self.fail(f"type {d.decl.name} spreads itself (directly or through another type)", d.decl.pos)
            inst.state = "evaluating"
            env = dict(zip(d.params, inst.args, strict=True))
            match d.decl.body:
                case _App("Stream", (item,)):
                    inst.stream = True
                    inst.body = self.evaluate(item, env)
                case _App("Stream", _, pos) | _Name("Stream", pos):
                    self.fail("Stream needs 1 argument", pos)
                case body:
                    inst.body = self.evaluate(body, env)
            inst.state = "done"
        finally:
            self.current = saved

    def body_of(self, inst: Instance) -> Type:
        self.evaluate_instance(inst, self.def_of[inst])
        return inst.body

    def resolve_ref(self, t: Type, pos: int, *, through_secret: bool = False) -> Type:
        """What a reference stands for; with `through_secret`, also what a Secret holds (it guards nothing, §9.9)."""
        seen: set[Instance] = set()
        while True:
            match t:
                case SecretType(item) if through_secret:
                    t = item
                case RefType(inst):
                    if inst in seen:
                        self.fail(
                            f"type {inst.name} refers to itself without a record, array or variant in between", pos
                        )
                    seen.add(inst)
                    t = self.body_of(inst)
                case _:
                    return t

    def lookup_name(self, name: str, pos: int) -> Type:
        unit = self.unit
        if (d := unit.scope.get(name)) is not None:
            if d.params:
                n = len(d.params)
                self.fail(f"{name} needs {n} argument{_plural(n)} ({' '.join((name, *d.params))})", pos)
            return self.ref_to(self.instance(d, (), pos), pos)
        if name in unit.std:
            return StdType(name)
        if name in BUILTINS:
            return BuiltinType(name)
        if (arity := _PRELUDE_GENERIC.get(name)) is not None:
            self.fail(f"{name} needs {arity} argument{_plural(arity)}", pos)
        module = next((m for m, names in STD_MODULES.items() if name in names), None)
        if name in ("Money", "Currency"):
            module = "@haus/money"
        self.fail(
            f"unknown type {name}; import it with: import {module} ({name})" if module else f"unknown type {name}", pos
        )

    def ref_to(self, inst: Instance, pos: int) -> RefType:
        if inst.state == "done" and inst.stream:
            self.fail(f"{inst.name} is a Stream; a stream can only be the whole file, not part of a type", pos)
        self.pending_streams.append((inst, pos, self.unit))
        return RefType(inst)

    def evaluate(self, n: _Node, env: Mapping[str, Type]) -> Type:
        match n:
            case _Name("Stream", pos):
                self.fail("Stream needs 1 argument", pos)
            case _Name(name, pos):
                return self.lookup_name(name, pos)
            case _Var(name):
                return env[name]
            case _App():
                return self.apply(n, env)
            case _RecordNode():
                return self.evaluate_record(n, env)
            case _VariantNode():
                return self.evaluate_variant(n, env)

    def apply(self, n: _App, env: Mapping[str, Type]) -> Type:
        if (arity := _PRELUDE_GENERIC.get(n.head)) is not None:
            if len(n.args) != arity:
                self.fail(f"{n.head} needs {arity} argument{_plural(arity)}", n.pos)
            args = [self.evaluate(x, env) for x in n.args]
            match n.head:
                case "Array":
                    return ArrayType(args[0])
                case "Map":
                    return MapType(args[0])
                case "Maybe":
                    return MaybeType(args[0])
                case "Secret":
                    return SecretType(args[0])
                case "Result":
                    return VariantType(
                        (Case("Err", PositionalPayload((args[0],))), Case("Ok", PositionalPayload((args[1],)))),
                        open=False,
                    )
                case _:
                    self.fail("Stream can only be the whole type of a definition: type Events = Stream Event", n.pos)
        d = self.unit.scope.get(n.head)
        if d is None:
            if n.head in self.unit.std or n.head in BUILTINS:
                self.fail(f"{n.head} takes no arguments", n.pos)
            return self.lookup_name(n.head, n.pos)
        if len(n.args) != len(d.params):
            own = " ".join((n.head, *d.params))
            self.fail(
                f"{n.head} needs {len(d.params)} argument{_plural(len(d.params))} ({own}), got {len(n.args)}", n.pos
            )
        return self.ref_to(self.instance(d, tuple(self.evaluate(a, env) for a in n.args), n.pos), n.pos)

    def spread_of(self, sp: _Spread, want: Literal["record", "variant"]) -> RecordType | VariantType:
        """The record or variant `...Name` copies from, evaluated now if necessary."""
        d = self.unit.scope.get(sp.name)
        if d is None:
            self.lookup_name(sp.name, sp.pos)  # reports unknown types, with an import hint
            self.fail(f"{sp.name} can't be spread: only a named {want} can", sp.pos)
        if d.params:
            own = " ".join((sp.name, *d.params))
            self.fail(f"{sp.name} has parameters ({own}); only a type without parameters can be spread", sp.pos)
        inst = self.instance(d, (), sp.pos)
        t = self.resolve_ref(RefType(inst), sp.pos)
        if inst.stream:
            self.fail(f"{sp.name} is a Stream and can't be spread", sp.pos)
        match t:
            case RecordType() if want == "record":
                return t
            case VariantType() if want == "variant":
                return t
            case _:
                self.fail(f"{sp.name} is not a {want}, so it can't be spread here", sp.pos)

    def evaluate_record(self, n: _RecordNode, env: Mapping[str, Type]) -> RecordType:
        own = [(Field(f.key, f.optional, self.evaluate(f.type, env), f.attributes), "", f.pos) for f in n.fields]

        def spread(sp: _Spread) -> list[tuple[Field, str, int]]:
            record = self.spread_of(sp, "record")
            assert isinstance(record, RecordType)
            return [(f, f"from ...{sp.name}", sp.pos) for f in record.fields]

        entries = _in_order(own, n.spreads, spread)
        self.once("field", [(f.key, origin, pos) for f, origin, pos in entries])
        # Open or closed is decided here alone, never by what is spread in.
        return RecordType(tuple(f for f, _, _ in entries), closed=n.closed)

    def evaluate_variant(self, n: _VariantNode, env: Mapping[str, Type]) -> VariantType:
        def payload(c: _CaseNode) -> Payload:
            match c.args:
                case ():
                    return NoPayload()
                case (_RecordNode() as record,):
                    return RecordPayload(self.evaluate_record(record, env))
                case args:
                    return PositionalPayload(tuple(self.evaluate(a, env) for a in args))

        own = [(Case(c.tag, payload(c), c.attributes), "", c.pos) for c in n.cases]

        def spread(sp: _Spread) -> list[tuple[Case, str, int]]:
            variant = self.spread_of(sp, "variant")
            assert isinstance(variant, VariantType)
            return [(c, f"from ...{sp.name}", sp.pos) for c in variant.cases]

        entries = _in_order(own, n.spreads, spread)
        self.once("tag", [(c.tag, origin, pos) for c, origin, pos in entries])
        return VariantType(tuple(c for c, _, _ in entries), open=not n.closed)

    def once(self, what: str, entries: Sequence[tuple[str, str, int]]) -> None:
        """Reports a field or tag that appears twice, saying where each one came from."""
        seen: dict[str, str] = {}
        for name, origin, pos in entries:
            if (before := seen.get(name)) is not None:
                where = " and ".join(x for x in (before, origin) if x)
                self.fail(f"{what} {name} appears twice" + (f" ({where})" if where else ""), pos)
            seen[name] = origin

    # ── the whole check ──

    def check(self, text: str, key: str | None, id: str | None) -> SchemaFile:
        root = self.load(text, key, id, _fail_in(text), root=True)
        for d in self.all_defs:
            self.check_params(d)
        # Evaluate every definition of every file (templates for generic ones), so all errors surface.
        templates: dict[_Def, Instance] = {}
        for d in self.all_defs:
            self.current = d.unit
            templates[d] = self.instance(d, tuple(ParamType(p) for p in d.params), d.decl.pos)
            while self.queue:
                inst, owner = self.queue.pop(0)
                self.evaluate_instance(inst, owner)
        for inst, pos, unit in self.pending_streams:
            if inst.stream:
                unit.fail(f"{inst.name} is a Stream; a stream can only be the whole file, not part of a type", pos)
        # §9.9: every cycle passes through a record, array or variant.
        for inst in list(self.instances.values()):
            self.current = self.def_of[inst].unit
            self.resolve_ref(RefType(inst), inst.definition.offset, through_secret=True)
        self.current = None

        definitions = tuple(self.definition_of(d) for d in root.own.values())
        imported = {name: self.definition_of(d) for name, d in root.scope.items() if d.unit is not root}
        instances = {name: templates[d] for name, d in root.scope.items()}
        located = (
            (w, HausSyntaxError.at(text, w.pos, w.message))
            for w in sorted([*root.warnings, *_deprecated_uses(root)], key=lambda w: w.pos)
        )
        warnings = tuple(SchemaWarning(w.kind, w.message, at.offset, w.end, at.line, at.column) for w, at in located)
        return SchemaFile(definitions, dict(root.std), imported, id, warnings, instances)


def _key_of(t: Type) -> str:
    """A key for a type, to share instances of generic types."""
    match t:
        case BuiltinType(name) | StdType(name):
            return name
        case ParamType(name):
            return f"'{name}"
        case ArrayType(item):
            return f"Array({_key_of(item)})"
        case MapType(value):
            return f"Map({_key_of(value)})"
        case MaybeType(item):
            return f"Maybe({_key_of(item)})"
        case SecretType(item):
            return f"Secret({_key_of(item)})"
        case RefType(inst):
            return inst.key
        case RecordType(fields, closed):
            inner = ",".join(f"{json.dumps(f.key)}{'?' if f.optional else ''}:{_key_of(f.type)}" for f in fields)
            return "{" + ("|" if closed else "") + inner + "}"
        case VariantType(cases, open_):
            return "<" + "|".join(c.tag + _payload_key(c.payload) for c in cases) + ("|_" if open_ else "") + ">"


def _payload_key(p: Payload) -> str:
    match p:
        case NoPayload():
            return ""
        case RecordPayload(record):
            return _key_of(record)
        case PositionalPayload(items):
            return "(" + ",".join(map(_key_of, items)) + ")"


def _in_order(own: Sequence[_T], spreads: Sequence[_Spread], spread: Callable[[_Spread], list[_T]]) -> list[_T]:
    """Own entries and spread ones, in the order they are written."""
    out: list[_T] = []
    for i, x in enumerate(own):
        out += (y for sp in spreads if sp.at == i for y in spread(sp))
        out.append(x)
    out += (y for sp in spreads if sp.at == len(own) for y in spread(sp))
    return out


def _deprecated_uses(unit: _Unit) -> list[_RawWarning]:
    """Spec §14: each place in the file's own definitions that names a deprecated type.

    Not inside deprecated definitions (they go together), and once per place.
    """
    out: list[_RawWarning] = []
    for d in unit.own.values():
        if deprecation(d.decl.attributes) is not None:
            continue
        for name, pos in _names_in(d.decl.body):
            used = unit.scope.get(name)
            if used is not None and (message := deprecation_note(name, used.decl.attributes)) is not None:
                out.append(_RawWarning("deprecated", message, pos, pos + len(name)))
    return out


def parse_schema_file(
    text: str, *, resolver: ModuleResolver | None = None, key: str | None = None, id: str | None = None
) -> SchemaFile:
    """Parse and check a schema file and the files it imports (spec §13.3, §14).

    `resolver` finds imported packages and files (without one, only std modules can be
    imported); `key` is the root file's key for it (e.g. its path), and `id` its identity.
    Raises `HausSchemaFileError`.
    """
    return _Checker(resolver).check(text, key, id)
