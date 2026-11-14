"""Schema files and decoding with a schema (spec §14, §15).

    >>> from haus import schema
    >>> s = schema.compile_schema('''
    ...     type User = { id: Int, name: String, nick?: String, note?: Maybe String }
    ... ''')
    >>> user = s["User"].parse('{ id: 1, name: "Ada", note: None }')
    >>> user
    {'id': 1, 'name': 'Ada', 'note': Nothing()}
    >>> s["User"].canonical(user)
    '{id:1,name:"Ada",note:None}'

Host types (the defaults keep the value, spec §13.4):

    String → str               Int, Int8 … UInt64 → int        Float32, Float64 → float
    Bytes → bytes              Bool → bool                     Decimal → str ("19.90", "1.5e3")
    std/time types → str       Array a → tuple                 Map v → dict[str, V]
    { a: T, b?: T } → dict     (a missing optional field is a missing key, never None)
    Maybe a → Some(x) | Nothing()
    variants → Tagged(tag), Tagged(tag, {fields}), Tagged(tag, (args, …)); open ones also Unknown(raw)
    Any → the parsed Value     Secret a → Secret (shows <redacted>; expose())
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import _decode
from ._canonical import canonical as _canonical
from ._codecs import DateCodec, DecimalCodec, InstantCodec
from ._decode import Codec, HausDecodeError, HausEncodeError, format_path
from ._host import Maybe, Nothing, Secret, Some, Tagged, Unknown
from ._parser import DEFAULT_LIMITS, Limits, Parser
from ._resolve import MANIFEST, FileResolver, Manifest, identify, installed_package, read_manifest, read_module
from ._schema_file import (
    ATTRIBUTES,
    BUILTINS,
    STD_MODULES,
    ArrayType,
    Attribute,
    BuiltinType,
    Case,
    Definition,
    Field,
    HausSchemaFileError,
    Instance,
    MapType,
    MaybeType,
    ModuleResolver,
    NoPayload,
    ParamType,
    Payload,
    PositionalPayload,
    RecordPayload,
    RecordType,
    RefType,
    ResolvedModule,
    SchemaFile,
    SchemaWarning,
    SecretType,
    StdType,
    Type,
    VariantType,
    deprecation,
    parse_schema_file,
    without_attributes,
)
from ._stream import DEFAULT_MAX_VALUE_LENGTH, Readable, parse_stream
from ._value import Value

__all__ = [
    "ATTRIBUTES",
    "BUILTINS",
    "MANIFEST",
    "STD_MODULES",
    "ArrayType",
    "Attribute",
    "BuiltinType",
    "Case",
    "Codec",
    "DateCodec",
    "DecimalCodec",
    "Definition",
    "Field",
    "FileResolver",
    "HausDecodeError",
    "HausEncodeError",
    "HausSchemaFileError",
    "Instance",
    "InstantCodec",
    "Manifest",
    "MapType",
    "Maybe",
    "MaybeType",
    "ModuleResolver",
    "NoPayload",
    "Nothing",
    "ParamType",
    "Payload",
    "PositionalPayload",
    "RecordPayload",
    "RecordType",
    "RefType",
    "ResolvedModule",
    "Schema",
    "SchemaFile",
    "SchemaType",
    "SchemaWarning",
    "Secret",
    "SecretType",
    "Some",
    "StdType",
    "Tagged",
    "Type",
    "Unknown",
    "VariantType",
    "compile_schema",
    "deprecation",
    "format_path",
    "from_schema_file",
    "identify",
    "installed_package",
    "load_schema",
    "parse_schema_file",
    "read_manifest",
    "without_attributes",
]


@dataclass(frozen=True, slots=True)
class SchemaType:
    """A named type of a schema, ready to decode and encode with (spec §15).

    Every call has the parser's limits (`limits`, also used for the nesting depth and
    for raw values written again) and a work budget: by default 16 steps per value of
    the input when decoding, 16 Mi steps when encoding (`max_steps`).
    """

    name: str
    id: str
    """The type's identity (spec §13.3): `@haus/money@1#Money`, or its name in a file without an id."""
    stream: bool
    """`type Events = Stream Event`: the type describes a whole file; each value decodes as `Event`."""
    _node: _decode._Node = field(repr=False)  # pyright: ignore[reportPrivateUsage]

    def decode(self, value: Value, *, limits: Limits = DEFAULT_LIMITS, max_steps: int | None = None) -> Any:
        """A parsed value as its Python value. Raises `HausDecodeError` with the place of the failing value."""
        return _decode.decode(self._node, value, limits, max_steps)

    def parse(self, text: str, *, limits: Limits = DEFAULT_LIMITS, max_steps: int | None = None) -> Any:
        """Parse a text holding exactly one value and decode it.

        Raises `HausSyntaxError` for text that isn't haus, `HausDecodeError` for a value the type rejects.
        """
        values = Parser(text, limits).parse_sequence()
        if len(values) != 1:
            raise HausDecodeError(f"expected exactly one value, found {len(values)}", ())
        return self.decode(values[0], limits=limits, max_steps=max_steps)

    def encode(self, value: object, *, limits: Limits = DEFAULT_LIMITS, max_steps: int | None = None) -> Value:
        """A Python value as a haus value of this type. Raises `HausEncodeError`."""
        return _decode.encode(self._node, value, limits, max_steps)

    def canonical(self, value: object, *, limits: Limits = DEFAULT_LIMITS) -> str:
        """Encode, and write the result in canonical form (spec §12): valid haus text, on one line."""
        return _canonical(self.encode(value, limits=limits))

    def decode_all(self, values: Iterable[Value], *, limits: Limits = DEFAULT_LIMITS) -> Iterator[Any]:
        """Decode each value of a stream on its own; errors carry its index first in their path."""
        for i, v in enumerate(values):
            yield _decode.decode(self._node, v, limits, None, i)

    def parse_stream(
        self,
        source: Readable | Iterable[str | bytes],
        *,
        limits: Limits = DEFAULT_LIMITS,
        max_value_length: int = DEFAULT_MAX_VALUE_LENGTH,
        require_terminator: bool = False,
    ) -> Iterator[Any]:
        """Read a stream (spec §6) and decode each value as it arrives (spec §15, `Stream a`)."""
        values = parse_stream(
            source, limits=limits, max_value_length=max_value_length, require_terminator=require_terminator
        )
        return self.decode_all(values, limits=limits)

    def encode_all(self, values: Iterable[object], *, limits: Limits = DEFAULT_LIMITS) -> Iterator[str]:
        """Encode values as stream items, each in canonical form followed by `,\\n`."""
        for i, v in enumerate(values):
            yield _canonical(_decode.encode(self._node, v, limits, None, i)) + ",\n"


