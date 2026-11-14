# Plan: proving haus correct and secure

What we want to know for certain about the haus text format, and in which
order to prove it. Status: ✅ done · 🟡 started · ⬜ open.

## The shape of the argument

1. The **grammar** (`Haus/Grammar.lean`) is the specification.
2. Properties of the grammar are proven once, about every possible text.
3. The **reference parser** is proven to compute exactly the grammar.
   Then everything proven about the grammar holds for what it returns.
4. The **bindings** (TypeScript, Rust, Roc) are tested against the
   reference parser, on millions of generated inputs.

Proofs cover the format and the reference parser. The bindings' own
behaviour (tags never become classes, `__proto__` never reaches a
prototype, …) is outside Lean and stays covered by tests.

## Phases

| | Phase | What it gives us | Effort |
|---|---|---|---|
| ✅ | **0. Model** | Data model, equality, grammar, reference parser, `haus-ref` (103/103 conformance cases) | — |
| ✅ | **A. Security properties of the grammar** | Theorems about every valid file, independent of any parser (below) | days |
| ✅ | **G. Differential testing** | The bindings agree with `haus-ref` on generated and mutated inputs, in CI | ~1 week, can start any time |
| ✅ | **B. Soundness** | The parser only accepts what the grammar allows. A's properties then hold for its output. | 2–3 weeks |
| ✅ | **C. Completeness** | The parser accepts everything the grammar allows: `parse L t = .ok vs ↔ File L t vs` | 3–5 weeks |
| ✅ | **D. Unambiguity** | Every valid text has exactly one meaning. Follows from B + C, since the parser is a function. | days |
| ✅ | **E. Encoder round trip** | `parse_canonical`: for every value a parser returns, its canonical form parses back to that value (in canonical order), so no string, key or number can break out of its syntax. Holds for number limits of at least the default (spec §12 writes long integers by the default limit). In [`Haus/RoundTrip/`](Haus/RoundTrip). | 1–2 weeks |
| ✅ | **F. Streams** | A model of the bindings' stream readers: `read_chunks`, any split gives the same values and errors; `read_correct`, the reader returns `vs` exactly when `parse` accepts the whole text with `vs`. In [`Haus/Stream/`](Haus/Stream). | 1–2 weeks |
| ✅ | **H. Canonical form** (spec §12) | `canonical_eq_iff`: two parsed values have the same canonical form exactly when they are equal (§2), so `hash` is well defined. `canonicalAll_eq_iff` does the same for `hashAll` of a file or stream, and `read_canonicalAll`/`canonicalAll_prefix` cover hashing while reading ([`Haus/RoundTrip/HashAll.lean`](Haus/RoundTrip/HashAll.lean)). Reference encoder in [`Haus/Canonical.lean`](Haus/Canonical.lean), implemented in TypeScript, Rust and Roc and fuzzed against it. | 1–2 weeks |
| ⬜ | **P. Linear time** (spec §7) | A cost model (steps counted next to the result) and proofs that the stream scanner and a linear reference parser take at most `c · length` steps (below). Deferred: see below. | 1–2 weeks |
| 🟡 | **I. Schema decoding** (spec §14–15) | A reference decoder that passes the schema suite, then termination, the round trip and linear time, in steps I1–I7 (below). I1–I3 and I5 done, in [`Haus/Schema/`](Haus/Schema). | I1–I3: ~2 weeks; all: months |
| 🟡 | **V. Versions** (spec §10) | `Extends old new`: a new version is a conservative extension of the old one (same values for every old text; canonical form, built-in types and schema decoding agree on what the old version can express). Defined, with `refl`, `trans` and `current_extends_self`, in [`Haus/Version.lean`](Haus/Version.lean); to be proven for each release. | days per release |
| ✅ | **T. std/time** | A reference model of the profile (spec §13.2, `std/time.md`), the bindings' time checkers fuzzed against it, and its security and calendar properties proven | 1–3 weeks |

Order: A–H, T1–T6, I1–I3, I5 and the definition of V are done. Next:
fuzzing the bindings' decoders against the Lean one (the rest of I3), a
proof of `FloatLaw`, then I4 and I6. P comes after the benchmarks' doubling
tests and is needed only for I7.

## A. Security properties of the grammar

Each is a theorem of the form `File L t vs → …`.

