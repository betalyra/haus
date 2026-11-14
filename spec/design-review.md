# haus design review

Date: 2026-11-07 (status updated 2026-11-13) · Scope: spec draft 0.1 (`spec/`), TypeScript packages, Effect adapter, Rust, Roc and Python packages, the Lean model (`spec/lean/`).

**Status legend:** ✅ done · 🟡 partly done · ⬜ open · — decided not to change

## Verdict

The core idea holds up. haus fixes JSON's real pain points: comments, trailing commas, unquoted keys, exact numbers, sum types, and streaming. It does so without adding the features that made YAML and XML dangerous: references, includes, remote schemas, executable tags. The grammar is small and strict. Four parsers (TypeScript, Rust, Roc, Python) and their stream readers agree on a shared conformance suite and on millions of generated inputs, checked against a reference parser in Lean that is proven to accept exactly the grammar (`spec/lean/`). The Lean model also proves the security properties of every valid file, that the canonical form parses back and is unique, that the stream reader gives the same result however the input is split, and that the std/time calendar is right with one spelling per value.

The weak spots were in four areas:
1. **Resource limits** were not specified, and the Roc parser could be stalled.
2. **A few syntax rules** could silently change meaning.
3. **Missing pieces:** there was no serializer and no canonical form; there is still no CLI or JSON converter.
4. **Some semantics were undefined:** equality, the position units in error messages, and stream termination.

The security and spec issues are fixed (§1, §2), apart from a few open details marked 🟡. What's left is mostly new functionality (§3).

---

## 1. Security

### 1.1 What the design already gets right

| Property | Why it matters |
|---|---|
| No references, anchors, merges or includes | Rules out YAML's "billion laughs" expansion and any reading of local files |
| Schemas are owned by the reader and never fetched remotely | Nothing like XML's external entities (XXE) or JSON Schema's `$ref` fetching, so the parser never makes network requests |
| Tags are data, not type names | Unlike YAML's `!!python/object`, parsing never instantiates classes. Bindings must keep it that way (spec §9) |
| Strict UTF-8, no lone surrogates, no raw control characters in strings | Prevents encoding-confusion attacks |
| Duplicate keys rejected | JSON leaves duplicates undefined. Parsers that pick different duplicates have caused real exploits |
| Nesting depth limit (256) | Prevents stack exhaustion |
| No `NaN` or `Infinity` literals, no leading zeros, no `+1`, no `.5` | One spelling per number, which reduces differences between parsers |

### 1.2 Findings

