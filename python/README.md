# haus for Python

**A data format for humans: friendly to write, pleasant to read, and at home in your code.**

> ⚠️ **Early placeholder.** The Python parser is on its way. This release only reserves the name.

```sh
pip install haus-fmt
```

```python
import haus
```

Until the parser lands, see the [specification](https://github.com/betalyra/haus-fmt/tree/main/spec)
and the TypeScript, Rust and Roc parsers in the [haus repository](https://github.com/betalyra/haus-fmt).

## Development

```sh
uv sync
uv run pytest
uv build
```

It will be tested against the shared conformance suite in [`../test-suite`](../test-suite), like every other haus parser.
