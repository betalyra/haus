# haus in Lean

A formal model of the haus data format: the grammar as a precise definition,
and a reference parser that computes it.

| File | Contents |
|---|---|
| [`Haus/Value.lean`](Haus/Value.lean) | The data model (spec §1) and equality (§2) |
| [`Haus/Grammar.lean`](Haus/Grammar.lean) | [`grammar.ebnf`](../grammar.ebnf) as a relation: `File L t vs` says text `t` is a file with values `vs` within the limits `L` (§7). This is the specification. |
| [`Haus/Parser.lean`](Haus/Parser.lean) | The reference parser: total functions that compute `File` |
| [`Haus/Lexical.lean`](Haus/Lexical.lean) | Character classes, limits, number normalization |
| [`Main.lean`](Main.lean) | `haus-ref`, the parser on the command line |

It needs [elan](https://github.com/leanprover/elan) (`brew install elan-init`);
the Lean version is pinned in `lean-toolchain`. No Mathlib.

```sh
lake build
.lake/build/bin/haus-ref FILE                    # values in the test-suite JSON encoding
.lake/build/bin/haus-ref --suite ../../test-suite # the conformance suite
```

Not yet done: the proofs that the parser computes the grammar (soundness,
completeness), that the grammar is unambiguous, that formatting round-trips,
and that the stream reader gives the same values however the input is split.
