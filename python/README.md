# haus for Python

**A data format for humans: friendly to write, pleasant to read, and at home in your code.**

> ⚠️ **Highly experimental.** This package has the parser, the stream reader, the canonical form and decoding with schemas. The formatter is on its way.

```sh
pip install haus-fmt
```

The parser follows the [specification](https://github.com/betalyra/haus-fmt/tree/main/spec): exact numbers, limits enforced while parsing, and error positions in code points. It needs Python 3.11 or later and has no dependencies.

```python
import haus
from haus import Number, Record, Variant

order = haus.parse('{ id: 7, total: Money(44.40, EUR), status: Shipped { tracking: "DE-4711" } }')

match order:
    case Record({"status": Variant("Shipped", (Record(fields),))}):
        print("shipped:", fields["tracking"])  # String(value='DE-4711')

haus.parse("19.90")  # Number(text='19.90'): exact, never a float
haus.parse("19.90").to_decimal()  # Decimal('19.90')
haus.parse_all("Log { a: 1 },\nHeartbeat,\n")  # a stream: every top-level value
haus.parse_bytes(open("data.haus", "rb").read())  # UTF-8 checked, BOM skipped
```

Values are `Number`, `String`, `Bytes`, `Array`, `Record` and `Variant`, frozen dataclasses you can `match` on. Equality follows the spec: record field order doesn't matter, `1.0 != 1`, and `Tag { … }` equals `Tag({ … })`.

Errors are `haus.HausSyntaxError`, a `ValueError` with `reason`, `line` and `column`:

```python
haus.parse("{ ok: true }")
# HausSyntaxError: unexpected identifier 'true': lowercase identifiers can only be
# record keys (booleans are the variants True / False) at 1:7
```

Limits are configurable with `haus.Limits(max_depth=…, max_number_length=…, max_exponent=…, max_string_length=…)`.

## Streams

A stream is a file of values, each followed by a comma. `haus.parse_stream` yields each value as soon as its comma arrives, from a file or any iterable of `bytes` or `str` chunks, split anywhere:

```python
with open("events.haus", "rb") as f:
    for event in haus.parse_stream(f):
        print(event)
```

`haus.StreamReader` does no I/O, for sockets and event loops: `push(chunk)` returns the values the chunk completed, `finish()` the last one if it had no comma after it. Memory is bounded by the largest single value (`max_value_length`, 64 Mi characters by default), errors have positions in the whole stream, and `require_terminator=True` reports a stream that ends without a comma after its last value as cut off.

```python
reader = haus.StreamReader(require_terminator=True)
reader.push(b"Heartbeat,\nUserCreated { id")  # [Variant(tag='Heartbeat', args=())]
reader.push(b": 1 },\n")  # [Variant(tag='UserCreated', args=(Record(...),))]
reader.finish()  # []
```

## Canonical form and hashing

`haus.canonical` writes a value as one exact text, the same in every haus binding: layout, comments, key order and spelling don't change it. `haus.hash` is the SHA-256 of that text, for signing, deduplication and content addressing:

```python
order = haus.parse('Order { total: 19.90, id: 0xFF, "x-y": 1e+5 }')
haus.canonical(order)  # 'Order{id:255,total:19.90,"x-y":1e5}'
haus.hash(order)  # 64 lowercase hex digits
haus.equals(haus.parse("1.0"), haus.parse("1"))  # False: different numbers
sorted(values, key=functools.cmp_to_key(haus.compare))  # by canonical form, not numeric: 10 before 9
```

A whole file or stream has one hash too: `haus.hash_all(values)` hashes the canonical forms joined by `,` (a file of one value hashes like the value). `haus.Hasher` computes it while a stream is read:

```python
hasher = haus.Hasher()
with open("events.haus", "rb") as f:
    for event in haus.parse_stream(f):
        hasher.add(event)
hasher.digest()  # == haus.hash_all(all events)
```

## Schemas

`haus.schema` reads schema files (`.schema.haus`, spec §14), checks them, and decodes and encodes values with their types (spec §15):

```python
from haus import schema
from haus.schema import Nothing, Secret, Some, Tagged, Unknown

s = schema.load_schema("order.schema.haus")  # imports ./files next to it; packages: see below
# or: schema.compile_schema(text)            # std/time imports only, without a resolver

order = s["Order"].parse('{ id: 7, total: 44.40, status: Shipped { tracking: "DE-4711" } }')
# {'id': 7, 'total': '44.40', 'status': Tagged(tag='Shipped', payload={'tracking': 'DE-4711'})}
s["Order"].decode(value)  # a parsed haus.Value
s["Order"].encode(order)  # back to a haus.Value
s["Order"].canonical(order)  # … written in canonical form: valid haus text
s.warnings  # unknown attributes, uses of @deprecated types
```

Errors are `HausSchemaFileError` (a `HausSyntaxError`, with line and column in the schema file), `HausDecodeError` and `HausEncodeError` (`ValueError`s with `reason` and `path`): `expected Decimal, found string "3" at $.items[2].price`.

### What values decode to

The defaults keep the value: encoding what they decoded gives back an equal haus value (spec §13.4), except where §15 drops something by design (fields an open record ignores, the spelling of a float, `-0` as an integer).

| Schema | Python | Notes |
|---|---|---|
| `String` | `str` | kept exactly, no normalization |
| `Bytes` | `bytes` | |
| `Bool` | `bool` | |
| `Int`, `Int8` … `UInt64` | `int` | any size for `Int`; out of range is an error, never clamped |
| `Float32`, `Float64` | `float` | the nearest value (binary32 rounded directly from the decimal), `nan`, `inf`; written in one spelling |
| `Decimal` | `str`, the literal: `"19.90"`, `"1.5e3"` | `decimal.Decimal` can't tell `15e2` from `1.5e3`, so it is opt-in (codecs below); encoding also accepts a `Decimal` |
| `Date`, `Instant`, … (std/time) | `str`, the checked text: `"2026-11-13"` | |
| `Array a` | `tuple` | encoding accepts a `list` too |
| `Map v` | `dict[str, V]` | |
| `{ a: T, b?: T }` | `dict` | a missing optional field is a missing key, never `None`; `None` is never a value |
| `Maybe a` | `Some(x)` or `Nothing()` | not Python's `None`: `Some(Nothing())` and `Nothing()` stay apart |
| `< Empty \| Circle { r: Float64 } \| Point Float64 Float64 >` | `Tagged("Empty")`, `Tagged("Circle", {"r": 1.0})`, `Tagged("Point", (1.0, 2.0))` | `Result e a` is `Tagged("Ok", (x,))` / `Tagged("Err", (e,))` |
| a tag an open variant doesn't list (and every tag of `< >`) | `Unknown(raw)` | the parsed `Variant`, untrusted; written back unchanged |
| `Any` | the parsed `haus.Value` | written back unchanged, after checking it is a value within the limits |
| `Secret a` | `Secret`, holding what `a` decodes to | `str`, `repr`, f-strings and logs show `<redacted>`; `expose()` gives the value |

All of them are frozen dataclasses (except `Secret`) and work with `match`:

```python
match s["Shape"].parse(text):
    case Tagged("Circle", {"r": r}):
        ...
    case Tagged("Point", (x, y)):
        ...
    case Unknown(raw):
        ...  # a newer sender's shape: forward or log raw
match user.get("note"):
    case None:
        ...  # the field was not given
    case Nothing():
        ...  # None: clear it
    case Some(text):
        ...  # Some(text): set it
```

A secret's errors give its place and type, never the value or a path into it (a map key could be the secret), when decoding and when encoding: `expected String (a Secret: the value is not shown) at $.apiKey`. Secrets are equal only to themselves. Encode one with `Secret("sk-…")`.

### Limits

Decoding is linear in the input whatever the schema (spec §9.8): a variant's case is one lookup on its tag, the nesting depth is limited (`limits=haus.Limits(max_depth=…)`, 256 by default, for recursive types too), and every call has a work budget (`max_steps`; by default 16 steps per value when decoding and 16 Mi when encoding). Encoding detects values that contain themselves, and checks raw values (`Any`, `Unknown`) against the parser's limits and the value syntax before writing them.

### Streams

`type Events = Stream Event` describes a file. `s["Events"].parse_stream(source)` reads it (a file or chunks, as `haus.parse_stream`) and decodes each value as it arrives; an error's path starts with the value's index. `encode_all(values)` writes stream items, each followed by `,\n`.

### Imports and packages

`import ./common (Address)` reads `common.schema.haus` next to the importing file. Python has no scoped package names, so schema packages are never searched for (spec §13.3): list the project's direct schema dependencies with their directories, each holding a `haus.package.haus` manifest. `installed_package` finds the directory of an installed Python package that ships one, without importing it:

```python
s = schema.load_schema(
    "order.schema.haus",
    packages={"@haus/money": "../extensions/money", "@acme/ids": schema.installed_package("acme_ids")},
)
```

Relative package directories are relative to the schema file. The manifest's name must be the imported name, and `@haus/money@1` checks its major version. Types have the ids of spec §13.3: `@haus/money@1#Money` in a package, `<project name>/<path>#Name` for other files (the nearest `pyproject.toml`'s `[project] name`). Any other way of finding files is a `ModuleResolver`: an object with `resolve(module, from_key) -> ResolvedModule`, passed to `compile_schema(text, resolver=…, key=…, id=…)`.

