<h1>
  <img src="docs/assets/haus-light.svg#gh-light-mode-only" alt="" width="40" height="40" align="top">
  <img src="docs/assets/haus-dark.svg#gh-dark-mode-only" alt="" width="40" height="40" align="top">
  haus
</h1>

**A data format for humans: friendly to write, pleasant to read, and at home in your code.**

> ⚠️ **Highly experimental.** Everything may still change. Play with it, but don't use it in production.

## haus in a nutshell

haus lets your data say what it means. An order isn't a bag of strings and flags: it is `Shipped`, `Pending` or `Cancelled`, its total is exact `Money`, and an empty note is plainly `None`. You write it the way you'd sketch it in a notebook, with comments, no quoted keys and no fuss about the last comma. Your code reads it straight into real types.

```haus
// Comments are welcome, keys don't need quotes, trailing commas are fine.
{
  order: 1042,
  total: Money(30.30, EUR),
  status: Shipped { at: Instant("2026-11-08T09:12:00Z") },
  gift: True,
  note: None,
}
```

And a stream of events is just one item after another, which you can append to at any time:

```haus
UserCreated { id: 42, email: "jan@example.com" },
PaymentReceived { id: 42, amount: Money(19.99, EUR) },
Heartbeat,
```

New kinds of events can show up later: a reader that only cares about users just skips the rest, without breaking.

## Design goals

- 👀 **Easy to read for humans:** data should look like what it means.
- 🧩 **Extensible variants:** describe "one of these" directly, and let new cases appear without breaking older readers.
- 🤝 **Friendly:** comments, trailing commas, unquoted keys, multi-line text.
- 🌊 **Streaming by default:** every file is a sequence of values, so logs and event streams need no extra format.
- 🩹 **Fix the typical JSON issues:** no float surprises with money, no `null` vs missing-field confusion, real dates.

## Get started

- **Try it in the browser:** the [playground](https://haus-fmt.org/play) needs nothing installed.
- **VS Code:** install **haus** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=betalyra.haus), or run `code --install-extension betalyra.haus`. You get highlighting, errors as you type, types on hover, formatting and schema inference.
- **In your code:** libraries for [TypeScript](typescript/packages/haus) (with an [Effect adapter](typescript/packages/effect) and [typed imports](typescript/packages/import)), [Rust](rust), [Roc](roc) and [Python](python). See [Install](https://haus-fmt.org/docs/install).

## Learn more

The documentation lives at [haus-fmt.org/docs](https://haus-fmt.org/docs):

- [A tour of haus](https://haus-fmt.org/docs/tour): model the data of a small tool, one problem at a time.
- [Coming from JSON](https://haus-fmt.org/docs/from-json): the same data in JSON and in haus, and what changes.
- Guided tours: [evolving your data](https://haus-fmt.org/docs/tours/evolving), [logs and streams](https://haus-fmt.org/docs/tours/streams), [from schema to code](https://haus-fmt.org/docs/tours/typed), [time and money](https://haus-fmt.org/docs/tours/time-money).
- The [specification](spec/README.md), its [grammar](spec/grammar.ebnf), and the [Lean proofs](spec/lean) of the parser, the canonical form and std/time.

## Repository

| Path | Contents |
|---|---|
| [`spec/`](spec) | The specification: grammar, semantics, prelude, std/time, design review |
| [`spec/lean/`](spec/lean) | The Lean model and proofs, and `haus-ref`, the reference parser |
| [`test-suite/`](test-suite) | Conformance files every parser and schema binding must pass |
| [`typescript/`](typescript) | Parser, schemas, formatter, type inference, Standard Schema, Effect adapter, typed imports, examples |
| [`rust/`](rust) | Parser, `haus-build` (Rust and Roc types from schemas, with codecs), examples |
| [`roc/`](roc) | Parser, decoding, encoding, streams, examples |
| [`python/`](python) | Parser, streams, canonical form and hashing |
| [`extensions/`](extensions) | Official schema packages (`@haus/money`, `@haus/geo`) |
| [`editors/vscode/`](editors/vscode) | The VS Code extension |
| [`fuzz/`](fuzz) | Differential fuzzing of all implementations against each other and `haus-ref` |
| [`examples/`](examples) | Sample `.haus` and `.schema.haus` files shared by the examples |
| [`docs/`](docs), [`website/`](website) | The documentation and [haus-fmt.org](https://haus-fmt.org) |

## Development

```sh
cd typescript && pnpm install && pnpm test        # TypeScript packages
cd rust && cargo test --workspace --all-features  # Rust crates, conformance and schema suites
cd roc/package && roc test ConformanceTest.roc    # Roc conformance suite (also roc/schema-test)
cd python && uv run pytest                        # Python
cd spec/lean && lake build --wfail                # the proofs and haus-ref
```

TypeScript, Rust and Roc have the same three examples (quickstart, order, logs); see their READMEs for how to run them.
