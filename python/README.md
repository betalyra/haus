# haus for Python

**A data format for humans: friendly to write, pleasant to read, and at home in your code.**

> ⚠️ **Highly experimental.** This package has the parser. Typed decoding with schemas, streaming and the formatter are on their way.

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

## Development

```sh
uv sync
uv run pytest            # unit tests and the shared conformance suite in ../test-suite
uv run ruff check . && uv run mypy && uv run pyright
```

The parser also runs in the [differential fuzzer](../fuzz) against the Lean reference parser and the Rust, Roc and TypeScript parsers.
