"""The fuzzing runner (fuzz/README.md): `runner.py [--stream | --canonical] DIR N`
parses DIR/00000.haus … DIR/{N-1}.haus and prints one line each: `ok <values>`
in the test-suite JSON encoding, or `err <line> <column> <reason>`.
With `--stream`, each file goes through the stream reader in chunks (see
`chunks`); with `--canonical`, `ok` is followed by the canonical form of each
value (spec §12) as a JSON array of strings."""

from __future__ import annotations

import json
import sys
from collections.abc import Callable, Iterator
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


def chunks(data: bytes, i: int) -> Iterator[bytes]:
    """The chunks of case `i`, the same in every runner: chunk k has size
    SIZES[(i + k) % 7], so cuts fall inside escapes, comments and UTF-8 sequences."""
    sizes = [1, 2, 3, 5, 8, 13, 64]
    at = k = 0
    while at < len(data):
        end = at + sizes[(i + k) % 7]
        yield data[at:end]
        at, k = end, k + 1


def line(read: Callable[[], list[Value]], encode: Callable[[Value], object] = suite_json) -> str:
    try:
        values = read()
    except haus.HausSyntaxError as e:
        return f"err {e.line} {e.column} {e.reason.replace(chr(10), ' ')}"
    return "ok " + json.dumps([encode(v) for v in values], separators=(",", ":"))


def run(mode: str, data: bytes, i: int) -> str:
    match mode:
        case "--stream":
            return line(lambda: list(haus.parse_stream(chunks(data, i))))
        case "--canonical":
            return line(lambda: haus.parse_bytes(data), haus.canonical)
        case _:
            return line(lambda: haus.parse_bytes(data))


def main() -> None:
    match sys.argv[1:]:
        case [("--stream" | "--canonical") as mode, directory, count]:
            pass
        case [directory, count]:
            mode = ""
        case _:
            sys.exit("usage: runner.py [--stream | --canonical] DIR N")
    out = sys.stdout
    out.reconfigure(encoding="utf-8", newline="\n")  # type: ignore[union-attr]
    for i in range(int(count)):
        out.write(run(mode, (Path(directory) / f"{i:05}.haus").read_bytes(), i) + "\n")


if __name__ == "__main__":
    main()
