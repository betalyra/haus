# haus in Lean

A formal model of the haus data format: the grammar as a precise definition,
and a reference parser that computes it.

| File | Contents |
|---|---|
| [`Haus/Value.lean`](Haus/Value.lean) | The data model (spec §1) and equality (§2) |
| [`Haus/Grammar.lean`](Haus/Grammar.lean) | [`grammar.ebnf`](../grammar.ebnf) as a relation: `File L t vs` says text `t` is a file with values `vs` within the limits `L` (§7). This is the specification. |
| [`Haus/Parser.lean`](Haus/Parser.lean) | The reference parser: total functions that compute `File` |
| [`Haus/Lexical.lean`](Haus/Lexical.lean) | Character classes, limits, number normalization |
| [`Haus/Sound/`](Haus/Sound) | Proofs that the parser only accepts what the grammar allows |
| [`Haus/Complete/`](Haus/Complete) | Proofs that the parser accepts everything the grammar allows |
| [`Haus/Correct.lean`](Haus/Correct.lean) | Both together, and unambiguity |
| [`Haus/Canonical.lean`](Haus/Canonical.lean), [`Haus/RoundTrip/`](Haus/RoundTrip) | The canonical form (spec §12), and the proofs that it parses back and is unique |
| [`Haus/Stream.lean`](Haus/Stream.lean), [`Haus/Stream/`](Haus/Stream) | A model of the bindings' stream readers (spec §6), and the proofs that the chunks don't matter and that it reads what `parse` does |
| [`Haus/Time/`](Haus/Time) | The std/time profile ([`std/time.md`](../std/time.md)): the rules, a checker, and the proof that it computes them |
| [`Main.lean`](Main.lean) | `haus-ref`, the parser on the command line |

It needs [elan](https://github.com/leanprover/elan) (`brew install elan-init`);
the Lean version is pinned in `lean-toolchain`. No Mathlib.

```sh
lake build
.lake/build/bin/haus-ref FILE                    # values in the test-suite JSON encoding
.lake/build/bin/haus-ref --suite ../../test-suite # the conformance suite
.lake/build/bin/haus-ref --time Date 2026-02-29     # a std/time check
```

## What is proven

**About every valid file** (theorems about the grammar, so about every
possible input):

| Theorem | Says |
|---|---|
| `File.noBidi` (A1) | It contains no raw bidi control character, anywhere |
| `File.controls` (A2) | Its only control characters are tab, LF and CR |
| `File.crlf` (A2) | Every CR is directly followed by LF: no lone carriage returns |
| `File.uniqueKeys` (A3) | Every record in it, at any depth, has unique keys |
| `File.bounded` (A4) | Every value is within the limits: depth, numbers, strings, byte strings |
| `char_isScalar` (A5) | Every string is valid Unicode, with no lone surrogates |

**About the reference parser:** it computes exactly the grammar. It accepts
a text if and only if the grammar describes it, and returns the values the
grammar gives:

```lean
theorem parse_correct (L : Limits) (input : Text) (vs : List Value) :
    Parser.parse L input = .ok vs ↔ File L input vs
```

| Theorem | Says |
|---|---|
| `parse_sound` | Whatever the parser accepts is a haus file with exactly the values it returned |
| `parse_complete` | Every haus file is accepted, with its values |
| `File.unique` | A text has at most one meaning: two derivations give the same values |

By soundness, A1–A4 hold for everything the parser returns
([`Haus/Secure.lean`](Haus/Secure.lean): `parse_noBidi`, `parse_controls`,
`parse_uniqueKeys`, `parse_bounded`).

Both directions are proven one file per part of the parser: numbers and
strings, whitespace and nested comments, byte strings, block strings, and
values, records, arrays, payloads and files together (they call each
other). Soundness goes by induction on the parser's fuel, completeness by
induction on the grammar's derivation; it also shows that the parser's fuel
is always enough. Only Lean's standard axioms are used
(`#print axioms parse_correct`).

The full plan, including the security properties, is in [`PLAN.md`](PLAN.md).

**About std/time:** `Time.check_iff : check ty s = true ↔ Valid ty s`. The
checker behind `haus-ref --time` computes exactly the rules of
[`std/time.md`](../std/time.md), written as definitions in
[`Haus/Time/Spec.lean`](Haus/Time/Spec.lean). Every row of the spec's rules
table is also a `#guard` test in [`Haus/Time/Check.lean`](Haus/Time/Check.lean).
[`Haus/Time/Props.lean`](Haus/Time/Props.lean) proves what valid values
guarantee: a zone name looked up as a file under a directory stays inside
it (`ZoneName.lookup_eq`), and a duration's fields fit in 32 bits, 2⁵³
seconds and 10⁹ nanoseconds (`Duration.fits`, `Fraction.nanos_lt`).
[`Haus/Time/Calendar.lean`](Haus/Time/Calendar.lean) proves the calendar
right (`date_iff`): valid `Date` strings are exactly the days from 0000-01-01
to 9999-12-31, one string per day, checked against the standard day-count
formula, which doesn't use the month-length table the rules use.
[`Haus/Time/Spelling.lean`](Haus/Time/Spelling.lean) proves one spelling per
value: two valid strings of a type are the same value exactly when they
differ at most in trailing zeros of a fraction (and, for instants, in the
offset); `Date` and `YearMonth` have exactly one spelling.

**About the canonical form** (spec §12), in [`Haus/RoundTrip/`](Haus/RoundTrip):

| Theorem | Says |
|---|---|
| `parse_canonical` | The canonical form of a parsed value parses back to that value: nothing can break out of its quotes (E) |
| `canonical_eq_iff` | Two parsed values have the same canonical form exactly when they are equal (§2), so hashes are well defined (H) |
| `canonicalAll_eq_iff` | Two parsed files have the same `hashAll` text exactly when they hold equal values in the same order (H) |
| `canonical_eq_canonicalAll_iff` | A value's canonical form is the text of a list only for one equal value: `hash v = hashAll [v]`, and nothing else collides (H) |
| `hashText_eq`, `canonicalAll_prefix`, `read_canonicalAll` | Hashing value by value as a stream is read gives `hashAll` of the file; the values read so far give a prefix of the text (H) |

Both assume a number limit of at least the default: the canonical form
writes integers longer than 1000 digits in hex, so under a stricter limit a
hex literal's canonical decimal form could be too long.

**About streams** (spec §6), in [`Haus/Stream/`](Haus/Stream). The model in
[`Haus/Stream.lean`](Haus/Stream.lean) works like the readers of all three
bindings: a scanner finds the commas between top-level values (it tracks
brackets, strings and comments, and waits when a chunk ends before it can
decide), and each piece is parsed on its own.

| Theorem | Says |
|---|---|
| `read_chunks` | However the text is split into chunks, the reader returns the same values and the same error |
| `pieces_prefix` | A value returned after some of the chunks is never taken back: it is one of the final values |
| `read_correct` | The reader returns `vs` without an error exactly when `parse` accepts the whole text with `vs` |
| `read_error` | When `parse` rejects a text, the reader reports an error |

Not modelled: the limit on one value's length (§7), strict mode, UTF-8
decoding and error positions.
