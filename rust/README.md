# haus for Rust

| Crate | What it is |
|---|---|
| [`haus-fmt`](haus) | Imported as `haus`. Parser, data model (`haus::Value`), `Decode`/`Encode`, std/time, codecs, compact writer. Passes the [conformance suite](../test-suite). |
| [`haus-build`](haus-build) | Rust types from `.schema.haus` files, generated in `build.rs`. Also `haus-gen`, which generates the Roc modules. |
| [`haus-build-tests`](haus-build-tests) | Tests of the generated code. |
| [`haus-money`, `haus-geo`](../extensions) | The official schema packages, as crates. |

## Examples

The same examples as in TypeScript, on the same files in [`../examples`](../examples).
Run them from this folder; each one's `build.rs` generates its Rust types from the schema first:

```sh
cargo run -p haus-example-quickstart   # thread.haus: typed data, decode, encode, errors
cargo run -p haus-example-order        # order.haus: schema packages and codecs
cargo run -p haus-example-logs         # logs.haus: read and write a stream, entry by entry
```

In VS Code, rust-analyzer needs the build scripts to have run. If it reports
`OUT_DIR not set`, run "rust-analyzer: Rebuild build dependencies".

## Use

```rust
// build.rs
haus_build::Config::new()
    .codec("std/time#Date", "crate::codecs::JiffDate")   // optional: your Rust type for a haus type
    .compile("src/order.schema.haus")?;

// src/main.rs
mod order { haus::include_schema!("order"); }
let order: order::Root = haus::from_str(&text)?;          // checks every rule of the schema
let text = haus::to_string(&order)?;                      // back to haus (compact)
```

| haus | Rust |
|---|---|
| `{ a: T, b?: U }` | `struct { a: T, b: Option<U> }` |
| `< A \| B T \| C { … } >` | `enum { A, B(T), C { … }, Unknown(haus::Unknown) }` (open), without `Unknown` when closed |
| `closed < Tag T U >` | `struct Tag(T, U)` |
| `Maybe a`, `Result e a`, `Array a`, `Map v` | `Option<A>`, `Result<A, E>`, `Vec<A>`, `BTreeMap<String, V>` |
| `Int`, `Decimal`, `Int8`…`UInt64`, `Float64` | `haus::Int`, `haus::Decimal` (exact text), `i8`…`u64`, `f64` |
| `Date`, `Instant`, … (std/time) | `haus::time::Date`, … (validated text; codecs map them to `jiff` and others) |
| `Any` | `haus::Value`: any value, as parsed |
| `Secret a` | `haus::Secret<A>`: `Debug` and `Display` print `<redacted>`; `expose()` / `into_inner()` give the value |
| `@deprecated("why")` on a type, field or tag | `#[deprecated(note = "why")]` |

A `Secret` is written in full when encoded (the receiver needs it), but a
decode error inside it names only its place and type
(`.password: not a valid Secret String (the value is hidden)`), never the value.
The generated code allows its own use of deprecated items, so a crate gets
deprecation warnings only where it touches them. Attributes haus doesn't
define (`@since`) are accepted and reported as Cargo warnings, as are uses of
deprecated types in a schema; `Config::quiet()` turns them off.

Writing checks what it writes, so `haus::to_string` returns a `Result`. A
value of the generated types is always valid; what can fail is a `haus::Value`
built in code, the raw value of an `Any` or an unknown variant (spec §9.8):
`Value::Number("abc".into())` is an `EncodeError` (`.extra: not a number
literal`), as are a tag that isn't a tag name, a key used twice in a record,
and nesting, strings and numbers beyond the limits. Number literals are
written as the parser reads them (`1E5` as `1e5`). For a reader with other
limits, `haus::to_string_with(&value, &limits)` checks those, and writes an
integer longer than its number limit in hex so that it parses again.

`haus::Int` is an integer of any size, kept as its digits and written back
unchanged. `to_i64()` / `to_i128()` give it as a native integer when it fits; the
`bigint` feature adds conversions to and from `num_bigint::BigInt`. For a native
integer that must fit, the schema says `Int64` (out of range is a decode error).

Schema packages are ordinary dependencies: a crate with `haus.package.haus`,
`links = "<its name>"` and `haus_build::package()` in its build script. A crate
that depends on it directly can `import @org/name (…)`; the types are the
package crate's own (`haus_money::Money`), so codecs written for them work in
every crate.

Streams (spec §6) are read as the values arrive: `haus::stream::decode::<T, _>(reader)`
is an iterator over any `std::io::Read`, and `haus::stream::encode` writes one value per
line (`encode_with` for other limits). `haus::stream::Reader` does no I/O itself (push byte chunks, split anywhere, get
the completed values), so an async adapter is a short loop around it.

Without a schema, `haus::parse` reads any haus text into `Value`s: a parser in
the sense of spec §13.1, which knows no types.

```sh
cargo test                                                   # everything, with the conformance suite
cargo run -p haus --example errors -- ../test-suite/invalid/*.haus   # print each syntax error
```
