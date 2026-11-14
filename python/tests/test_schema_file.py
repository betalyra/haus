"""Schema files (spec §13.3, §14): what the checker accepts, rejects and warns about."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest

from haus import Variant
from haus.schema import (
    FileResolver,
    HausSchemaFileError,
    PositionalPayload,
    RecordType,
    ResolvedModule,
    Tagged,
    Unknown,
    VariantType,
    compile_schema,
    identify,
    load_schema,
    parse_schema_file,
)


def rejects(text: str, reason: str, **kwargs: object) -> HausSchemaFileError:
    with pytest.raises(HausSchemaFileError) as e:
        parse_schema_file(text, **kwargs)  # type: ignore[arg-type]
    assert reason in e.value.reason, e.value.reason
    return e.value


@pytest.mark.parametrize(
    ("text", "reason"),
    [
        ("type A = B", "unknown type B"),
        ("type A = Date", "import it with: import std/time (Date)"),
        ("type A = Money", "import @haus/money (Money)"),
        ("type A = Array", "Array needs 1 argument"),
        ("type A = Array Int Int", "Array needs 1 argument"),
        ("type A = Result Int", "Result needs 2 arguments"),
        ("type A = Int Int", "Int takes no arguments"),
        ("type P a = { x: a }\ntype A = P", "P needs 1 argument (P a)"),
        ("type P a = { x: a }\ntype A = P Int Int", "P needs 1 argument (P a), got 2"),
        ("type A = Int\ntype A = String", "type A is defined twice"),
        ("type Maybe = Int", "Maybe is a prelude type"),
        ("type Stream = Int", "Stream is a prelude type"),
        ("type Bool = Int", "Bool is a prelude type"),
        ("type A = { x: Int, x: String }", "field x appears twice"),
        ("type A = < X | X >", "tag X appears twice"),
        ("type B = { x: Int }\ntype A = { ...B, x: Int }", "field x appears twice (from ...B)"),
        ("type B = < X >\ntype A = < X | ...B >", "tag X appears twice (from ...B)"),
        ("type A = closed < >", "a closed variant needs at least one tag"),
        ("type B = < X >\ntype A = { ...B }", "B is not a record"),
        ("type B = { x: Int }\ntype A = < ...B >", "B is not a variant"),
        ("type B a = { x: a }\ntype A = { ...B }", "only a type without parameters can be spread"),
        ("type B = Stream { x: Int }\ntype A = { ...B }", "B is a Stream and can't be spread"),
        ("type A = { ...Int }", "Int can't be spread"),
        ("type A = < ...A >", "type A spreads itself"),
        ("type A = { x: Int, ...r }", "row parameters (...r)"),
        ("type A = { @deprecated(1) x: Int }", "@deprecated takes no argument or one string"),
        ('type A = < @deprecated @deprecated("x") X >', "@deprecated appears twice"),
        ("type A = B\ntype B = A", "refers to itself without a record, array or variant"),
        ("type A = Secret A", "refers to itself without a record, array or variant"),
        ("type A = Secret (Secret A)", "refers to itself without a record, array or variant"),
        ("type L a = < Nil | Cons a (L (Array a)) >", "must refer to itself with its own parameters"),
        ("type L a b = < Nil | Cons a (L b a) >", "must refer to itself with its own parameters"),
        ("type A = { x: b }", "unknown type parameter b"),
        ("type A a a = Int", "parameter a appears twice"),
        ("type A = { s: Stream Int }", "Stream can only be the whole type of a definition"),
        ("type E = Stream Int\ntype A = { e: E }", "E is a Stream"),
        ("type A = { e: E }\ntype E = Stream Int", "E is a Stream"),
        ("type A = Stream", "Stream needs 1 argument"),
        ("type A = { x: _ }", "there is no _"),
        ("type A = {| x: Int |}", "write closed { … }"),
        ("type A = { @deprecated ...B }\ntype B = { x: Int }", "attributes can't be put on a spread"),
        ('type A = { @deprecated ("x") x: Int }', "no space is allowed between @deprecated and '('"),
        ("@deprecated\nimport std/time (Date)", "a type definition after the attribute"),
        ("type A = { x: Int", "expected ',' or '}'"),
        ("type a = Int", "a type name"),
        ("type A = Int /* open", "unterminated block comment"),
        ('type A = { """x""": Int }', "block strings can't be field names"),
        ("type A = { @deprecated(Foo { a: ) x: Int }", "expected a value"),
    ],
)
def test_rejects(text: str, reason: str) -> None:
    rejects(text, reason)


def test_error_positions() -> None:
    e = rejects("type A = Int\n\ntype B = { x: Nope }", "unknown type Nope")
    assert (e.line, e.column) == (3, 15)


def test_spreads_keep_order_and_their_own_openness() -> None:
    f = parse_schema_file("""
        type UserEvent = < UserCreated { id: Int } | @deprecated UserRenamed { id: Int, to: String } >
        type AppEvent = closed < Start | ...UserEvent | Heartbeat >
        type Base = closed { id: Int }
        type Person = { ...Base, name: String }
    """)
    app = f.instance("AppEvent")
    assert app is not None and isinstance(app.body, VariantType)
    assert [c.tag for c in app.body.cases] == ["Start", "UserCreated", "UserRenamed", "Heartbeat"]
    assert not app.body.open
    assert app.body.cases[2].attributes[0].name == "deprecated"  # a spread copies attributes
    person = f.instance("Person")
    assert person is not None and isinstance(person.body, RecordType)
    assert [x.key for x in person.body.fields] == ["id", "name"] and not person.body.closed


def test_generics_and_result() -> None:
    s = compile_schema("""
        type List a = < Nil | Cons a (List a) >
        type Ints = List Int
        type Out = Result String (List Int)
    """)
    assert "List" not in s.types  # generic types have no decoder of their own
    assert s["Ints"].parse("Cons(1, Nil)") == Tagged("Cons", (1, Tagged("Nil")))
    assert s["Out"].parse("Ok(Nil)") == Tagged("Ok", (Tagged("Nil"),))
    out = s.file.instance("Out")
    assert out is not None and isinstance(out.body, VariantType)
    assert [c.tag for c in out.body.cases] == ["Err", "Ok"] and not out.body.open
    assert isinstance(out.body.cases[0].payload, PositionalPayload)


def test_definitions_have_docs_and_sources() -> None:
    f = parse_schema_file('import std/time (Date)\n\n// A day.\n// Any day.\n@deprecated("old")\ntype Day = Date\n')
    (day,) = f.definitions
    assert day.doc == "A day.\nAny day."
    assert day.source == '// A day.\n// Any day.\n@deprecated("old")\ntype Day = Date'
    assert day.id == "Day"
    assert f.imports == {"Date": "Date"}


# ── warnings ─────────────────────────────────────────────────


def test_warnings() -> None:
    f = parse_schema_file("""@since("1.2")