| Theorem | Security issue | Spec |
|---|---|---|
| ✅ A1. No raw bidi control character anywhere in a valid file (`File.noBidi`, `Haus/Props/Chars.lean`) | "Trojan Source": text that displays differently from what it is | §4, review S7 |
| ✅ A2. The only control characters in a valid file are tab, LF and CR (`File.controls`). Found by the proof attempt: comments allowed ESC and NUL, strings allowed DEL and C1; now forbidden everywhere (spec §4). And every CR is directly followed by LF (`File.crlf`, `Haus/Props/LineBreaks.lean`). | Terminal escape injection, truncation at NUL | §4 |
| ✅ A3. Every record, at any depth, has unique keys (`File.uniqueKeys`, `Haus/Props/Values.lean`) | Parsers that pick different duplicates | review §1.1 |
| ✅ A4. Every value is within the limits: nesting depth, number length, exponent, string and byte string length (`File.bounded`) | Resource exhaustion | §7, review S4, S5 |
| ✅ A5. Every string is valid Unicode with no lone surrogates (`char_isScalar`) | Encoding confusion | §4 (holds by construction: Lean's `Char`) |

Two properties already hold by construction and need no proof:
- The parser can't do I/O, follow references or fetch anything: its type is
  `Text → Except Error (List Value)` (§9.2).
- It always terminates: Lean accepts only total functions.

## B. Soundness ✅

`parse_sound`: whatever the reference parser accepts is a `File` of the
grammar, with the values it returned. So A1–A4 hold for its output
(`Haus/Secure.lean`). About 1,400 lines in `Haus/Sound/`, no `sorry`, standard
axioms only.

| Part | File |
|---|---|
| Numbers, escapes, basic strings | `Sound/Lexical.lean` |
| Whitespace, line and nested block comments | `Sound/Whitespace.lean` |
| Byte strings | `Sound/Bytes.lean` |
| Block strings | `Sound/BlockString.lean` |
| Keys, values, records, arrays, payloads, files | `Sound/Values.lean` |

Mismatches found while proving: none between parser and grammar. Two grammar
rules were restated in an equivalent, simpler form (block string text joined
with `List.intercalate`; the closing `"""` stated over content and indent).

## C. Completeness ✅ and D. Unambiguity ✅

`parse_complete`: when the grammar derives `File L t vs`, then
`parse L t = .ok vs`. With B, `parse_correct` gives both directions, and
`File.unique` (D) follows: the parser is a function, so two derivations of
the same text give the same values. In [`Haus/Complete/`](Haus/Complete):

| Part | How |
|---|---|
| Follow conditions | The parser reads greedily, so each lemma says what may follow: a number or tag nothing in `[A-Za-z0-9_.]`, a bare tag not blanks then `(` or `{`, whitespace not whitespace or `/`. The grammar only puts a value before whitespace, `,`, a closing bracket or the end, which satisfies all of them. |
| Lexical | The reverse of each soundness lemma: `lexNumber` reads exactly the literal, `chars` exactly the string, `blockComment` exactly a nested comment, `ws` exactly `WS`, `findClose` finds the closing `"""` (the content before it never ends with `\` or `"`), `splitLines` gives back the lines. |
| Values and files | Induction over the grammar's derivation (mutual, like the grammar). A value needs fuel above twice its length, so the parser's `4 * (length + 1)` is always enough; no fuel monotonicity needed. |

Nothing in the parser or the grammar had to change: no valid input is
rejected.

## F. Streams ✅

The readers of all three bindings work the same way, and
[`Haus/Stream.lean`](Haus/Stream.lean) models it: a scanner finds the commas
between top-level values, tracking only bracket depth, strings, block strings
and comments, and each piece before such a comma is parsed on its own. The
scanner looks up to three characters ahead (`"""`, `//`, `*/`, `\"`) and
waits when a chunk ends before it can decide.

| Part | File |
|---|---|
| A decision the scanner makes on part of the input is the same on any continuation (`step_stable`); so scanning in parts is scanning the whole (`scan_append`), and any chunks give the same pieces (`split_chunks`, `read_chunks`) | `Stream/Chunks.lean` |
| On valid text the scanner passes over every value, string, comment and bracketed part without cutting, and cuts exactly at the commas between top-level values | `Stream/Scan.lean` |
| Valid text is read correctly; what the reader accepts is valid, since a piece that ends in a line comment or has a comma of its own can't occur (the scanner would not have cut there) | `Stream/Correct.lean` |

Pieces after the first may not start with a byte order mark: the model
rejects one, as the bindings do since S14. Without that rule `read_correct`
would be false.

## G. Differential testing

In [`fuzz/`](../../fuzz): runners for all four parsers and for the three
stream readers (inputs split into chunks), a generator with mutations,
comparison and shrinking. 100,000 cases through all seven run in about 80
seconds.

Found so far: a crash in the Rust stream reader on input ending in `/`, and
stream readers accepting a byte order mark after a comma (design review S13,
S14). Both fixed; two seeds of 100,000 cases now run clean.

CI ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)) runs every
binding's tests, `lake build --wfail` (a broken proof or a `sorry` fails it)
and the conformance suite, and fuzzes 100,000 parser cases and 2 million
std/time cases per pull request; 1 million and 20 million nightly.

