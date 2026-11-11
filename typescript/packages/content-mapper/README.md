# Typed `.haus` imports (TypeScript 7.1 content mapper)

```ts
import { Comment } from "./thread.schema.haus"  // type + Effect schema
import thread from "./thread.haus"             // typed by thread.schema.haus, checked
import people from "./person.haus"             // no schema: type inferred from the data

thread.likes                         // bigint (Int)
people[0].profession._tag            // "Engineer" | "Designer" | "Manager"
```

This content mapper gives TypeScript a module for every imported `.haus` file:

| File | Module |
|---|---|
| `x.schema.haus` | its types (`export type Comment = …`) and their Effect schemas (`export const Comment`) |
| `x.haus` with `x.schema.haus` next to it | `export default`, typed by the schema's `Root`; data that doesn't match is an error at the wrong value |
| any other `x.haus` | `export default`, with a type inferred from the data |

A Node loader provides the same values at runtime (schema-checked data is decoded
with Effect, so a mismatch throws with its position).

Set it up in `tsconfig.json`, and load `.haus` files at runtime with the register hook:

```jsonc
// tsconfig.json
"contentMappers": [{ "package": "@betalyra/haus-fmt-content-mapper", "extensions": [".haus"] }]
```

```sh
tsc --noEmit --runExternalCode                                           # typecheck (tsc 7.1)
tsx --import @betalyra/haus-fmt-content-mapper/register src/main.ts     # run
```

The [examples](../../examples) are set up this way.

In VS Code, typed imports need the TypeScript native preview extension, a
trusted workspace and permission to run content mappers. After changing a
schema file, the data file's errors update when the data file is next checked
(edit it, or restart the TS server).

**With a schema** (Effect): `Int` → `bigint`, `Decimal` → `BigDecimal`, `Maybe` →
`Option`, `Instant` → `DateTime.Utc`, tags without payload → string literals,
other variants → `{ _tag, … }` (positional arguments in `values`), `x?:` → optional key.
See [`schema-file.ts`](../effect/src/schema-file.ts).

**Without a schema**: strings, `Uint8Array` for bytes, `number` for whole numbers
and `string` for decimals (exact), `boolean`, `T | null` for `Maybe`, string
literal unions for tags without payload, `{ _tag, … }` for other variants,
`key?:` for fields only some records have, and named type aliases for recursive
data. See [`plain.ts`](src/plain.ts).

