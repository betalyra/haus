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
| ✅ | **H. Canonical form** (spec §12) | `canonical_eq_iff`: two parsed values have the same canonical form exactly when they are equal (§2), so `hash` is well defined. Reference encoder in [`Haus/Canonical.lean`](Haus/Canonical.lean), implemented in TypeScript, Rust and Roc and fuzzed against it. | 1–2 weeks |
| ⬜ | **I. Schema language** (separate project) | Decoding with any schema terminates in linear time (§9.8–10) | months |
| 🟡 | **T. std/time** | A reference model of the profile (spec §13.2, `std/time.md`), the bindings' time checkers fuzzed against it, and its security and calendar properties proven | 1–3 weeks |

Order: A–H and T1–T4 are done. Next T5 and T6 (std/time calendar and
spellings); I waits for a stable schema language.

## A. Security properties of the grammar

Each is a theorem of the form `File L t vs → …`.

| Theorem | Security issue | Spec |
|---|---|---|
| ✅ A1. No raw bidi control character anywhere in a valid file (`File.noBidi`, `Haus/Props/Chars.lean`) | "Trojan Source": text that displays differently from what it is | §4, review S7 |
| ✅ A2. The only control characters in a valid file are tab, LF and CR (`File.controls`). Found by the proof attempt: comments allowed ESC and NUL, strings allowed DEL and C1; now forbidden everywhere (spec §4). Still to state: every CR is directly followed by LF. | Terminal escape injection, truncation at NUL | §4 |
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
| ⬜ | T5. The calendar is right | Valid `Date` strings correspond exactly to the days from 0000-01-01 to 9999-12-31 | ~1 week |
| ⬜ | T6. One spelling per value | Formatting a parsed value gives back the same string; the only spellings of the same value are those the profile names (`Instant` offsets, `.250` and `.25`) | ~1 week |

T5 and T6 can start now that the canonical form (H) exists.

## Also

- Every disagreement found (by a proof or by testing) becomes a conformance
  case. So far: the lone carriage return (now an error everywhere), the
  string limit counting UTF-16 units in TypeScript (fixed), and raw control
  characters in comments and strings (now an error everywhere), the Rust
  stream crash and the byte order mark in streams (fixed), and Roc's std/time
  check accepting duration components too long to parse as a float (fixed,
  found while writing the model).
