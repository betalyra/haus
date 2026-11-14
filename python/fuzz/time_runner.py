"""The std/time fuzzing runner (fuzz/README.md): `time_runner.py FILE` reads
lines `TYPE HEX` (the text as hex-encoded UTF-8) and prints one line each:
`ok` if the text is a valid value of the std/time type, `no` if not."""

from __future__ import annotations

import sys
from pathlib import Path

from haus._time import check


def result(line: str) -> str:
    type_name, _, hex_text = line.partition(" ")
    try:
        text = bytes.fromhex(hex_text).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return "err invalid UTF-8"
    return "ok" if check(type_name, text) is None else "no"


def main() -> None:
    match sys.argv[1:]:
        case [file]:
            pass
        case _:
            sys.exit("usage: time_runner.py FILE")
    out = sys.stdout
    out.reconfigure(encoding="utf-8", newline="\n")  # type: ignore[union-attr]
    lines = Path(file).read_text("utf-8").splitlines()
    out.write("".join(result(line) + "\n" for line in lines if line))


if __name__ == "__main__":
    main()
