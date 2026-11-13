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
Rust and Roc. CI ([`ci.yml`](../.github/workflows/ci.yml)) runs both
fuzzers on every pull request with a new seed, and much longer every night;
a failure prints the seed and keeps the shrunk inputs as an artifact.

## How it works

| Step | |
|---|---|
| Generate | [`src/generate.ts`](src/generate.ts): random haus text with varied formatting (spacing, comments, CRLF, byte order mark, number spellings, quoted keys, block strings, both payload forms, trailing commas), values at and just past the limits, the conformance suite as seeds. Half of the inputs are then mutated: bytes deleted, edge characters inserted (quotes, `*/`, control and bidi characters, invalid UTF-8), slices duplicated, cut short. |
| Run | [`src/runners.ts`](src/runners.ts): each parser reads a batch of files and prints one line per file, `ok <values>` in the test-suite JSON encoding or `err <line> <column> <reason>`. The stream readers of Rust, Roc and TypeScript run too, on the same inputs cut into chunks (sizes 1, 2, 3, 5, 8, 13, 64 in turn), and must give what parsing the whole input gives. A runner that crashes is rerun case by case, and the crash counts as a disagreement. |
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
| Stream readers | the same runners with `--stream` (TypeScript: in this process) |

A new binding needs a program that reads `DIR/00000.haus` … `DIR/{N-1}.haus`
and prints those lines (with `--stream`: through its stream reader, chunk k
of case i being `[1, 2, 3, 5, 8, 13, 64][(i + k) % 7]` bytes), plus an entry
in `runners.ts`.

## Found so far

| | |
|---|---|
| Rust stream reader crashed on input ending in `/` | design review S13 |
| Stream readers accepted a byte order mark after a comma | design review S14 |
| Roc's std/time check accepted durations with more than ~309 digits (too large for a float) | fixed: exact integers |

## std/time

The same idea for the std/time checkers (spec §13.2,
[`std/time.md`](../spec/std/time.md)): generated strings through the Lean
model ([`spec/lean/Haus/Time`](../spec/lean/Haus/Time), proven to compute
the rules) and the TypeScript, Rust and Roc checkers, which must agree on
every one.

```sh
node fuzz/src/time.ts --count 2000000   # about half a minute
```

[`src/time.ts`](src/time.ts) builds strings for each type from their parts,
weighted towards the edges: leap and century years, day 29–32, `24:00:00`
and `:60`, fractions of 0, 9 and 10 digits, `-00:00` and `+24:00`, zones
with `.`, `..` and empty parts or 255–256 characters, durations at the 2³²
and 2⁵³ bounds and with hundreds of digits. Some are given to the wrong
type, and 40% are then mutated (characters removed, inserted or replaced
with separators, `NUL`, non-ASCII). A disagreeing string is shrunk like
above.

| Checker | Runner (`FILE` of lines `TYPE HEX`, the text as hex UTF-8; prints `ok` or `no`) |
|---|---|
| Lean | `haus-ref --time-batch FILE` ([`spec/lean/Main.lean`](../spec/lean/Main.lean)) |
| Rust | [`rust/haus/examples/time_runner.rs`](../rust/haus/examples/time_runner.rs) |
| Roc | [`roc/fuzz/time_runner.roc`](../roc/fuzz/time_runner.roc) |
| TypeScript | in this process |

## When it finds something

Decide what the spec says, fix the parser (or the spec), and add the shrunk
input to [`../test-suite`](../test-suite) so it stays fixed.
