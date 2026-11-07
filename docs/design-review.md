# haus design review

Date: 2026-11-07 (status updated the same day) · Scope: spec draft 0.1, now 0.2 (`spec/`), TypeScript packages, Effect adapter, Roc package.

**Status legend:** ✅ done · 🟡 partly done · ⬜ open · — decided not to change

## Verdict

The core idea holds up. haus fixes JSON's real pain points: comments, trailing commas, unquoted keys, exact numbers, sum types, and streaming. It does so without adding the features that made YAML and XML dangerous: references, includes, remote schemas, executable tags. The grammar is small and strict, and two independent parsers agree on a shared conformance suite.

The weak spots were in four areas:
1. **Resource limits** were not specified, and the Roc parser could be stalled.
2. **A few syntax rules** could silently change meaning.
3. **Missing pieces:** there is no serializer, no canonical form, and no schema parser.
4. **Some semantics were undefined:** equality, the position units in error messages, and stream termination.

The security and spec issues are now fixed (§1, §2). What's left is mostly new functionality (§3).

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
| 🟡 | S4 | **No configurable limits.** | Spec §7 defines limits and defaults: depth, number length, exponent, string length, and the size of one stream value. TypeScript: `Limits` can be set per call, and `StreamReader` / `parseStream` take `maxValueLength`. **Open:** Roc uses fixed defaults that can't be configured yet, and there are no limits on fields per record or items per array (memory is still bounded by the input size). |
| ✅ | S5 | **Huge exponents reach decoders** (`1e999999999`). | Exponents are capped at ±6144 in both parsers. Spec §3 and §7. |
| 🟡 | S6 | **A cut-off stream looks valid.** | TypeScript has a `requireTerminator` option that reports a truncated stream. Spec §6. **Open:** the Roc parser can't stream yet, and there's no end-of-stream marker (decided against one for now). |
| 🟡 | S7 | **Unicode spoofing.** | Raw bidi controls are rejected everywhere (strings, block strings, comments) in both parsers, with 6 conformance tests, and VS Code highlights them as invalid. The spec says keys are compared by code point with no normalization, and notes the risk of NUL characters. **Open:** a linter for lookalike characters and mixed NFC/NFD keys. |
| ✅ | S8 | **Error positions differed between parsers** (UTF-16 vs code points). | Both now count code points. Spec §8. |
| ⬜ | S9 | **No canonical form**, so values can't be hashed or signed. | Spec §9.7 says to sign the exact bytes. The canonical form is planned (spec §11) and needs the serializer. |
| ✅ | S10 | **Work that grows faster than the input.** Probing with hostile inputs found: schema inference printing was exponential in nesting depth (depth 20 took 0.8 s, so a small file could hang the editor); formatting with comments was quadratic (8,000 commented entries took 1.4 s); a large stream value arriving in small chunks was quadratic; Effect's union decoding is exponential for recursive unions of untagged structs. | All linear now (depth 250 infers in 3 ms, 8,000 comments format in 22 ms, chunked values scale linearly). The Effect adapter rejects recursive schemas with ambiguous unions up front. Inference now recognises recursive data (a tag inside the same tag, or a record inside one with the same keys) and prints a named type (`type Comment = …`) instead of unrolling it; shapes are merged with union-find, so unification is linear too. Regression tests in `adversarial.test.ts` (core and Effect). |
| ✅ | S11 | **Schema decoding had no bound beyond the parser's limits**, and values built in code (deep, shared or cyclic) weren't checked at all. | Spec §9.8–10. `h.*` and the Effect adapter enforce depth, a work budget (16 steps per input value; 16 Mi steps when encoding), cycle detection on encode and checks on raw `Unknown` values. Recursion is opt-in via `h.Recursive` with its own depth limit (64) and a check for unguarded cycles. Error paths are built only when an error occurs. **Open:** Effect's own encoder runs before ours and has no budget, so a JS value with heavy sharing still costs time there; Roc decoders are plain functions without a budget. |

### 1.3 Rules for binding authors

✅ Now spec §9 ("Security considerations"): tags are data, no remote resolution, enforce limits while parsing, keys never reach prototypes or internal fields, unknown variants are untrusted, fail on the first error, how to sign.

---

## 2. Design flaws and sharp edges

