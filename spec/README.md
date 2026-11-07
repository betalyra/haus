# haus specification — draft 0.2

The syntax is defined in [`grammar.ebnf`](grammar.ebnf). This document defines
what the syntax means and the rules every implementation must follow. The
standard types are in [`prelude.schema.haus`](prelude.schema.haus), and
[`../test-suite`](../test-suite) holds the conformance tests.

"MUST", "SHOULD" and "MAY" are used as in RFC 2119.

## 1. Data model

A **value** is one of:

| Kind | Example | Notes |
|---|---|---|
| number | `19.90`, `-1e10`, `0xFF` | exact decimal, see §3 |
| string | `"text"`, `"""…"""` | a sequence of Unicode code points, see §4 |
| array | `[1, 2]` | ordered |
| record | `{ id: 1, "x-y": 2 }` | string keys, no duplicates |
| variant | `None`, `Some(1)`, `Circle { r: 1 }` | a tag plus zero or more argument values |

There is no `null` and there are no booleans in the syntax. `True`, `False` and
`None` are ordinary tags whose meaning is fixed by the prelude.

A **file** is a sequence of zero or more values separated by commas (§6). A
single document is a sequence of one.

**Absence is not a value.** A record either contains a field or it doesn't.
`{ }` and `{ x: None }` are different values. How a reader treats a missing
field is decided by the field's schema type: for `Maybe a` it means `None`,
for `Patch a` it means `Keep`, and for any other type it is an error. The
parser itself never invents values for absent fields.

## 2. Equality

Two values are equal when they have the same kind and:

- **numbers:** the normalized literals are equal. Normalizing removes digit separators, writes the exponent marker as `e`, and converts hex and binary literals to decimal integers. So `1_000` = `1000` and `0xFF` = `255`, but `1.0` ≠ `1` and `1e2` ≠ `100`: scale and notation are part of the value. Numeric equality ("is 1.0 the same amount as 1?") belongs to the schema or the application.
- **strings:** the code point sequences are identical. There is no Unicode normalization (§4).
- **arrays:** the same length, and the elements are pairwise equal.
- **records:** the same set of keys, and the values for each key are equal. Field order doesn't matter.
- **variants:** the same tag, and the arguments are pairwise equal. `Tag { … }` and `Tag({ … })` are the same value.

## 3. Numbers

- **Precision:** a number literal denotes an exact decimal. Parsers MUST keep it without loss, e.g. as the normalized literal text. Converting it to a binary float is a decoding decision made by the schema (`Float64`), never by the parser.
- **NaN and infinities:** there are no `NaN` or infinity literals. The prelude tags `NaN`, `Infinity` and `NegInfinity` are accepted where the schema says `Float32` or `Float64`.
- **Limits:** a number literal is at most 1000 characters, and its exponent at most ±6144 (§7).

## 4. Strings and Unicode

- **Encoding:** input is UTF-8. Invalid UTF-8 MUST be rejected. A leading byte order mark is ignored.
- **Escapes:** `\"`, `\\`, `\n`, `\r`, `\t` and `\u{1–6 hex digits}`. A `\u{…}` escape MUST denote a Unicode scalar value, so surrogates are rejected.
- **Raw control characters:** raw characters U+0000–U+001F MUST NOT appear in `"…"` strings. Block strings allow tab, LF and CR LF.
- **Bidirectional controls:** the raw characters U+202A–U+202E and U+2066–U+2069 MUST NOT appear anywhere in the input, including strings, block strings and comments. They can make source text display differently from what is parsed ("Trojan Source"). Inside strings, write them as escapes, e.g. `\u{202E}`.
- **Key comparison:** keys are compared by code point, with **no normalization**. `"café"` (NFC) and `"café"` (NFD) are different keys. Producers that need normalized keys must normalize before writing.
- **NUL characters:** `\u{0}` is allowed. Consumers that pass strings to C APIs must handle embedded NUL characters.
- **Identifiers:** bare keys and tags are ASCII (`[a-z_][A-Za-z0-9_]*` for keys, `[A-Z][A-Za-z0-9_]*` for tags). Any other key must be quoted.

## 5. Variants

- **Payload placement:** a variant's payload MUST start on the same line as its tag; only spaces and tabs may come between them. `Circle { r: 1 }` and `Point (1, 2)` are valid. A line break or comment between the tag and its payload is an error, because a forgotten comma could otherwise silently change the meaning.
- **Positional arguments:** `Point(1, 2)` has two positional arguments. A decoder that maps them to named fields MUST do so only where the schema declares the payload positional (for example `< Point Number Number >`, `h.Tuple`, or `Haus.Positional` in the Effect adapter). Otherwise reordering schema fields would silently swap values.

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
| characters in one string | 16 Mi (16,777,216) |
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

## 10. Evolution

There is no version header. Any syntax added later MUST be a syntax error in every earlier version, so an old parser fails loudly instead of misreading newer data. Changes in meaning that leave the syntax unchanged are not allowed.

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
