# Differential testing

Generated inputs go through every haus parser: the Lean reference parser
(`spec/lean`), Rust, Roc and TypeScript. They must agree on every input:
accepted with the same values, or rejected. A disagreement is a bug in at
least one of them, or a gap in the spec.

```sh
sh fuzz/build.sh                       # build the parsers under test
node fuzz/src/main.ts --count 100000   # about a minute
node fuzz/src/main.ts --seed 7         # repeat a run
```

Needs Node 23.6 or later (it runs the TypeScript directly), Lean (elan),
Rust and Roc.

## How it works

| Step | |
|---|---|
| Generate | [`src/generate.ts`](src/generate.ts): random haus text with varied formatting (spacing, comments, CRLF, byte order mark, number spellings, quoted keys, block strings, both payload forms, trailing commas), values at and just past the limits, the conformance suite as seeds. Half of the inputs are then mutated: bytes deleted, edge characters inserted (quotes, `*/`, control and bidi characters, invalid UTF-8), slices duplicated, cut short. |
| Run | [`src/runners.ts`](src/runners.ts): each parser reads a batch of files and prints one line per file, `ok <values>` in the test-suite JSON encoding or `err <line> <column> <reason>`. |
| Compare | [`src/main.ts`](src/main.ts): accept/reject and the values must agree. |
| Shrink | A disagreeing input is cut down to the smallest input that still disagrees, and saved to `.out/failures/` with every parser's result. |

Error positions are reported separately: the spec fixes their units (§8)
but not which error a parser reports first, so they may differ.

## The runners

| Parser | Runner |
|---|---|
| Lean | `haus-ref --batch DIR N` ([`spec/lean/Main.lean`](../spec/lean/Main.lean)) |
| Rust | [`rust/haus/examples/fuzz_runner.rs`](../rust/haus/examples/fuzz_runner.rs) |
| Roc | [`roc/fuzz/runner.roc`](../roc/fuzz/runner.roc) |
| TypeScript | in this process ([`src/runners.ts`](src/runners.ts)) |

A new binding needs a program that reads `DIR/00000.haus` … `DIR/{N-1}.haus`
and prints those lines, plus an entry in `runners.ts`.

## When it finds something

Decide what the spec says, fix the parser (or the spec), and add the shrunk
input to [`../test-suite`](../test-suite) so it stays fixed.
