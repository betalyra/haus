"""The fuzzing runner (fuzz/README.md): `runner.py DIR N` parses DIR/00000.haus …
DIR/{N-1}.haus and prints one line each: `ok <values>` in the test-suite JSON
encoding, or `err <line> <column> <reason>`."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import haus
from haus import Array, Bytes, Number, Record, String, Value, Variant


def suite_json(v: Value) -> object:
    match v:
        case String(s):
            return s
        case Number(text):
            return {"num": text}
        case Bytes(data):
            return {"bytes": data.hex()}
        case Array(items):
            return [suite_json(x) for x in items]
        case Record(fields):
            return {"rec": {k: suite_json(x) for k, x in fields.items()}}
        case Variant(tag, ()):
            return {"tag": tag}
        case Variant(tag, args):
            return {"tag": tag, "args": [suite_json(x) for x in args]}


def line(data: bytes) -> str:
    try:
        values = haus.parse_bytes(data)
    except haus.HausSyntaxError as e:
        return f"err {e.line} {e.column} {e.reason.replace(chr(10), ' ')}"
    return "ok " + json.dumps([suite_json(v) for v in values], separators=(",", ":"))


def main() -> None:
    directory, count = Path(sys.argv[1]), int(sys.argv[2])
    out = sys.stdout
    out.reconfigure(encoding="utf-8", newline="\n")  # type: ignore[union-attr]
    for i in range(count):
        out.write(line((directory / f"{i:05}.haus").read_bytes()) + "\n")


if __name__ == "__main__":
    main()
