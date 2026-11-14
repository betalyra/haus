"""The language-neutral conformance suite (test-suite/README.md)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import haus
from haus import Array, Bytes, Number, Record, String, Value, Variant

SUITE = Path(__file__).resolve().parents[2] / "test-suite"


def cases(kind: str) -> list[Path]:
    files = sorted((SUITE / kind).glob("*.haus"))
    assert files, f"no cases in test-suite/{kind}"
    return files


def canonical(v: Value) -> object:
    """A value in the suite's JSON encoding."""
    match v:
        case String(s):
            return s
        case Number(text):
            return {"num": text}
        case Bytes(data):
            return {"bytes": data.hex()}
        case Array(items):
            return [canonical(x) for x in items]
        case Record(fields):
            return {"rec": {k: canonical(x) for k, x in fields.items()}}
        case Variant(tag, ()):
            return {"tag": tag}
        case Variant(tag, args):
            return {"tag": tag, "args": [canonical(x) for x in args]}


@pytest.mark.parametrize("path", cases("valid"), ids=lambda p: p.stem)
def test_valid(path: Path) -> None:
    expected = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
    assert [canonical(v) for v in haus.parse_bytes(path.read_bytes())] == expected


@pytest.mark.parametrize("path", cases("invalid"), ids=lambda p: p.stem)
def test_invalid(path: Path) -> None:
    with pytest.raises(haus.HausSyntaxError):
        haus.parse_bytes(path.read_bytes())


@pytest.mark.parametrize("path", cases("valid"), ids=lambda p: p.stem)
def test_canonical(path: Path) -> None:
    """`NAME.canonical`: the canonical form (spec §12) of each value, one per line."""
    expected = path.with_suffix(".canonical").read_bytes().decode("utf-8")
    assert "".join(haus.canonical(v) + "\n" for v in haus.parse_bytes(path.read_bytes())) == expected


@pytest.mark.parametrize("path", cases("valid"), ids=lambda p: p.stem)
def test_hash_all(path: Path) -> None:
    """`NAME.hash`: `hash_all` of the file's values (spec §12), also while a stream is read."""
    expected = path.with_suffix(".hash").read_text(encoding="utf-8").strip()
    data = path.read_bytes()
    values = haus.parse_bytes(data)
    assert haus.hash_all(values) == expected
    hasher = haus.Hasher()
    for v in haus.parse_stream(data[i : i + 3] for i in range(0, len(data), 3)):
        hasher.add(v)
    assert hasher.digest() == expected
    if len(values) == 1:
        assert haus.hash(values[0]) == expected
