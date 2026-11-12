# haus specification — draft 0.1

The syntax is defined in [`grammar.ebnf`](grammar.ebnf). This document defines
what the syntax means and the rules every implementation must follow. The
standard types are in [`prelude.schema.haus`](prelude.schema.haus) and [`std/`](std) (§13), and
[`../test-suite`](../test-suite) holds the conformance tests.

"MUST", "SHOULD" and "MAY" are used as in RFC 2119.

## 1. Data model

A **value** is one of:

| Kind | Example | Notes |
|---|---|---|
| number | `19.90`, `-1e10`, `0xFF` | exact decimal, see §3 |
| string | `"text"`, `"""…"""` | a sequence of Unicode code points, see §4 |
| bytes | `x"0b34ff"`, `x"9f86d081 884c7d65"` | a sequence of bytes: two hex digits per byte, spaces and tabs between bytes, on one line |
| array | `[1, 2]` | ordered |
| record | `{ id: 1, "x-y": 2 }` | string keys, no duplicates |
| variant | `None`, `Some(1)`, `Circle { r: 1 }` | a tag plus zero or more argument values |

There is no `null` and there are no booleans in the syntax. `True`, `False` and
`None` are ordinary tags whose meaning is fixed by the prelude.

A **file** is a sequence of zero or more values separated by commas (§6). A
single document is a sequence of one.

**Absence is not a value.** A record either contains a field or it doesn't.
`{ }` and `{ x: None }` are different values, and nothing converts one into
the other. Two separate things exist, each with exactly one spelling:

| Schema | Field present | Field missing |
|---|---|---|
| `x: T` | `x: <T value>` | error |
| `x?: T` (optional field) | `x: <T value>` | allowed: "not given" |
| `x: Maybe T` | `x: None` or `x: Some(<T value>)`, always written | error |
| `x?: Maybe T` | `x: None` or `x: Some(…)` | allowed: "not given" |

- An **optional field** (`?`) is a property of the record: the key may be missing. It is never `None`, and decoders MUST keep "missing" and `None` apart (a missing key, not a `None` value, in the decoded result).
- **`Maybe a`** is an ordinary variant, `< None | Some a >`. Its values are always written; a bare `32` is not `Some(32)`.
- `x?: Maybe T` has three states: not given, `None`, `Some(…)`. That is how a partial update says "leave it", "clear it" and "set it" (§1.1).
- The parser never invents values for missing fields, and neither does any decoder: what "not given" means (a default, "unchanged", "unknown") is up to the application.

Bindings MUST represent a missing optional field and `None` differently in their language (in TypeScript: a missing key and `null`), so the two can't be confused when encoding.

### 1.1 Partial updates

A large document is updated by sending only what changes: a record of the same shape whose fields are optional.

```haus
// type UserUpdate = { name?: String, nickname?: Maybe String, address?: AddressUpdate }
{ nickname: None, address: { city: "Paris" } }
```

`nickname` is cleared, `address.city` is set, everything else is not given and stays as it is. Updates that a sparse record can't express (adding one element to an array, renaming) are written as a list of change variants, e.g. `changes: [AddRole(Admin), Rename { from: "a", to: "b" }]`.

## 2. Equality

Two values are equal when they have the same kind and:

- **numbers:** the normalized literals are equal. Normalizing removes digit separators, writes the exponent marker as `e`, and converts hex and binary literals to decimal integers. So `1_000` = `1000` and `0xFF` = `255`, but `1.0` ≠ `1` and `1e2` ≠ `100`: scale and notation are part of the value. Numeric equality ("is 1.0 the same amount as 1?") belongs to the schema or the application.
- **strings:** the code point sequences are identical. There is no Unicode normalization (§4).
- **bytes:** the byte sequences are identical. Case and spacing in the literal don't matter (`x"0B 34"` = `x"0b34"`).
- **bytes vs. other kinds:** a byte string is never equal to a string or an array of numbers.
- **arrays:** the same length, and the elements are pairwise equal.
- **records:** the same set of keys, and the values for each key are equal. Field order doesn't matter.
- **variants:** the same tag, and the arguments are pairwise equal. `Tag { … }` and `Tag({ … })` are the same value.

## 3. Numbers

