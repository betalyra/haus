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

**About the reference parser:** it is *sound*. Whatever it accepts is a
haus file in the grammar, with exactly the values it returned:

```lean
theorem parse_sound (L : Limits) (input : Text) (vs : List Value)
    (h : Parser.parse L input = .ok vs) : File L input vs
```

So A1–A4 hold for everything it returns ([`Haus/Secure.lean`](Haus/Secure.lean):
`parse_noBidi`, `parse_controls`, `parse_uniqueKeys`, `parse_bounded`). The
proof is in [`Haus/Sound/`](Haus/Sound), one file per part of the parser:
numbers and strings, whitespace and nested comments, byte strings, block
strings, and values, records, arrays, payloads and files together (they call
each other). It uses only Lean's standard axioms (`#print axioms parse_sound`).

Not proven yet: *completeness*, that the parser accepts everything the
grammar allows. Until then a valid file could in principle be rejected, but
nothing invalid is accepted.

The full plan, including the security properties, is in [`PLAN.md`](PLAN.md).

Next: completeness, unambiguity (which follows from soundness and
completeness), encoding round trips, and stream splitting.
