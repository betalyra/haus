# haus for Python

**A data format for humans: friendly to write, pleasant to read, and at home in your code.**

> ⚠️ **Highly experimental.** This package has the parser, the stream reader and the canonical form. Typed decoding with schemas and the formatter are on their way.

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

## Development

```sh
uv sync
uv run pytest            # unit tests and the shared conformance suite in ../test-suite
uv run ruff check . && uv run mypy && uv run pyright
```

The parser, the stream reader and `canonical` also run in the [differential fuzzer](../fuzz) against the Lean reference and the Rust, Roc and TypeScript bindings.