- **Precision:** a number literal denotes an exact decimal. Parsers MUST keep it without loss, e.g. as the normalized literal text. Converting it to a binary float is a decoding decision made by the schema (`Float64`), never by the parser.
- **Scale:** encoders MUST keep the scale of a decimal: a `Decimal` decoded from `19.90` is written back as `19.90`. Library formatters often drop trailing zeros (Effect's `BigDecimal.format` writes `19.9`), so implementations write the literal themselves.
- **Native equality:** a language's decimal type may ignore scale when comparing (Effect `BigDecimal`, Java `BigDecimal.compareTo`, Python `Decimal` all treat `19.90` and `19.9` as equal), while haus doesn't (§2). Use haus equality, not the native one, for hashing and deduplication.
- **NaN and infinities:** there are no `NaN` or infinity literals. The prelude tags `NaN`, `Infinity` and `NegInfinity` are accepted where the schema says `Float32` or `Float64`.
- **Limits:** a number literal is at most 1000 characters, and its exponent at most ±6144 (§7).

## 4. Strings and Unicode

- **Encoding:** input is UTF-8. Invalid UTF-8 MUST be rejected. A leading byte order mark is ignored.
- **Escapes:** `\"`, `\\`, `\n`, `\r`, `\t` and `\u{1–6 hex digits}`. A `\u{…}` escape MUST denote a Unicode scalar value, so surrogates are rejected.
- **Raw control characters:** the raw control characters U+0000–U+001F, U+007F (DEL) and U+0080–U+009F (C1) MUST NOT appear anywhere in the input, except tab and line breaks (LF, CR LF) where whitespace, block strings and comments allow them. A carriage return is only allowed directly before a line feed. Control characters can rewrite what a terminal displays (ESC and CSI sequences) or truncate text (NUL), so a file could show different content from what it contains. Inside strings, write them as escapes, e.g. `\u{1B}`.
- **Bidirectional controls:** the raw characters U+202A–U+202E and U+2066–U+2069 MUST NOT appear anywhere in the input, including strings, block strings and comments. They can make source text display differently from what is parsed ("Trojan Source"). Inside strings, write them as escapes, e.g. `\u{202E}`.
- **Key comparison:** keys are compared by code point, with **no normalization**. `"café"` (NFC) and `"café"` (NFD) are different keys. Producers that need normalized keys must normalize before writing.
- **NUL characters:** `\u{0}` is allowed. Consumers that pass strings to C APIs must handle embedded NUL characters.
- **Identifiers:** bare keys and tags are ASCII (`[a-z_][A-Za-z0-9_]*` for keys, `[A-Z][A-Za-z0-9_]*` for tags). Any other key must be quoted.

## 5. Variants

- **Payload placement:** a variant's payload MUST start on the same line as its tag; only spaces and tabs may come between them. `Circle { r: 1 }` and `Point (1, 2)` are valid. A line break or comment between the tag and its payload is an error, because a forgotten comma could otherwise silently change the meaning.
- **Positional arguments:** `Point(1, 2)` has two positional arguments. A decoder that maps them to named fields MUST do so only where the schema declares the payload positional (for example `< Point Float64 Float64 >`, `h.Tuple`, or `Haus.Positional` in the Effect adapter). Otherwise reordering schema fields would silently swap values.

## 6. Streams

- **Separators:** top-level values are separated by commas, and a trailing comma is allowed. Writers of streams SHOULD put a comma after every value, including the last. Then appending to a file, `tail -f` and concatenating files all produce valid streams, and a reader knows a value is complete when it sees the comma.
- **Truncation:** a cut-off last value can look valid, e.g. `100` instead of `1000`. Readers of network streams SHOULD offer a strict mode that requires the comma after the last value and reports a truncated stream otherwise.
- **One value too many:** a reader expecting a single document MUST reject a sequence of two or more values.

## 7. Limits

Implementations MUST enforce limits while parsing, MUST let users configure them, and MUST accept every input that stays within these defaults:

| Limit | Default |
|---|---|
| nesting depth (records, arrays, payloads) | 256 |
| characters in one number literal | 1000 |
| absolute exponent | 6144 |
| characters in one string, or between the quotes of a byte string | 16 Mi (16,777,216) |
| characters in one top-level value of a stream | 64 Mi (67,108,864) |

Parsing time MUST be linear in the input size for any input within the limits. For example, duplicate-key checks must use hashing, not a list scan.

## 8. Error positions

Errors report a 1-based line and column. Columns count **Unicode code points**, so a character outside the Basic Multilingual Plane, such as an emoji, is one column.

## 9. Security considerations

1. **Tags are data.** Implementations MUST NOT map tag names to classes, constructors or functions dynamically. Decode only into the types a schema lists explicitly. That kind of dynamic mapping is the root of the "gadget" attacks against Java and .NET deserializers.
2. **No references, includes or remote schemas.** The format has no anchors, references, includes or imports, and parsing never touches the network or the file system. Schemas belong to the reader. Future schema imports MUST be pinned by version and content hash and resolved at build time, never while parsing.
3. **Enforce limits while parsing** (§7), not afterwards.
4. **Record keys are data.** A key such as `__proto__`, `constructor` or `$type` MUST NOT reach an object's prototype or any internal field. JavaScript bindings use own properties, a null prototype or a `Map`.
5. **Unknown variants carry raw data.** The raw value kept for an unknown tag in an open variant is untrusted and subject to the same limits when stored or forwarded.
6. **Fail on the first error.** Parsers MUST NOT guess or repair invalid input. Two parsers that "repair" differently disagree about what a document says.
7. **Signatures.** Sign the exact bytes and transport them unchanged, as JWS and COSE do. A canonical form for hashing equal values (§12) is planned.
8. **Decoding with a schema is linear in the input,** whatever the schema. Implementations MUST:
   - choose a variant's case by looking up its tag, never by trying cases in turn and backtracking. A union of members that the value's tag or kind can't tell apart MUST NOT be allowed in a recursive schema;
   - limit the nesting depth while decoding and encoding (default 256, as in §7), including for values built in code rather than parsed;
   - limit the total work of one decode to a constant times the number of values in the input (a *work budget*; TypeScript uses 16 steps per value). The budget ends any schema mistake, such as a combinator that decodes a value twice, before it can grow with the input;
   - when encoding, detect values that contain themselves, and limit the total work, since objects shared many times (a DAG) expand when written out;
   - check a raw value kept for an unknown variant (item 5) with the same limits before writing it again;
   - build error messages in constant time: no printing of whole schemas or values.
9. **Recursive types** (a type that contains itself, like a tree) are allowed but MUST be explicit (e.g. `h.Recursive`). Every cycle MUST pass through a record field, array element or variant payload, so that each level of recursion consumes a level of input. A schema that applies itself to the same value again MUST fail. Each recursive type SHOULD have its own, smaller depth limit (default 64).
10. **Schemas are declarative.** The schema language describes structure only: records, arrays, variants, prelude types and recursion. Generic types MAY refer to themselves only with the same parameters (`type List a = < Nil | Cons a (List a) >`; not `T (Pair a a)`). There are no type-level functions, conditions on values, references between values, or user code in schemas, and no syntax for rules about values: the only such rules are those of built-in types (§13.1), which run in linear time. Checking a value against a schema then always terminates in linear time; anything more belongs in application code, where the work budget (item 8) still applies.

## 10. Evolution

There is no version header. Any syntax added later MUST be a syntax error in every earlier version, so an old parser fails loudly instead of misreading newer data. Changes in meaning that leave the syntax unchanged are not allowed. The rules of built-in types (§13.1) are part of this: they never change once published. Schema packages are versioned separately, with the rules of §13.3.

## 11. Standard format

There are two official layouts, and like `gofmt` they have no other style
options (indent width defaults to 2 spaces; line width, default 80, only
affects positional payloads). Formatters MUST produce them exactly.

### Pretty (default)

For people.

- **One entry per line in every non-empty record and array,** each followed by a comma, indented one level, with the closing bracket on its own line:
  ```haus
  Person {
    name: "John Doe",
    tags: [
      "a",
      "b",
    ],
    price: Money(7.90, EUR),
  }
  ```
- **Positional payloads stay inline when they fit** the line width (`Money(7.90, EUR)`, `Point(1, 2)`). Otherwise they get one argument per line.
- **Spacing:** one space after `:` and `,`; one space between a tag and its `{`; none between a tag and its `(`. Empty containers are written `{}` and `[]`.
- **Keys** are bare when they can be, otherwise quoted.
- **Byte strings** keep their source spelling when a document is reformatted. When serializing values, they are written as lowercase hex without spaces, `x"0b34ff"`.
- **Strings** containing a line break are written as `"""` block strings. All other strings use `"…"` with the minimal escapes: `\"`, `\\`, `\n`, `\r`, `\t`, and `\u{…}` for control and bidi characters. In a block string, a quote followed by two more quotes is escaped.
- **Numbers and strings keep their source spelling** when a document is reformatted (`0xFF` stays `0xFF`). When serializing values with no source text, numbers are written in normalized form, except that integers longer than the number limit (§7) are written in hex.
- **Streams:** a file with more than one top-level item puts a comma after every item, with a blank line after each multi-line item. A single item is written without a comma.
- **Comments** are kept (they are part of the layout, not of the data model):
  - A comment on its own line stays above the entry that follows it.
  - A comment after an entry on the same line stays after that entry's comma.
  - Comments before a closing bracket stay at the end of the container.
  - A comment between a key and its value moves above the entry.
- **Blank lines** between entries (and between comments and entries) are kept, at most one.
- **Line endings:** LF, and the file ends with a line break.

### Compact

One item per line, still readable:

```haus
Person { name: "John Doe", age: 30, type: Engineer },
Person { name: "Jane Smith", age: 28, type: Designer },
```

- **Each top-level item is written on a single line,** with the same spacing as pretty (`{ a: 1 }`, `[1, 2]`, `Tag(a, b)`).
- **Strings never span lines:** multi-line text uses `\n` escapes, so a compact stream can be split by lines (like NDJSON) and is still valid haus.
- **Streams:** every item is followed by `,`.
- **Comments are dropped.**
- Encoders that write a stream item by item use compact by default.

Tools that cannot keep comments MUST refuse to format in the pretty layout rather than drop them.

## 12. Planned: canonical form

A canonical serialization, so that equal values (§2) produce identical bytes:
- no comments and no whitespace outside strings
- fields sorted by code point
- normalized number literals (§2)
- the shortest escaping for strings
- `Tag { … }` for single-record payloads

This enables hashing, deduplication and content addressing.

## 13. Prelude, standard modules and schema packages

Types come from four places:

| Tier | Contents | Rules about values | Bindings |
|---|---|---|---|
| **Prelude** ([`prelude.schema.haus`](prelude.schema.haus)) | the data model: `Bool`, `Maybe`, `Result`, `String`, `Bytes`, `Array a`, `Map v`, records, `Int`, `Int8`…`UInt64`, `Float32`, `Float64`, `Decimal` | built in (ranges of `Int8`…) | MUST support |
| **Standard modules** ([`std/`](std)) | [`std/time`](std/time.schema.haus) only | built in: the [std/time profile](std/time.md) | MUST support |
| **Official extensions** ([`../extensions`](../extensions)) | schema packages `@haus/…`, e.g. `@haus/money`, `@haus/geo` | none; profiles for codecs | MAY offer codecs |
| **Community packages** | schema packages of any other organisation | none | MAY offer codecs |

The prelude is always in scope. Everything else is imported:

```
import std/time (Date, Instant)     // a standard module
import @haus/money (Money)          // a schema package
import @haus/money@1 (Money)        // the same, asserting major version 1
import ./common (Address)           // a schema file next to this one (./common.schema.haus)
```

A domain goes in a module even when it is built in: the prelude reserves its names (§14), and `Time` or `Duration` are names schemas want for their own types.

### 13.1 Rules about values

**The schema language has no syntax for rules about values.** A schema describes structure (§9.10). The only rules about values are those of built-in types: the range of `UInt8`, the digits of a `Decimal`, the std/time profile. They are fixed by this specification, run in linear time, and mean the same in every implementation.

There are two conformance classes:

- A **parser** reads the syntax (§1–§8). It knows no types: `Date("2026-02-30")` and `Int8`-sized numbers are just a tag with a string and a number. A parser MUST NOT apply rules about values.
- A **schema binding** decodes values with a schema. It MUST support the prelude and every standard module completely, and MUST check their rules: `Int8(300)` and `Date("2026-02-30")` are errors. Applications MAY choose other host types for standard types (§13.4), but never change what is valid.

### 13.2 Standard modules

Standard modules ship with this specification and are versioned with it. A module only gains types; its rules never change (§10), so imports of standard modules carry no version.

- [`std/time`](std/time.schema.haus): `Date`, `Time`, `DateTime`, `Instant`, `ZonedDateTime`, `Duration`, `YearMonth`, `TimeZone`, the model of JavaScript's Temporal and java.time. Values are a tag around a string; the strings a schema binding accepts are defined by the [std/time profile](std/time.md), a strict subset of RFC 3339, RFC 9557 and ISO 8601. Nothing in it depends on a registry: zone names are checked for their syntax, never looked up.

A type belongs in a standard module only if it passes all three tests: the prelude can't express it (a plain string or number loses or blurs its meaning), nearly every domain needs it, and a fixed, published grammar defines it. Today only time passes. Money passes the second test only partly, and `Decimal` already prevents the loss of precision: it is the package `@haus/money`. Identifiers (UUIDs, ULIDs, …) lose nothing as strings. Units, currencies, countries and languages are registries that change.

Implementations SHOULD tell users of the former module `std/money` to import `@haus/money` instead.

### 13.3 Schema packages

A **schema package** is a directory with a manifest, `haus.package.haus`, next to its schema:

```
{ name: "@haus/money", version: "1.2.0", schema: "money.schema.haus" }
```

- `name` is `@organisation/name`. `@haus/` is reserved for the official extensions maintained with haus.
- `version` is a semantic version (below).
- Package schemas are ordinary schema files: shape only, like every schema. They change no syntax: `Money(19.99, EUR)` is valid haus with or without `@haus/money`.

**Resolution.** An implementation finds packages where its language's package manager puts them (`node_modules` for JavaScript, …) and relative files next to the importing file. Resolution happens when a schema is built, never while data is parsed, and never over the network (§9.2). The exact version and content hash are pinned by the application's package manager (its lock file), not by the schema.

- Where the package manager has scoped names (npm), `@org/name` resolves with its own name resolution, from the importing file. Elsewhere, an implementation looks only among the project's direct dependencies.
- The manifest's `name` MUST equal the imported name, and the package manager's name where it is scoped (npm `@haus/money` holds `@haus/money`).

**Distribution.** There is no haus registry. Authors publish schema packages however their users install dependencies: language registries (npm, crates.io, PyPI, …), private registries, git dependencies, workspaces, or copies in the project imported as relative files. Codec libraries for registries that reject git dependencies (crates.io, PyPI) can carry the schema text they target.

The reasons:

- Package managers already provide hosting, mirrors, lock files, hashes, authentication and private registries.
- A haus registry would be one more service to run and one more point of failure for every build.
- Types are identified by manifest names (`@haus/money@1#Money`), not by a registry, so a registry or a catalog can be added later without breaking anything; removing one could not be done the same way.

What this means for users:

- **Names are claims.** A manifest name doesn't prove who wrote a package: trust comes from the dependency the application chose to add. Scopes make names reliable on npm, and less so on registries with unscoped names. `@haus/` is reserved by convention; on npm the `@haus` scope enforces it. Organisations SHOULD use a name they own: their domain or their code hosting organisation.
- **No install scripts.** A schema package is data and MUST NOT need code to install, such as npm `postinstall`. Codecs are code, and are trusted like any other library.
- **Copies in several languages.** A package published to several registries SHOULD be published from one source, so that equal versions have equal files.
- **Discovery.** There is no index. The official extensions are listed in [`../extensions`](../extensions).

**Identity.** Every named type has an id, the same in every language: `@haus/money@1#Money` is the type `Money` of the package `@haus/money`, major version 1. Other files of a package are `@haus/money@1/path#Type`. Files outside a package get an id from the binding (the JavaScript binding uses the nearest `package.json` name and the file's path). Codecs (§13.4) and tools refer to types by their id.

**Imports.** `import M (A, B)` makes the types `A` and `B` defined in `M` available under their names; a file can't re-export types it imports. Implementations MUST reject:

- a module that can't be found, or a type it doesn't define;
- a name imported twice, or imported and also defined;
- two different files with the same id in one schema, such as two copies of `@acme/ids@3` found in different places, or two packages that both call themselves `@acme/ids`;
- `@org/name@N` when the package found has another major version;
- import cycles: a file that imports itself, directly or not.

Errors inside an imported file are reported at the import, with their place in that file.

**Versions.** A package's version says what a change does to data:

| Version | Allowed changes | Guarantee |
|---|---|---|
| major | removing or renaming types, fields or tags; changing a field's type; making a type `closed` | none |
| minor | new types; new optional fields in open records; new tags in open variants | data valid before stays valid and decodes to the same shape |
| patch | comments and documentation | nothing changes |

An import names at most a major version. A minimum minor version would be redundant: the types it imports already fail against an older package that lacks them.

**Profiles.** A package MAY define profiles: rules beyond its shape that codecs can implement, named like `@haus/money/iso`. A profile is defined by test vectors (`profiles/<name>.vectors.haus`): values a codec implementing it accepts, values it rejects, and values that encode back to the same text. Profiles are how the official extensions say what "valid money" means without putting rules into the schema language.

### 13.4 Codecs

A schema binding MAY let applications choose the host type of a named type without arguments: a **codec**, selected by the type's id. A codec:

- runs after the type's schema: it can reject more values, never fewer;
- encodes back to the type's values, so that encoding what it decoded gives an equal value;
- never changes the data: the same text means the same thing with and without it.

Codecs are part of the application, not of the schema. Two applications reading the same file with different codecs agree on what the file says, and may disagree only on what they accept. A codec for a standard type changes the host type only (§13.1).

## 14. Schema files

A schema file (`.schema.haus`, grammar in [`grammar.ebnf`](grammar.ebnf)) is a list of imports (§13) and type definitions.

**Open by default.** Records and variants are open: a reader ignores fields the schema doesn't list (they are not part of the decoded value) and decodes tags it doesn't list as an *unknown* value that keeps the raw data. Writers can add fields and tags without breaking older readers. `closed { … }` and `closed < … >` forbid anything not listed. `< >` is a variant with any tags.

Tools that check a file against its schema (editors, `haus check`) MUST report what a closed type forbids as an error, and SHOULD mark fields and tags an open type doesn't list as a hint ("not in the schema"), without failing the check.

**Spreads.** `...Name` copies the tags of the named variant into a variant, or the fields of the named record into a record, at the place where it is written. Whether the result is open or closed is decided by its own `closed` alone, never by the type it copies from:

```
type UserEvent = < UserCreated { id: Int } | UserRenamed { id: Int, to: String } >
type AppEvent = closed < ...UserEvent | Heartbeat >   // exactly these three tags
type ServerEvent = < ...UserEvent >                   // the user events; other tags become Unknown

type Base = { id: Int, createdAt: Instant }
type Person = closed { ...Base, name: String }
```

Only a named type without parameters can be spread; to reuse a structure with a part left open, use a type parameter (`type Envelope e = { id: String, event: e }`). There are no row parameters: `...r` is reserved and MUST be rejected.

Implementations MUST reject:

- unknown types, types used with the wrong number of arguments, types defined twice, and redefinitions of prelude types;
- duplicate fields in a record and duplicate tags in a variant, also those copied in by a spread;
- `closed < >`;
- a spread of something other than a named variant (in a variant) or a named record (in a record), of a type with parameters, or of a `Stream`;
- a type that spreads itself, directly or through other types (`type A = < ...B >`, `type B = < ...A >`);
- `...r`: row parameters are not part of the language;
- recursion that doesn't pass through a record field, array element or variant payload (`type A = B`, `type B = A`), §9.9;
- a generic type that refers to itself with arguments other than its own parameters, §9.10;
- `Stream a` anywhere but as the whole type of a definition, and references to such a definition;
- the import errors of §13.3.

**Which schema describes a file.** A data file `x.haus` is described by the type `Root` of the schema file `x.schema.haus` next to it. A comment on the first lines of the data file names another one: `// schema: ./order.schema.haus` or `// schema: ./api.schema.haus#Order` (a type other than `Root`). The comment is for tools; parsers ignore it, and it never changes what the data means (§9.2).
