# 🏠 haus

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

## Quick start: try it in VS Code

From a clone of this repository (needs Node 20+ and pnpm):

```sh
cd editors/vscode
pnpm install
pnpm run package                            # builds haus.vsix
code --install-extension haus.vsix --force
```

Reload VS Code (**Developer: Reload Window**) and open [`examples/person.haus`](examples/person.haus). Hover any key to see its inferred type, press Shift+Alt+F to format, or run **haus: Infer Schema from This File**. More in the [extension README](editors/vscode/README.md).

## Features

- 🏷️ **Variants:** `None`, `Some(30)`, `Circle { radius: 5 }`. Booleans are just `True` / `False`.
- 🧩 **Open records and variants:** unknown fields are ignored, unknown tags decode as "unknown" instead of failing.
- 🔢 **Exact numbers:** `19.90` stays `19.90`; there's no silent float rounding and no 2⁵³ limit.
- 📅 **Standard modules and packages:** dates and times are built in (`Date("2026-11-07")`, `Instant(…)`, `Duration("PT30S")`, `import std/time`); money (`Money(19.99, EUR)`) and geo come as schema packages (`import @haus/money`), imported when you need them. The always-present prelude stays small.
- 🧱 **Bytes:** binary data as hex, `x"9f86d081 884c7d65"`, instead of base64 inside a string.
- 🚫 **No `null`:** leave out what you don't have (`nickname?: String`), or say "no value" explicitly with `None`. Each has exactly one meaning, so updates can send just the fields that change.
- ✍️ **Pleasant to write:** unquoted keys, `//` and `/* */` comments, trailing commas, `"""` multi-line strings.
- 🌊 **Streams built in:** a file is a sequence of values, so appending, `tail -f` and line-by-line processing just work.
- 🎨 **One official format:** pretty (one entry per line) or compact (one item per line), like `gofmt`.
- 🔍 **Type inference:** derive a schema from example data.
- 🧩 **Open by default:** readers ignore fields and keep tags they don't know, so writers can add both without breaking anyone. `closed { … }` / `closed < … >` where only the listed ones are allowed.
- ✅ **Checked in the editor:** a data file is checked against `x.schema.haus` next to it, or the schema named in a `// schema: ./api.schema.haus#Order` comment. Errors where something is wrong, a quiet hint on fields the schema doesn't know.
- 🛡️ **Hardened:** depth, number and string limits, rejection of invisible bidi control characters, and schema decoding that stays linear in the input, even with recursive types.

## The same order in JSON

```json
{
  "order": 1042,
  "total": { "amount": "30.30", "currency": "EUR" },
  "status": { "type": "shipped", "at": "2026-11-08T09:12:00Z" },
  "gift": true,
  "note": null
}
```

It works, but every one of these choices is a convention you have to explain and everyone has to follow. In haus they are part of the format.

## Using it from TypeScript

```ts
import * as h from "@betalyra/haus-fmt/schema"

const Status = h.Variant({
  Pending: h.Unit,
  Shipped: h.Record({ at: h.Instant }),
})
const Order = h.Record({ id: h.Int, total: h.Decimal, status: Status, note: h.Maybe(h.String) })
type Order = h.Infer<typeof Order>

const order = h.parse(Order, text)   // typed; mismatches fail with e.g. `expected Int, found string "2" at $.id`
const back = h.stringify(Order, order)
```

There is also an [Effect adapter](typescript/packages/effect) (`Haus.decode(schema)`, `Haus.encodeStream(schema)`), and bindings for [Rust](rust) and [Roc](roc), with the same examples on the same files.

### Typed imports (TypeScript 7.1, experimental)

With the [content mapper](typescript/packages/content-mapper), `.haus` files are imported like modules:

```ts
import { Comment } from "./thread.schema.haus"   // the type and its Effect schema
import thread from "./thread.haus"               // typed by thread.schema.haus (type Root), checked against it

thread.replies[0].likes                          // bigint
Haus.decode(Comment)(text)                       // the schema works for any input
```

Data that doesn't match its schema is an error in the editor, at the value that's wrong. A data file without a schema next to it gets a type inferred from its data. See the [quickstart](typescript/examples/quickstart).

## Repository

| Path | Contents |
|---|---|
| [`spec/`](spec) | Grammar, semantics, standard format, prelude types |
| [`test-suite/`](test-suite) | Conformance files every parser must pass |
| [`typescript/`](typescript) | Parser, schemas, formatter, type inference, Effect adapter, content mapper, examples, demos |
| [`rust/`](rust) | Parser, `haus-build` (Rust types from schemas, with codecs), examples |
| [`extensions/`](extensions) | Official schema packages (`@haus/money`, `@haus/geo`), for npm and crates.io |
| [`roc/`](roc) | Parser, decoding, encoding, streams; modules generated from schemas; examples |
| [`editors/vscode/`](editors/vscode) | VS Code extension: highlighting, errors, hover with inferred types, formatting |
| [`examples/`](examples) | Sample `.haus` and `.schema.haus` files, shared by the TypeScript and Rust examples |
| [`docs/`](docs) | Design review and open issues |

```sh
cd typescript && pnpm install && pnpm test        # TypeScript packages
cd typescript/examples/quickstart && pnpm start   # typed data, decode, encode, errors
cd typescript/examples/order && pnpm start        # schema packages and codecs
cd typescript/examples/logs && pnpm start         # a stream, entry by entry
cd rust && cargo test                             # Rust crates and the conformance suite
cd rust && cargo run -p haus-example-quickstart   # the same quickstart in Rust
cd rust && cargo run -p haus-example-order        # the same order example in Rust
cd rust && cargo run -p haus-example-logs         # the same stream example in Rust
cd roc/package && roc test ConformanceTest.roc    # Roc conformance suite
cd roc/examples/quickstart && roc main.roc        # the same quickstart in Roc (also order, logs)
```
