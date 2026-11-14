"""The schema decoding fuzzing runner (fuzz/README.md, "Schema decoding"):
`schema_runner.py FILE` reads lines `SUITE TYPE HEX` (a value's haus text as
hex-encoded UTF-8), decodes the value with the named type of the suite's
schema file (test-suite/schema or fuzz/schema), encodes the result, and prints
one line each: `ok <canonical form>` or `err <reason>`. Encoding what was
decoded must work (spec §15), so an encode error is printed as `crash …`."""

from __future__ import annotations

import sys
from pathlib import Path

import haus
from haus.schema import HausDecodeError, HausEncodeError, Schema, compile_schema

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIRS = (ROOT / "test-suite" / "schema", ROOT / "fuzz" / "schema")


def schemas() -> dict[str, Schema]:
    """Every schema file of the fuzzer, by suite name."""
    return {
        p.name.removesuffix(".schema.haus"): compile_schema(p.read_text("utf-8"))
        for d in SCHEMA_DIRS
        for p in sorted(d.glob("*.schema.haus"))
    }


def outcome(compiled: dict[str, Schema], line: str) -> str:
    suite, type_name, hex_text = line.split(" ")
    schema = compiled.get(suite)
    if schema is None or type_name not in schema:
        return f"crash no type {suite}.{type_name}"
    try:
        values = haus.parse_bytes(bytes.fromhex(hex_text))
    except haus.HausSyntaxError as e:
        return f"err not a single value: {e}"
    if len(values) != 1:
        return "err not a single value"
    t = schema[type_name]
    try:
        decoded = t.decode(values[0])
    except HausDecodeError as e:
        return f"err {e}"
    try:
        return "ok " + haus.canonical(t.encode(decoded))
    except HausEncodeError as e:
        return f"crash encoding failed: {e}"


def main() -> None:
    match sys.argv[1:]:
        case [file]:
            pass
        case _:
            sys.exit("usage: schema_runner.py FILE")
    compiled = schemas()
    out = sys.stdout
    out.reconfigure(encoding="utf-8", newline="\n")  # type: ignore[union-attr]
    for line in Path(file).read_text("utf-8").splitlines():
        if line:
            out.write(outcome(compiled, line).replace("\n", " ") + "\n")


if __name__ == "__main__":
    main()
