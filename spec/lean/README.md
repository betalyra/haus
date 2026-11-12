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

These hold for the reference parser's output as soon as its soundness is
proven (below).

**About the reference parser:**

Soundness says: when the parser accepts something, the grammar allows
it, with the same value. Proven so far, in [`Haus/Sound/Lexical.lean`](Haus/Sound/Lexical.lean):

| Theorem | Says |
|---|---|
| `number_sound` | An accepted number is a `NumberLit` within the limits, and its value is the normalized literal |
| `escape_sound` | An accepted escape is an `Escape` denoting the returned character |
| `basicString_sound` | An accepted `"…"` string is a `BasicString` within the limits, denoting the returned text |

The full plan, including the security properties, is in [`PLAN.md`](PLAN.md).

Not yet: soundness of whitespace and comments, block strings, byte strings,
records, arrays, variants and files; then completeness (the parser accepts
everything the grammar allows), unambiguity, formatting round trips, and
stream splitting.
