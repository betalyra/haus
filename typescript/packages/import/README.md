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
| `"plain"` (default) | not yet | not yet | plain JS values | nothing |
| `"effect"` | Effect schemas | decoded with Effect | plain JS values | `effect`, `@haus-fmt/effect` |

Plain values: strings, `number` for whole numbers, `string` for decimals (exact),
`boolean`, `Uint8Array`, `T | null` for `Maybe`, string literal unions for tags without
payload, `{ _tag, … }` for other variants, `key?:` for fields only some records have.
With Effect: `Int` → `bigint`, `Decimal` → `BigDecimal`, `Maybe` → `Option`,
`Instant` → `DateTime.Utc` (see [`@haus-fmt/effect`](../effect)).

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

With Vite, plain data is baked into the bundle as JavaScript values, so no haus
parser ships to the browser. Schema imports (`import @haus/money`) are resolved at
build time, and the schema files are watched.

In VS Code, typed imports need the TypeScript native preview extension, a trusted
workspace and permission to run content mappers.

## Without imports

To parse haus text yourself, use [`@haus-fmt/haus`](../haus): `parsePlain(text)` for the
plain values, or `parseWith(schema, text)` with any Standard Schema (Zod, Valibot,
ArkType, Effect Schema).