### Codecs: other host types

A codec chooses the host type of a named type, by its id (spec §13.4). It runs after the type's own decoding, so it can reject more values but never fewer. The ones here keep less than the haus value, so they are opt-in:

```python
s = schema.compile_schema(
    text,
    codecs={
        "prelude#Decimal": schema.DecimalCodec(),  # decimal.Decimal
        "std/time#Date": schema.DateCodec(),  # datetime.date
        "std/time#Instant": schema.InstantCodec(),  # aware datetime.datetime
    },
)
```

| Codec | Drops |
|---|---|
| `DecimalCodec` | the spelling of the exponent: `15e2` and `1.5e3` are both `Decimal('1.5E+3')`, written `1.5e3`. `Decimal`'s `==` also ignores scale (`19.90 == 19.9`), unlike haus |
| `DateCodec` | nothing; it rejects the year 0000, which `datetime.date` lacks |
| `InstantCodec` | fraction digits beyond microseconds, the fraction's spelling (`.25` → `.250000`), `Z` versus `+00:00` (written `Z`); rejects the year 0000 |

A codec is any object with `decode(value)` and `encode(value)` working on the default host type; raise `ValueError` to reject. Codecs for your own types use their ids (`my-app/order#Money`).

### Schema files for tools

`schema.parse_schema_file(text, …)` gives the checked file without building decoders: its definitions (with `doc`, `source`, `attributes` and `id`), the resolved types, imports and warnings. `schema.without_attributes(text)` blanks every attribute out (positions stay), which never changes decoding (spec §15).

## Development

```sh
uv sync
uv run pytest            # unit tests and the shared conformance suite in ../test-suite
uv run ruff check . && uv run mypy && uv run pyright
```

The parser, the stream reader and `canonical` also run in the [differential fuzzer](../fuzz) against the Lean reference and the Rust, Roc and TypeScript bindings, and so do the std/time check (`node fuzz/src/time.ts`) and schema decoding (`node fuzz/src/main.ts --schema`, through [`fuzz/schema_runner.py`](fuzz/schema_runner.py)). The std/time profile (`haus._time`) and float rounding and spelling (`haus._float`, spec §15) are the building blocks of schema decoding; floats are rounded to binary32 exactly, from the decimal, never through binary64.
