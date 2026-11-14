# @haus-fmt/import

Import `.haus` files in TypeScript, with types:

```ts
import people from "./people.haus"              // no schema: typed by its data
import { Comment } from "./thread.schema.haus"  // a schema file: its types and schemas
import thread from "./thread.haus"              // typed by thread.schema.haus, checked against it
```

Two parts make an import work, and both come from one generator
([`generate.ts`](src/generate.ts)), so the types always match the values:

| Part | Gives | Set up |
|---|---|---|
| TypeScript 7.1 content mapper | the types, in the editor and in `tsc` | `tsconfig.json` |
| Node loader | the values when you run with Node or tsx | `--import @haus-fmt/import/register` |
| Vite plugin | the values in a Vite dev server or build | `vite.config.ts` |

## Targets

| Target | `.schema.haus` | data with a schema | data without a schema | needs |
|---|---|---|---|---|
| `"plain"` (default) | haus schemas (Standard Schemas) | decoded with them | plain JS values | nothing |
| `"effect"` | Effect schemas | decoded with Effect | plain JS values | `effect`, `@haus-fmt/effect` |

Plain, without a schema: strings, `bigint` for whole numbers, `string` for decimals
(exact), `boolean`, `Uint8Array`, string literal unions for tags without payload,
`{ _tag, … }` for other variants, `None` and `Some(x)` included (`{ _tag: "None" }`,
`{ _tag: "Some", value: x }`, so `Some(None)` stays apart from `None`), `key?:` for
fields only some records have.

Plain, with a schema: the same, plus `Int8` … `UInt32` and floats → `number`, std/time values → their text as written,
`Maybe a` → `Maybe<A>` (the same tagged form), `Map` → `ReadonlyMap`, open variants add `Unknown`, `Any` → `Value` (the parsed
value, unchanged) and `Secret a` → `Secret<A>`
(see [`@haus-fmt/haus`](../haus)).
With Effect: `Int` → `bigint`, `Decimal` → `string` (exact), std/time values → their text as written,
`Maybe` → `Option`, `Any` → `Haus.Value` and `Secret a` → `Redacted<A>`
(see [`@haus-fmt/effect`](../effect)). Every target keeps the value as
written; Effect's `BigDecimal` and `DateTime`, which don't, are codecs you
pass when decoding (`Haus.decimalAsBigDecimal`, `Haus.instantAsDateTime`).

A secret shows `<redacted>` when logged, and errors about one (at load time,
or in the editor) never show its value. Types, fields and tags marked
`@deprecated` in the schema are `@deprecated` in the declarations, so editors
strike them through.

Use the same target everywhere.

## Setup

```jsonc
// tsconfig.json (tsc 7.1: run it with --runExternalCode)
"contentMappers": [
  { "package": "@haus-fmt/import", "extensions": [".haus"], "options": { "target": "effect" } }
]
```

```sh
node --import @haus-fmt/import/register main.ts          # target "plain"
node --import @haus-fmt/import/register/effect main.ts   # target "effect"
```

```ts
// vite.config.ts
import haus from "@haus-fmt/import/vite"
export default { plugins: [haus({ target: "effect" })] }
```

With Vite, data without a schema is baked into the bundle as JavaScript values,
so no haus parser ships for it. Schema imports (`import @haus/money`) are resolved at
build time, and the schema files are watched.

In VS Code, typed imports need the TypeScript native preview extension, a trusted
workspace and permission to run content mappers.

## Without imports

To parse haus text yourself, use [`@haus-fmt/haus`](../haus): `parsePlain(text)` for the
plain values, or `parseWith(schema, text)` with any Standard Schema (Zod, Valibot,
ArkType, Effect Schema).