@deprecated("use Customer")
type Client = { id: Int }
@deprecated
type Old = < A >
type Uses = { client: Client, @example(1) old: Old }
type Spreads = < ...Old | B >
@deprecated
type AlsoOld = { c: Client }
""")
    assert [(w.kind, w.message, w.line, w.column) for w in f.warnings] == [
        (
            "unknown-attribute",
            "unknown attribute @since: this version of haus gives it no meaning (it knows @deprecated)",
            1,
            1,
        ),
        ("deprecated", "Client is deprecated: use Customer", 6, 23),
        (
            "unknown-attribute",
            "unknown attribute @example: this version of haus gives it no meaning (it knows @deprecated)",
            6,
            31,
        ),
        ("deprecated", "Old is deprecated", 6, 48),
        ("deprecated", "Old is deprecated", 7, 21),
    ]
    w = f.warnings[0]
    assert (w.offset, w.end) == (0, len('@since("1.2")'))


def test_unknown_attributes_are_accepted_as_they_are() -> None:
    s = compile_schema('@x @x(1, "a", [True], { a: Some(1) },) type A = { @y @y n: Int }')
    assert s["A"].parse("{ n: 1 }") == {"n": 1}
    assert len(s.warnings) == 4


# ── imports ──────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class MemoryResolver:
    """Files by key; packages as `@org/name` keys."""

    files: dict[str, tuple[str, str | None]]

    def resolve(self, module: str, from_key: str | None) -> ResolvedModule:
        key = module.removeprefix("./")
        if key not in self.files:
            raise LookupError(f"no file {key}")
        text, version = self.files[key]
        id = f"{key}@{version.split('.')[0]}" if version else f"app/{key}"
        return ResolvedModule(key, id, text, version)


def test_imports() -> None:
    resolver = MemoryResolver(
        {
            "common": ("type Address = { city: String }\ntype Hidden = Int", None),
            "@haus/money": ("type Money = < Money Decimal Currency >\ntype Currency = < >", "1.2.0"),
        }
    )
    s = compile_schema(
        "import ./common (Address)\nimport @haus/money@1 (Money)\ntype Order = { to: Address, total: Money }",
        resolver=resolver,
    )
    assert s["Order"].parse('{ to: { city: "Paris" }, total: Money(1.50, EUR) }') == {
        "to": {"city": "Paris"},
        "total": Tagged("Money", ("1.50", Unknown(Variant("EUR")))),
    }
    assert s.file.imported["Money"].id == "@haus/money@1#Money"
    assert s.file.imported["Address"].id == "app/common#Address"
    assert s["Address"].id == "app/common#Address"


def test_import_errors() -> None:
    resolver = MemoryResolver(
        {
            "common": ("type Address = { city: String }", None),
            "self": ("import ./self (A)\ntype A = Int", None),
            "a": ("import ./b (B)\ntype A = Int", None),
            "b": ("import ./a (A)\ntype B = Int", None),
            "broken": ("type A = { x: Nope }", None),
            "@acme/ids": ("type Id = String", "3.0.1"),
            "copy": ("type Id = String", "3.0.1"),
        }
    )
    r = {"resolver": resolver}
    rejects("import ./missing (A)", "can't import ./missing: no file missing", **r)
    rejects("import ./common (Street)", "./common has no type Street (it has Address)", **r)
    rejects("import ./common (Address)\nimport ./common (Address)", "Address is imported twice", **r)
    rejects("import ./common (Address, Address)", "Address is imported twice", **r)
    rejects("import ./common (Address)\ntype Address = Int", "type Address is already imported", **r)
    rejects("import ./self (A)", "import cycle", **r)
    rejects("import ./a (A)", "import cycle", **r)
    rejects("import @acme/ids@2 (Id)", "wants major version 2, but version 3.0.1 was found", **r)
    e = rejects("type X = Int\nimport ./broken (A)", "./broken (1:15): unknown type Nope", **r)
    assert (e.line, e.column) == (2, 1)  # at the import, with the place in the imported file
    rejects("import ./common (Address)", "no module resolver")
    rejects("import std/money (Money)", "it is the package @haus/money")
    rejects("import std/geo (Point)", "unknown standard module std/geo")
    rejects("import std/time (Moment)", "std/time has no type Moment")
    rejects("import std/time (Date)\nimport std/time (Date)", "Date is imported twice")
    rejects("import std/time (Date)\ntype Date = Int", "type Date is already imported")
    rejects("import std/time ()", "expected a type name")
    rejects("import money (Money)", "unknown module money")

    # Two files with one id: two copies of a package found in different places.
    @dataclass(frozen=True, slots=True)
    class TwoCopies:
        def resolve(self, module: str, from_key: str | None) -> ResolvedModule:
            return ResolvedModule(module, "@acme/ids@3", "type Id = String", "3.0.1")

    rejects("import ./one (Id)\nimport ./two (Id)", "another file already is", resolver=TwoCopies())


# ── files and packages ───────────────────────────────────────


def test_load_schema_with_files_and_packages(tmp_path: Path) -> None:
    app = tmp_path / "app"
    (app / "schemas").mkdir(parents=True)
    (app / "pyproject.toml").write_text('[project]\nname = "my-app"\n')
    (app / "schemas" / "common.schema.haus").write_text("type Address = { city: String }\n")
    (app / "schemas" / "order.schema.haus").write_text(
        "import ./common (Address)\nimport @haus/money@1 (Money)\ntype Root = { to: Address, total: Money }\n"
    )
    money = tmp_path / "vendor" / "money"
    money.mkdir(parents=True)
    (money / "haus.package.haus").write_text('{ name: "@haus/money", version: "1.0.0", schema: "money.schema.haus" }')
    (money / "money.schema.haus").write_text("type Money = < Money Decimal String >\n")
    (money / "extra.schema.haus").write_text("type X = Int\n")

    s = load_schema(app / "schemas" / "order.schema.haus", packages={"@haus/money": money})
    assert s["Root"].id == "my-app/schemas/order#Root"
    assert s.file.imported["Money"].id == "@haus/money@1#Money"
    assert s.file.imported["Address"].id == "my-app/schemas/common#Address"
    assert s["Root"].parse('{ to: { city: "Paris" }, total: Money(1.50, "EUR") }')["total"] == Tagged(
        "Money", ("1.50", "EUR")
    )
    assert identify(money / "extra.schema.haus") == "@haus/money@1/extra"

    with pytest.raises(HausSchemaFileError, match="not among the packages"):
        load_schema(app / "schemas" / "order.schema.haus")
    with pytest.raises(HausSchemaFileError, match="names the package @haus/money, not @haus/geo"):
        compile_schema(
            "import @haus/geo (Point)",
            resolver=FileResolver(tmp_path, {"@haus/geo": money}),
        )
    with pytest.raises(HausSchemaFileError, match="wants major version 2"):
        compile_schema("import @haus/money@2 (Money)", resolver=FileResolver(tmp_path, {"@haus/money": money}))