| | # | Issue | Resolution |
|---|---|---|---|
| ✅ | D1 | **The payload bound across line breaks**, so a forgotten comma silently created a payload. | A payload must start on the same line as its tag (only spaces and tabs in between). Changed in the grammar, both parsers and the suite, with 3 new invalid cases. |
| ✅ | D2 | **Positional payloads were mapped to named fields by order** (Effect adapter). | Opt-in via `Haus.Positional(…)`. Without it, the error suggests the named form. Spec §5. (`h.Tuple` and Roc decoders were already explicit.) |
| ✅ | D3 | **"Field absent" and `None` were conflated**, so PATCH updates couldn't be expressed. | Absence is not a value (spec §1). Prelude `Patch a = < Keep \| Set a >`, `h.Patch`, Roc `Decode.patch_field`. In Effect, use `optionalKey(Option(X))`. All tested. |
| 🟡 | D4 | **Maps with non-string keys and sets.** | Prelude conventions: `Map([(k, v), …])` and `Set([…])`. **Open:** decoders for them in TypeScript, Effect and Roc. |
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
| ✅ | **Serializer** | `format` / `stringify` (standard layout, spec §11), comments and blank lines kept, round-trip and idempotence tested on every conformance file; Format Document in VS Code. Schema-aware encoding: `h.stringify` / `h.encodeStream`, Effect `Haus.encode` / `Haus.encodeStream`. **Open:** encoding in Roc. |
| ✅ | **Limits API and spec defaults** | See S4. Configurable limits in Roc are still open. |
| 🟡 | **Spec prose** | [`spec/README.md`](../spec/README.md), draft 0.2: data model, equality, numbers, Unicode, variants, streams, limits, error positions, security, evolution. **Open:** the schema language and the canonical form. |
| 🟡 | **Conformance suite expansion** | Added: limits at and just past the boundary, bidi controls, the D1 cases (now 93 files: 23 valid, 70 invalid). **Open:** NFC/NFD keys, `\u{0}`, the largest code point, expected error positions, and differential fuzzing (random inputs, checking that TypeScript and Roc agree). |

### 3.2 Should have

| | Item |
|---|---|
| ⬜ | **Canonical form** for hashing, signing and deduplication (spec §12). |
| ⬜ | **Schema language** spec, parser and checker: rows, open vs closed, `Stream`, generics. Rules for recursion and expressiveness are settled (spec §9.9–10): explicit, guarded, regular recursion and no computation in schemas. |
| ⬜ | **JSON interop:** a mapping both ways, `from-json` / `to-json`, and the `application/haus` MIME type. |
| ⬜ | **CLI:** `check`, `fmt`, `convert`, and a jq-like `query` using the path syntax from error messages. |
| ✅ | **A parser that keeps comments and formatting**: `parseDocument` records comment and value positions; the formatter places comments and blank lines. |

### 3.3 Later

| | Item |
|---|---|
| 🟡 | Language server: done (diagnostics, outline, hover with inferred types, formatting, schema inference). Tree-sitter: open |
| ⬜ | Code generation from `.schema.haus` (Roc, Go, Swift, …) |
| ⬜ | A binary encoding of the same data model |
| ⬜ | Streaming in the Roc parser |

---

## 4. Use cases

| | Use case | Status / gap |
|---|---|---|
| ✅ | Config files | Comments, trailing commas, block strings, exact numbers, and a formatter that keeps comments. |
| 🟡 | API payloads | Sum types, exact money, open variants, schema-aware encoding and decoding. Missing: a MIME type. |
| ✅ | Event streams and logs | Comma-terminated values, open variants, size limit per value, truncation detection (TypeScript). |
| ✅ | Partial updates (PATCH) | `Patch a`; absent ≠ `None` (D3). |
| ⬜ | Signed or hashed documents | Sign the exact bytes today. A canonical form for hashing equal values is planned. |
| 🟡 | Tabular data | Works, but repeats every key. Acceptable with compression. |
| 🟡 | Scientific and ML numbers | `NaN`/`Infinity` done (D5). Large numeric arrays are inefficient as text. |
| 🟡 | Binary blobs | `Bytes("base64")` works for small blobs. |
| — | Graphs, shared references | Excluded by design (security). Use ids. |
| 🟡 | Maps with non-string keys, sets | Prelude conventions exist; decoders are open (D4). |

---

## 5. Remaining order

1. The canonical form (needs the serializer, which now exists).
2. More conformance cases and differential fuzzing between TypeScript and Roc.
3. Configurable limits in Roc; `Map`/`Set` decoders.
4. JSON interop and a CLI.
5. Schema language parser and checker, then code generation, LSP and Tree-sitter.
