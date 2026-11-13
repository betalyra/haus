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
| [`Main.lean`](Main.lean) | `haus-ref`, the parser on the command line |

It needs [elan](https://github.com/leanprover/elan) (`brew install elan-init`);
the Lean version is pinned in `lean-toolchain`. No Mathlib.

```sh
lake build
.lake/build/bin/haus-ref FILE                    # values in the test-suite JSON encoding
.lake/build/bin/haus-ref --suite ../../test-suite # the conformance suite
```

## What is proven

**About every valid file** (theorems about the grammar, so about every
possible input):

| Theorem | Says |
|---|---|
| `File.noBidi` (A1) | It contains no raw bidi control character, anywhere |
| `File.controls` (A2) | Its only control characters are tab, LF and CR |
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

Next: the std/time model, then encoding round trips and stream splitting.
