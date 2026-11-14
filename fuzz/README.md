# Differential testing

Generated inputs go through every haus parser: the Lean reference parser
(`spec/lean`), Rust, Roc and TypeScript (and, with `--schema`, through
every schema decoder: see [Schema decoding](#schema-decoding)). They must agree on every input:
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
| Run | [`src/runners.ts`](src/runners.ts): each parser reads a batch of files and prints one line per file, `ok <values>` in the test-suite JSON encoding or `err <line> <column> <reason>`. The stream readers of Rust, Roc, TypeScript and Python run too, on the same inputs cut into chunks (sizes 1, 2, 3, 5, 8, 13, 64 in turn), and must give what parsing the whole input gives. A runner that crashes is rerun case by case, and the crash counts as a disagreement. |
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
| Python | [`python/fuzz/runner.py`](../python/fuzz/runner.py) |
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

## Canonical forms

`node fuzz/src/main.ts --canonical` runs the same inputs through each
binding's `canonical` (spec §12) instead of its parser: for every accepted
input, all bindings must write exactly the same text (the Lean reference encoder
through `haus-ref --canonical-batch`, the others through their runners with
`--canonical`).

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
and 2⁵³ bounds and with hundreds of digits, zero components among ones that
aren't, and zero seconds alone (`PT0S`, `PT0.000S`). Some are given to the wrong
type, and 40% are then mutated (characters removed, inserted or replaced
with separators, `NUL`, non-ASCII). A disagreeing string is shrunk like
above.

| Checker | Runner (`FILE` of lines `TYPE HEX`, the text as hex UTF-8; prints `ok` or `no`) |
|---|---|
| Lean | `haus-ref --time-batch FILE` ([`spec/lean/Main.lean`](../spec/lean/Main.lean)) |
| Rust | [`rust/haus/examples/time_runner.rs`](../rust/haus/examples/time_runner.rs) |
| Roc | [`roc/fuzz/time_runner.roc`](../roc/fuzz/time_runner.roc) |
| TypeScript | in this process |

## Schema decoding

The same idea for decoding with a schema (spec §15): generated values are
decoded with a type of the schema suite ([`test-suite/schema`](../test-suite/schema),
plus [`schema/fuzz.schema.haus`](schema/fuzz.schema.haus) for the integer
sizes, std/time types and nestings the suite leaves out) and encoded again,
by the Lean reference decoder and by each binding. They must agree on
accepting or rejecting, and on the canonical form (§12) of what is encoded;
error messages and places may differ.

```sh
sh fuzz/build.sh                               # also builds the schema runners
node fuzz/src/main.ts --schema --count 20000   # about 15 seconds
node fuzz/src/main.ts --schema --seed 7 --runners lean,typescript,rust
```

[`src/schema-gen.ts`](src/schema-gen.ts) generates a value for each type
from its resolved form (the JSON that
[`spec/lean/scripts/schema-types.ts`](../spec/lean/scripts/schema-types.ts)
writes for Lean): mostly values the type accepts, written with varied
formatting, and near misses: the wrong kind of value, missing and extra
fields, unknown tags in open and closed variants, the wrong number of
arguments, `Some` without its argument. Numbers sit on the edges: integers
at and just past each range and at the number limit (where the canonical
form switches to hex), `-0` in every spelling, floats as their exact decimal
value or exactly halfway to the next float (or a hair either side, which
catches rounding to binary64 before binary32), near overflow and underflow;
decimals with scales, exponents and negative zeros. Strings have escapes,
control and bidi characters and astral characters; keys sort differently by
code points and by UTF-16 units; `Any` gets arbitrary values; recursive
types sometimes go down to the nesting limit (256) and past it. A case that
disagrees is shrunk to the smallest value with the same pattern of
disagreement. An error inside a `Secret` that shows a part of the value is
reported too.

| Decoder | Runner (`FILE` of lines `SUITE TYPE HEX`, the value's text as hex UTF-8; prints `ok <canonical>` or `err …`) |
|---|---|
| Lean | `haus-ref --schema-batch TYPES FILE` ([`spec/lean/Main.lean`](../spec/lean/Main.lean)) |
| TypeScript | in this process: `compileSchemaFile`, `h.decode`, `h.encode` |
| Effect | in this process: `Haus.compileSchemaFile`, `decodeValue`, `encodeValue` |
| Rust | [`schema-rust`](schema-rust): the code haus-build generates for each schema |
| Roc | [`roc/schema_runner.roc`](roc/schema_runner.roc), with the modules `haus-gen roc` generates ([`roc/gen_schemas.ts`](roc/gen_schemas.ts)) |

Nothing is masked: every binding's default host types keep the value (spec
§13.4), so every runner must agree with Lean exactly. Lossy host types (Effect's
`BigDecimal` and `DateTime`) are opt-in codecs that the runners don't use.

## When it finds something

Decide what the spec says, fix the parser (or the spec), and add the shrunk
input to [`../test-suite`](../test-suite) so it stays fixed.
