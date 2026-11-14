"""The schema conformance suite (test-suite/schema, spec §14, §15; format in test-suite/README.md)."""

from __future__ import annotations

from dataclasses import dataclass
from functools import cache
from pathlib import Path

import pytest

import haus
from haus import Record, String, Value, Variant
from haus.schema import HausDecodeError, HausSchemaFileError, Schema, compile_schema, without_attributes

SUITE = Path(__file__).resolve().parents[2] / "test-suite" / "schema"
SUITES = sorted(p.name.removesuffix(".schema.haus") for p in SUITE.glob("*.schema.haus"))


@dataclass(frozen=True, slots=True)
class Case:
    ok: bool
    type: str
    input: Value
    output: Value

    @property
    def name(self) -> str:
        return f"{'Ok' if self.ok else 'Err'} {self.type} {haus.canonical(self.input)}"[:120]


def schema_cases(text: str) -> list[Case]:
    """`Ok { type, input, output? }` and `Err { type, input }`."""
    out: list[Case] = []
    for v in haus.parse_all(text):
        match v:
            case Variant(("Ok" | "Err") as tag, (Record(fields),)) if isinstance(t := fields.get("type"), String):
                value = fields["input"]
                out.append(Case(tag == "Ok", t.value, value, fields.get("output", value)))
            case _:
                raise ValueError(f"not a case: {haus.canonical(v)}")
    return out


def run(schema: Schema, case: Case) -> None:
    t = schema[case.type]
    if case.ok:
        assert haus.canonical(t.encode(t.decode(case.input))) == haus.canonical(case.output)
    else:
        with pytest.raises(HausDecodeError):
            t.decode(case.input)


CASES = [
    pytest.param(suite, case, id=f"{suite}: {case.name}")
    for suite in SUITES
    for case in schema_cases((SUITE / f"{suite}.cases.haus").read_text("utf-8"))
]


@cache
def compiled(suite: str, *, stripped: bool = False) -> Schema:
    text = (SUITE / f"{suite}.schema.haus").read_text("utf-8")
    return compile_schema(without_attributes(text) if stripped else text)


def test_every_suite_has_cases() -> None:
    assert SUITES
    assert all((SUITE / f"{s}.cases.haus").is_file() for s in SUITES)


@pytest.mark.parametrize(("suite", "case"), CASES)
def test_case(suite: str, case: Case) -> None:
    run(compiled(suite), case)


@pytest.mark.parametrize(("suite", "case"), CASES)
def test_case_without_attributes(suite: str, case: Case) -> None:
    """Attributes don't matter (spec §15): the same result without them."""
    run(compiled(suite, stripped=True), case)


@pytest.mark.parametrize("suite", SUITES)
def test_stripping_removes_every_attribute(suite: str) -> None:
    text = (SUITE / f"{suite}.schema.haus").read_text("utf-8")
    stripped = without_attributes(text)
    assert without_attributes(stripped) == stripped
    assert "@" not in stripped
    assert len(stripped) == len(text)
    if suite == "attributes":
        assert stripped != text
        assert compile_schema(stripped).warnings == ()


# Each invalid schema, with a piece of the reason it must be rejected for.
INVALID = {
    "any-arity": "Any takes no arguments",
    "attribute-on-spread": "attributes can't be put on a spread",
    "attribute-space": "no space is allowed between @deprecated and '('",
    "closed-empty-variant": "a closed variant needs at least one tag",
    "deprecated-number": "@deprecated takes no argument or one string",
    "deprecated-twice": "@deprecated appears twice",
    "deprecated-two-args": "@deprecated takes no argument or one string",
    "import-no-names": "expected a type name",
    "param-underscore": "must start with a lowercase letter",
    "redefine-any": "Any is a prelude type and can't be redefined",
    "redefine-secret": "Secret is a prelude type and can't be redefined",
    "row-parameter": "row parameters (...r) aren't supported",
    "secret-arity": "Secret needs 1 argument",
    "secret-recursion": "type A refers to itself without a record, array or variant in between",
    "spread-cycle": "spreads itself",
    "unguarded-recursion": "refers to itself without a record, array or variant in between",
}


def test_every_invalid_schema_has_a_reason() -> None:
    assert sorted(INVALID) == sorted(p.name.removesuffix(".schema.haus") for p in (SUITE / "invalid").glob("*.haus"))


@pytest.mark.parametrize(("name", "reason"), sorted(INVALID.items()))
def test_invalid_schema(name: str, reason: str) -> None:
    with pytest.raises(HausSchemaFileError) as e:
        compile_schema((SUITE / "invalid" / f"{name}.schema.haus").read_text("utf-8"))
    assert reason in e.value.reason