Open:
Decided: §8 fixes the units of an error position, not which error a parser
reports first, nor any message. Fixing it would rule out parsers that
validate in separate passes (UTF-8 and control characters first, as fast
parsers do) and need exceptions anyway (unterminated strings are reported
at their opening quote). The fuzzer counts position differences for
information only.

## P. Linear time

Spec §7 requires parsing to take time linear in the input. Lean proofs say
nothing about time by themselves (`List.drop` costs nothing in a proof), so
this needs an explicit cost model: each function returns the number of
steps it took next to its result, and the operations whose cost matters
are given their real cost (removing the front of a buffer costs one step
per byte moved).

| | Step | Gives |
|---|---|---|
| ⬜ | P1. Cost model | Step counting for the stream model of F, including buffer operations |
| ⬜ | P2. Stream scanner | Reading any chunks takes at most `c · length` steps: every byte is scanned once and moved at most once. The design before S17 (removing each value's bytes as it is returned) fails this proof. |
| ⬜ | P3. Parser | A linear reference parser: the current one checks duplicate keys by scanning the keys read so far, so a record with n keys takes n² steps. It is written for clarity; P3 needs a variant with a set of keys, proven equal to it and linear. |

What this can't cover: the bindings' own code (S17 was in Rust's buffer
handling, not in the design) and constant factors. Those are covered by the
benchmarks ([`plans/benchmarks.md`](../../plans/benchmarks.md)), including a
doubling test in CI: twice the input must take about twice the time.

**Deferred.** P would hardly help parser development: it proves the model,
not the bindings, and the bug it is about (S17) was found by measuring. The
doubling tests catch such bugs in the real code. P3 also needs a model of
hashing (constant-time sets), which Lean without Mathlib supports poorly.
P is worth doing for the claim "proven linear", after the benchmarks, and
P1 is needed for I7. P2 alone (the stream scanner) is the cheapest part.

## I. Schema decoding

Spec §15 defines what each type accepts, and `test-suite/schema` tests it.
The goal is the same as for parsing: an executable reference in Lean that
the bindings are fuzzed against, then proofs about it. Each step after I3
stands on its own.

| | Step | Gives | Effort |
|---|---|---|---|
| ✅ | I1. Schema types | `Ty` ([`Schema/Types.lean`](Haus/Schema/Types.lean)): built-in types, `Any`, `Secret`, std/time types, `Array`, `Map`, records (open or closed, `?` fields), variants (open or closed, every payload form, `< >`), `Bool`/`Maybe`/`Result` as the prelude's closed variants, named references into an environment, generics applied. Attributes are not part of a type: a `Schema` keeps them in a table of their own, so `Schema.decode_erase` (decoding is the same without them) is `rfl`. | days |
| ✅ | I2. Reference decoder and encoder | `decode`/`encode` following §15 ([`Schema/Decode.lean`](Haus/Schema/Decode.lean)), unknown values, `Any` and secrets included; errors with their place. Recursion on the value, so it terminates for every environment: a reference that comes up again at the same level is an error (§9.9). Floats exact, with integer arithmetic ([`Schema/Float.lean`](Haus/Schema/Float.lean)): rounding to binary64/binary32 ties to even, directly from the decimal; the shortest spelling with ties to the even digit, JavaScript's layout. `decode_iff`: the decoder computes the rules of §15, written as an inductive relation ([`Schema/Rules.lean`](Haus/Schema/Rules.lean)). `secret_error`: an error inside a `Secret` doesn't depend on the value. | ~1 week |
| 🟡 | I3. Conformance | `haus-ref --schema-suite`: all 250 cases of `test-suite/schema` pass, none skipped. The types come from the TypeScript binding's schema-file parser ([`scripts/schema-types.ts`](scripts/schema-types.ts) → [`schema-suite.json`](schema-suite.json)); it also checks that removing the attributes changes no type. Floats also matched JavaScript's `Number`/`toString` on 20,000 random literals. Open: fuzzing the bindings' decoders against the Lean one. `haus-ref --schema-batch TYPES FILE` is the Lean side; missing are a generator of values for a type and a runner per binding in `fuzz/`. | days |
| ⬜ | I4. Termination | Decoding terminates for every schema §14 allows: guarded recursion consumes input at each level (§9.9) | 1–2 weeks |
| ✅ | I5. Round trip | `decode_encode`: decode, encode, decode is decode. `encode_agree`: encode after decode is the input except where §15 says (`Agree`: fields an open record ignores, a float spelled another way that rounds to the same float, `-0` as an integer written `0`). Both assume `FloatLaw` (the spelling of a decoded float rounds back to it), tested but not proven: proving it needs the layout to parse back, and rounding to be the identity on representable values. In [`Schema/RoundTrip.lean`](Haus/Schema/RoundTrip.lean). | 1–2 weeks |
| ⬜ | I6. Schema checker | The static rules of §14 (guarded recursion, no spread cycles, regular generics) imply what I4 assumes | weeks |
| ⬜ | I7. Linear time | Decoding takes at most `c · size` steps (§9.8). Needs P1's cost model. | weeks |


## T. std/time

The profile in [`std/time.md`](../std/time.md) is small and every rule is
decidable, so it can be modelled completely. What depends on the tz database
(does a zone exist, does an offset match its zone) is outside the profile by
design, and so outside the model.

| | Step | Gives | Effort |
|---|---|---|---|
| ✅ | T1. Reference model | Each type's rules as a definition, and a checker proven to compute them (`check_iff`); `haus-ref --time` | days |
| ✅ | T2. Fuzzing | The TypeScript, Rust and Roc std/time checkers against the model ([`fuzz/src/time.ts`](../../fuzz/src/time.ts)): 2 million cases, no disagreements. It finds the Roc bound bug when run against the old code. | 1–2 days |
| ✅ | T3. Zone names can't traverse paths | `ZoneName.lookup_eq`: looked up as a file under `base`, a valid zone name resolves to exactly `base/…` (modelled like `os.path.join`: `.`, `..`, absolute names); `ZoneName.chars`: no `\`, `:` or NUL | ~1 day |
| ✅ | T4. Durations can't overflow | `Duration.fits`: years, months and weeks below 2³²; days and time below 2⁵³ seconds (exact as a JavaScript number, and a signed 64-bit count of seconds); `Fraction.nanos_lt`: a fraction below 10⁹ nanoseconds. Mostly by construction: the bounds are in the rules, and `check_iff` makes the checker enforce them. | ~1 day |
| ✅ | T5. The calendar is right | `date_iff`: a string is a valid `Date` exactly when it is the text of one of the days 0000-01-01 … 9999-12-31, one string per day. The days are counted with the standard day-count formula (365 days a year, leap rules by 4, 100, 400, month lengths from `(153·M + 2)/5`), which doesn't use `daysIn`; `next_dayNumber` shows that the day after every valid date gets the next number, so `daysIn` can't allow a day too many or too few anywhere. In [`Haus/Time/Calendar.lean`](Haus/Time/Calendar.lean). | ~1 week |
| ✅ | T6. One spelling per value | For every type, two valid strings have the same value exactly when they differ at most in trailing zeros of the fraction (`time_same_iff`, `dateTime_same_iff`, `duration_same_iff`; for `Instant` and `ZonedDateTime` with the same offset: `instant_same_iff`, `zoned_same_iff`); `Date` and `YearMonth` have exactly one spelling (`date_same_iff`, `yearMonth_same_iff`). `duration_text`: formatting a duration's value gives back its text. Writing the proof found three more spellings, now rejected (`P01D`, `-P0D`, zero components such as `P1DT0S`). In [`Haus/Time/Spelling.lean`](Haus/Time/Spelling.lean). | ~1 week |


## V. Versions

[`Haus/Version.lean`](Haus/Version.lean). A `Version` is what a version
fixes: its files (`parse`), its canonical form, its built-in types and its
schema files, each decoder written as the value its encoder writes, so that
versions with different host types compare. `Extends old new`: every text
`old` accepts, `new` accepts with the same values; on what `old` can express,
the canonical form is the same, and so are the built-in types and the types
of every schema `old` accepts. Proven: `Extends.refl`, `Extends.trans`,
`current_extends_self` (the version this model describes, with the schema
files' resolver as a parameter, since schema files are parsed outside Lean).
Each release proves `Extends previous release`.

## Also

- Every disagreement found (by a proof or by testing) becomes a conformance
  case. So far: the lone carriage return (now an error everywhere), the
  string limit counting UTF-16 units in TypeScript (fixed), and raw control
  characters in comments and strings (now an error everywhere), the Rust
  stream crash and the byte order mark in streams (fixed), and Roc's std/time
  check accepting duration components too long to parse as a float (fixed,
  found while writing the model). The schema model found `type Any = < >`
  in `test-suite/schema/variants.schema.haus`, which `Any` in the prelude
  had made invalid (renamed `AnyTag`).