@dataclass(frozen=True, slots=True)
class Schema:
    """A checked schema file, with its types ready to decode with: `schema["Order"].parse(text)`."""

    file: SchemaFile
    types: Mapping[str, SchemaType]
    """The types without parameters, own and imported, by name."""

    def __getitem__(self, name: str) -> SchemaType:
        try:
            return self.types[name]
        except KeyError:
            raise KeyError(f"no type {name} without parameters here (there is {', '.join(self.types)})") from None

    def __contains__(self, name: object) -> bool:
        return name in self.types

    @property
    def warnings(self) -> tuple[SchemaWarning, ...]:
        return self.file.warnings


def from_schema_file(file: SchemaFile, *, codecs: Mapping[str, Codec] | None = None) -> Schema:
    """The decoders of a checked schema file. `codecs` choose host types by type id (spec §13.4)."""
    builder = _decode.Builder(codecs or {})
    types: dict[str, SchemaType] = {}
    for name in file.instances:
        if (inst := file.instance(name)) is not None:
            types[name] = SchemaType(name, inst.definition.id, inst.stream, builder.ref(inst))
    if unused := set(builder.codecs) - builder.used:
        raise ValueError(f"codecs for {', '.join(sorted(unused))}, but the schema has no such type")
    return Schema(file, types)


def compile_schema(
    text: str,
    *,
    resolver: ModuleResolver | None = None,
    key: str | None = None,
    id: str | None = None,
    codecs: Mapping[str, Codec] | None = None,
) -> Schema:
    """Parse and check a schema file (spec §14) and build its decoders.

    Without a `resolver`, only standard modules can be imported. Raises `HausSchemaFileError`.
    """
    return from_schema_file(parse_schema_file(text, resolver=resolver, key=key, id=id), codecs=codecs)


def load_schema(
    path: str | Path,
    *,
    packages: Mapping[str, str | Path] | None = None,
    codecs: Mapping[str, Codec] | None = None,
) -> Schema:
    """Read a schema file, with its relative imports next to it and `packages` (name → directory).

    schema = load_schema("order.schema.haus", packages={"@haus/money": "vendor/money"})
    """
    module = read_module(path)
    file = Path(module.key)
    resolver = FileResolver(file.parent, {name: Path(p) for name, p in (packages or {}).items()})
    return compile_schema(module.text, resolver=resolver, key=module.key, id=module.id, codecs=codecs)
