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
| 🟡 | **G. Differential testing** | The bindings agree with `haus-ref` on generated and mutated inputs, in CI | ~1 week, can start any time |
| 🟡 | **B. Soundness** | The parser only accepts what the grammar allows. A's properties then hold for its output. | 2–3 weeks |
| ⬜ | **C. Completeness** | The parser accepts everything the grammar allows: `parse L t = .ok vs ↔ File L t vs` | 3–5 weeks |
| ⬜ | **D. Unambiguity** | Every valid text has exactly one meaning. Follows almost for free from B + C, since the parser is a function. | days |
| ⬜ | **E. Encoder round trip** | `parse (encode vs) = .ok vs`: encoded strings can't break out (no injection) | 1–2 weeks |
| ⬜ | **F. Streams** | The stream reader returns the same values however the input is split | 1–2 weeks |
| ⬜ | **H. Canonical form** (spec §12, once specified) | Equal values (§2) give identical bytes, so hashes and signatures are well defined | 1–2 weeks |
| ⬜ | **I. Schema language** (separate project) | Decoding with any schema terminates in linear time (§9.8–10) | months |

Recommended order: A and G first (quick, immediately useful), then B → C →
D, then E and F. H waits for the canonical form, I for a stable schema
language.

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

## B. Soundness (in progress)

| | Part | Notes |
|---|---|---|
| ✅ | Numbers, escapes, basic strings | `Haus/Sound/Lexical.lean` |
| ⬜ | Whitespace and comments | The block comment depth counter against the nested grammar rule needs an invariant |
| ⬜ | Byte strings | Easy |
| ⬜ | Block strings | Hardest lexical part: closing quotes, line splitting, indentation |
| ⬜ | Values, records, arrays, variants | Mutual induction; duplicate keys and the depth budget |
| ⬜ | Files, byte order mark | Easy |

## C. Completeness

| Part | Notes |
|---|---|
| Follow sets | In every derivation, what follows a number or tag never starts with `[A-Za-z0-9_.]`. This is what makes the parser's greedy choices safe. |
| Lexical | The parser finds every grammatical number, string, comment |
| Values and files | Mutual induction over derivations |
| Fuel | `4 × (length + 1)` is always enough |

## G. Differential testing

In [`fuzz/`](../../fuzz). Runners for all four parsers, a generator with
mutations, comparison and shrinking are done. 100,000 cases run in about a
minute; so far no disagreement on acceptance or values.

Open:
- Streams: the same inputs through each binding's stream reader, in random
  chunks, compared with parsing the whole input.
- CI: build all four, `lake build` (so a broken proof fails), ~100k cases
  per pull request, more nightly.
- Error positions differ in ~1% of rejected inputs: Lean reports errors in
  block strings at the block's start, Roc reports `0x` without digits after
  the prefix. Decide whether §8 should fix which position is reported.

## Also

- Run `lake build` in CI, so a change to the grammar or parser that breaks a
  proof fails the build.
- Every disagreement found (by a proof or by testing) becomes a conformance
  case. So far: the lone carriage return (now an error everywhere), the
  string limit counting UTF-16 units in TypeScript (fixed), and raw control
  characters in comments and strings (now an error everywhere).