| | # | Finding | Resolution |
|---|---|---|---|
| ✅ | S1 | **Field smuggling via `__proto__` in the Effect adapter.** `{ "__proto__": { role: "admin" } }` decoded to `role = "admin"`. | Properties are set with `defineProperty`, with a regression test. `h.Record` was hardened the same way. Spec §9.4. |
| ✅ | S2 | **Duplicate-key check in the Roc parser took quadratic time.** 20,000 fields took 35 s. | Uses a `Set`; 20,000 fields now take 0.15 s. Spec §7 requires linear time. |
| ✅ | S3 | **Converting hex and binary literals took quadratic time** (Roc: 20,000 digits took 4 s). | Literals are capped at 1000 characters before conversion. The longest allowed hex literal takes 0.08 s in Roc. |
| 🟡 | S4 | **No configurable limits.** | Spec §7 defines limits and defaults: depth, number length, exponent, string length, and the size of one stream value. TypeScript, Rust and Python: limits can be set per call, and the stream readers take a maximum value length. **Open:** Roc's parser uses fixed defaults that can't be configured yet (its stream reader's value length can), and there are no limits on fields per record or items per array (memory is still bounded by the input size). |
| ✅ | S5 | **Huge exponents reach decoders** (`1e999999999`). | Exponents are capped at ±6144 in both parsers. Spec §3 and §7. |
| ✅ | S6 | **A cut-off stream looks valid.** | Every stream reader (TypeScript, Rust, Roc, Python) has a strict mode (`requireTerminator` / `require_terminator`) that reports a stream ending without a comma after its last value. Spec §6. There's no end-of-stream marker (decided against one). |
| 🟡 | S7 | **Unicode spoofing.** | Raw bidi controls are rejected everywhere (strings, block strings, comments) in both parsers, with 6 conformance tests, and VS Code highlights them as invalid. The spec says keys are compared by code point with no normalization, and notes the risk of NUL characters. **Open:** a linter for lookalike characters and mixed NFC/NFD keys. |
| ✅ | S8 | **Error positions differed between parsers** (UTF-16 vs code points). | Both now count code points. Spec §8. |
| ✅ | S9 | **No canonical form**, so values can't be hashed or signed. | Spec §12 defines the canonical form, `equals` and a SHA-256 `hash`, the same in every binding. Implemented in TypeScript, Rust (`hash` behind the `hash` feature), Python and Roc (no `hash` yet: no SHA-256 in its standard library), with `compare` for a total order. A Lean reference encoder is proven to round-trip (`parse_canonical`) and to give identical text exactly for equal values (`canonical_eq_iff`); all bindings agree with it on the suite's `.canonical` files and in differential fuzzing. **Open:** `hash` in Roc. |
| ✅ | S10 | **Work that grows faster than the input.** Probing with hostile inputs found: schema inference printing was exponential in nesting depth (depth 20 took 0.8 s, so a small file could hang the editor); formatting with comments was quadratic (8,000 commented entries took 1.4 s); a large stream value arriving in small chunks was quadratic; Effect's union decoding is exponential for recursive unions of untagged structs. | All linear now (depth 250 infers in 3 ms, 8,000 comments format in 22 ms, chunked values scale linearly). The Effect adapter rejects recursive schemas with ambiguous unions up front. Inference now recognises recursive data (a tag inside the same tag, or a record inside one with the same keys) and prints a named type (`type Comment = …`) instead of unrolling it; shapes are merged with union-find, so unification is linear too. Regression tests in `adversarial.test.ts` (core and Effect). |
| ✅ | S11 | **Schema decoding had no bound beyond the parser's limits**, and values built in code (deep, shared or cyclic) weren't checked at all. | Spec §9.8–10. `h.*` and the Effect adapter enforce depth, a work budget (16 steps per input value; 16 Mi steps when encoding), cycle detection on encode and checks on raw `Unknown` values. Recursion is opt-in via `h.Recursive` with its own depth limit (64) and a check for unguarded cycles. Error paths are built only when an error occurs. **Open:** Effect's own encoder runs before ours and has no budget, so a JS value with heavy sharing still costs time there; Roc decoders are plain functions without a budget. |
| ✅ | S12 | **Raw control characters in comments and strings.** Comments allowed ESC and NUL, strings DEL and C1 (U+0080–U+009F, including CSI). A comment like `// \e[2K\e[1Aaccess: Admin` rewrites what `cat` shows in a terminal, while the data says something else. Found while proving the character properties in Lean. | Raw C0 (except tab and line breaks), DEL and C1 are rejected everywhere, in all four parsers, and every writer escapes them. Spec §4 and `grammar.ebnf`, 10 conformance cases, proven for the grammar in `spec/lean/Haus/Props/Chars.lean`. |
| ✅ | S13 | **The Rust stream reader crashed on a stream ending in `/`.** At the end of input it read one byte past its buffer: a panic, so a denial of service for anything reading streams from the network. | Found by differential testing (`fuzz/`), shrunk to the one-byte input `/`. Fixed, with a regression test. TypeScript and Roc were not affected. |
| ✅ | S14 | **Stream readers accepted a byte order mark after every comma**, and TypeScript's `parseStream` skipped two at the start. Whole-file parsing rejects both, so the same bytes meant different things streamed and unstreamed. All three bindings had it, so they agreed with each other. | Found by comparing each stream reader with whole-file parsing (`fuzz/`). A BOM is now skipped only at the start of the input, in all three. Regression tests in each binding. |
| ✅ | S15 | **Roc's std/time check accepted huge durations.** Duration components were compared as floats, and a number too long to parse as one (over ~309 digits) counted as 0, so `P999…9Y` passed the 2³² limit. | Found while writing the Lean model of std/time; exact integer arithmetic now. Regression tests in all three bindings, and `fuzz/src/time.ts` fuzzes every binding's std/time check against the model (it finds this bug in the old code). |
| ✅ | S16 | **A rule only in the code.** All bindings rejected zone names over 255 characters, but `std/time.md` didn't say so. | Added to `std/time.md`, and to the Lean model, which proves zone names can't leave the tz database when looked up as files. |
| ✅ | S17 | **Rust's stream reader was quadratic in the values per chunk** (against §7: linear time). After each value it removed that value's bytes from the front of its buffer, moving everything after it. 10 MB pushed as one chunk took 63 s. Neither the fuzzer nor the Lean proofs measure time. | The reader now removes the bytes of returned values once per chunk: 0.3 s. TypeScript and Roc were measured and are linear. Regression test with 200,000 values in one chunk; the benchmark plan covers stream readers with large chunks. |
| ✅ | S18 | **Stream readers reported columns one too small after a byte order mark.** The TypeScript, Rust and Roc stream readers skipped a BOM at the start and didn't count it, so every error on line 1 was a column early (`\uFEFF{ ok: true }`: 1:7 streamed, 1:8 parsed whole). The whole-file parsers, the Lean model and Python's stream reader count the BOM as column 1. All three readers had it, so they agreed with each other. | Found by differential fuzzing of Python's stream reader (`fuzz/` only reports position differences for information, not as failures). Fixed in all three. Regression tests in each binding; TypeScript and Rust also compare stream and whole-file error positions for every invalid suite file with a BOM in front. |
| ✅ | S19 | **`Int` was bounded in two bindings, and schemaless integer types depended on the data.** The prelude says `Int` is an integer of any size, but TypeScript decoded it to a `number` (failing beyond 2⁵³) and Roc to an `I128` (failing beyond 2¹²⁷). Without a schema, TypeScript chose `number` for a field unless one of its integers was too large, then `bigint`: the type depended on the document, which a stream reader can't know in advance. | `Int` is now an integer of any size in every binding: `bigint` in TypeScript, `haus::Int` in Rust (with `num-bigint` conversions behind the `bigint` feature), `Int` in Roc (exact digits, `to_i64`/`to_i128` fail when out of range). For a native integer the schema says `Int32`, `Int64`, …. Without a schema every integer is a big integer (spec §3). Tests in every binding decode an integer above 2¹²⁸ and write it back unchanged. |

### 1.3 Rules for binding authors

✅ Now spec §9 ("Security considerations"): tags are data, no remote resolution, enforce limits while parsing, keys never reach prototypes or internal fields, unknown variants are untrusted, fail on the first error, how to sign.

---

## 2. Design flaws and sharp edges

| | # | Issue | Resolution |
|---|---|---|---|
| ✅ | D1 | **The payload bound across line breaks**, so a forgotten comma silently created a payload. | A payload must start on the same line as its tag (only spaces and tabs in between). Changed in the grammar, both parsers and the suite, with 3 new invalid cases. |
| ✅ | D2 | **Positional payloads were mapped to named fields by order** (Effect adapter). | Opt-in via `Haus.Positional(…)`. Without it, the error suggests the named form. Spec §5. (`h.Tuple` and Roc decoders were already explicit.) |
| ✅ | D3 | **"Field absent" and `None` were conflated**, so PATCH updates couldn't be expressed. A first fix (a `Patch a = < Keep \| Set a >` field type, with "missing" read as `Keep`) brought back JSON's problem: two spellings of "nothing" whose meaning depends on the reader. | Two separate concepts, each with one spelling (spec §1): optional fields (`x?: T`, may be missing, never `None`) and `Maybe` (an ordinary variant, always written). `x?: Maybe T` gives the three states of a partial update. `Patch` was removed. TypeScript: `h.Optional`, `h.Maybe` (`None` → `null`); Effect: `optionalKey` / `Option`, never converted into each other; Roc: `Decode.optional_field` → `[Missing, Present a]`. Inference prints `x?: T` for fields only some records have. All tested. |
| ✅ | D4 | **Maps, sets, bytes and the size of the prelude.** The old `Map([(k, v)])` example wasn't even valid haus (no untagged tuples), `Set` couldn't be unordered as an array, and the prelude had grown to time, money, UUID and base64 bytes. | Prelude cut down to `Bool`, `Maybe`, `Result` and built-in types (spec §13). `Map v` is a record used as a dictionary (`h.Map`); non-string keys are written `[Entry(k, v), …]`; `Set` was dropped. Time and money moved to standard modules (`std/time`, `std/money`); UUID was dropped. Bytes became a data kind, `x"0b34ff"`, in both parsers, the formatter, `h.Bytes`, Effect (`Uint8Array`), Roc (`Decode.bytes`) and the editor, with 8 conformance files. **Open:** a separate syntax for unordered sets and maps (`#{ }`), if it turns out to be needed. |
| ✅ | D5 | **No `NaN` or `±Infinity`.** | Prelude tags `NaN`, `Infinity`, `NegInfinity`, accepted by `h.Float64` and by Effect's `Schema.Number`. |
| ✅ | D6 | **Equality undefined.** | Spec §2. Scale and notation are part of a number's value (`1.0 ≠ 1`); numeric equality is left to the schema. |
| — | D7 | **Keys must start lowercase, and tags are ASCII-only.** | Kept as a deliberate trade-off. The JSON converter (§3) must quote such keys automatically. |
| ✅ | D8 | **`Tag({…})` and `Tag {…}` are the same value.** | Stated in the grammar and spec §2. |
| ✅ | D9 | **No format version.** | Spec §10: new syntax must be an error in older versions; no version header. |
| — | D10 | **Single document vs stream.** | No change needed (spec §6). |

Ecosystem gotchas, documented in the examples:
- Effect's `DateTimeUtcFromString` accepts `2026-02-30` and rolls it over to March 2.
- Effect's `BigDecimal.format` drops the scale, printing `7.90` as `7.9`.

---

## 3. Missing pieces

### 3.1 Must have before anyone else uses it

| | Item | Notes |
|---|---|---|
| ✅ | **Serializer** | `format` / `stringify` (standard layout, spec §11), comments and blank lines kept, round-trip and idempotence tested on every conformance file; Format Document in VS Code. Schema-aware encoding: `h.stringify` / `h.encodeStream`, Effect `Haus.encode` / `Haus.encodeStream`, Rust `to_string`, Roc `Encode` (compact layout). |
| 🟡 | **Limits API and spec defaults** | See S4. Configurable limits in Roc are still open. |
| ✅ | **Spec prose** | [`README.md`](README.md), draft 0.1: data model, equality, numbers, Unicode, variants, streams, limits, error positions, security, evolution, canonical form and hashing, the prelude and standard modules; schema files (§14) and decoding with a schema (§15); the std/time profile in [`std/time.md`](std/time.md). Schema conformance suite in [`../test-suite/schema`](../test-suite/schema): TypeScript, Effect, Rust and Roc pass it (Effect with two documented lossy mappings, §13.4). |
| ✅ | **Conformance suite expansion** | Added: limits at and just past the boundary, bidi controls, control characters, line breaks, byte order marks, exponents, the D1 cases, Unicode edges (NFC and NFD keys are different keys, `\u{0}`, U+10FFFF, an escaped and a raw spelling of the same key are duplicates): now 119 files, 28 valid and 91 invalid, each valid file with its expected canonical form. Differential fuzzing of all parsers, stream readers, canonical forms and std/time checks runs in CI (`fuzz/`). |

### 3.2 Should have

| | Item |
|---|---|
| ✅ | **Canonical form** for hashing, signing and deduplication: spec §12, in every binding, proven in Lean (S9). Features built on it are planned in [`plans/canonical-form.md`](../plans/canonical-form.md). |
| ⬜ | **Schema language** spec, parser and checker: spreads (`...Name`, replacing row parameters), open vs closed, `Stream`, generics. Rules for recursion and expressiveness are settled (spec §9.9–10): explicit, guarded, regular recursion and no computation in schemas. |
| ⬜ | **JSON interop:** a mapping both ways, `from-json` / `to-json`, and the `application/haus` MIME type. |
| ⬜ | **CLI:** `check`, `fmt`, `convert`, `canonical`, `hash`, and a jq-like `query` using the path syntax from error messages. |
| ✅ | **A parser that keeps comments and formatting**: `parseDocument` records comment and value positions; the formatter places comments and blank lines. |

### 3.3 Later

| | Item |
|---|---|
| 🟡 | Language server: done (diagnostics, outline, hover with inferred types, formatting, schema inference). Tree-sitter: open |
| ⬜ | Code generation from `.schema.haus` (Roc, Go, Swift, …) |
| ⬜ | A binary encoding of the same data model |
| ✅ | Streaming in Roc (`Stream`), and in Python |
| ⬜ | Python: std/time checks and schema decoding |

---

## 4. Use cases

| | Use case | Status / gap |
|---|---|---|
| ✅ | Config files | Comments, trailing commas, block strings, exact numbers, and a formatter that keeps comments. |
| 🟡 | API payloads | Sum types, exact money, open variants, schema-aware encoding and decoding. Missing: a MIME type. |
| ✅ | Event streams and logs | Comma-terminated values, open variants, size limit per value, truncation detection, in every binding. |
| ✅ | Partial updates (PATCH) | A record of optional fields: send only what changes; `x?: Maybe T` can also clear (D3, spec §1.1). |
| ✅ | Signed or hashed documents | Sign the exact bytes, or the canonical form (spec §12): `hash` in TypeScript, Rust and Python. A signing convention is planned (`plans/canonical-form.md`, F5). |
| 🟡 | Tabular data | Works, but repeats every key. Acceptable with compression. |
| 🟡 | Scientific and ML numbers | `NaN`/`Infinity` done (D5). Large numeric arrays are inefficient as text. |
| 🟡 | Binary blobs | `x"…"` byte strings, in hex: readable, but twice the size of the bytes. Fine for small blobs. |
| — | Graphs, shared references | Excluded by design (security). Use ids. |
| ✅ | Dictionaries, binary data | `Map v` over records, bytes as `x"…"` (D4). |

---

## 5. Remaining order

1. JSON interop and a CLI.
2. **Planned, not started:** a hash for a whole stream, `hashStream(values)` in §12. It is the SHA-256 of each value's canonical form followed by `,` (`1,"a",Order{id:255},`), so it can't collide with `hash` of one value or of an array. Includes conformance vectors and all bindings. Details await Jan's approval.
3. Configurable limits in Roc; std/time checks and schema decoding in Python.
4. Temporal codecs in TypeScript (once TypeScript ships Temporal types).
5. Schema language parser and checker, then code generation, LSP and Tree-sitter.
