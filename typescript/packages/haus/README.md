# @haus-fmt/haus

The haus data format for TypeScript and JavaScript: parser, writer, streams,
schemas, type inference and Standard Schema support. No dependencies.

```sh
npm install @haus-fmt/haus
```

> ⚠️ haus is a draft. Everything may still change.

## Read haus

```ts
import { parse, parsePlain } from "@haus-fmt/haus"

const text = `{ id: 1042, total: 30.30, status: Shipped, note: None }`

parse(text)        // the haus data model: { kind: "record", fields: Map { … } }
parsePlain(text)   // plain JS values: { id: 1042n, total: "30.30", status: "Shipped", note: null }
```

The plain view: strings, `bigint` for whole numbers (any size, so a field's type
never depends on its values), `string` for decimals (exact),
`boolean`, `Uint8Array` for bytes, `null` for `None`, string literals for tags
without payload, `{ _tag, … }` for other variants. A file with several values
(a stream) is an array.

## Validate with any schema library

Every [Standard Schema](https://standardschema.dev) works: Zod, Valibot, ArkType, Effect Schema, …

```ts
import { parseWith } from "@haus-fmt/haus"
import { z } from "zod"

const Order = z.object({ id: z.bigint(), total: z.string(), status: z.enum(["Pending", "Shipped"]) })
const order = parseWith(Order, text)   // typed; throws HausValidationError with the schema's issues
```

`parseWithAsync` is the same for schemas that validate asynchronously.

## haus schemas

Schemas that read haus exactly (big integers, exact decimals, dates, open
variants) and write it back. Every one is also a Standard Schema.

```ts
import * as h from "@haus-fmt/haus/schema"

const Order = h.Record({
  id: h.Int,
  total: h.Decimal,
  status: h.Variant({ Pending: h.Unit, Shipped: h.Record({ tracking: h.String }) }),
  note: h.Maybe(h.String),
})
type Order = h.Infer<typeof Order>

const order = h.parse(Order, text)       // mismatches fail with the path: expected Int, found string "2" at $.id
order.id                                 // 1042n: Int is a bigint of any size; Int32 etc. are numbers
const back = h.stringify(Order, order)   // haus text again
for await (const o of h.decodeStream(Order, response.body!)) { … }
```

Schemas from `.schema.haus` files:

```ts
import { compileSchemaFile } from "@haus-fmt/haus"
import { schemaOptions } from "@haus-fmt/haus/node"   // resolves imports from the file system

const { schemas } = compileSchemaFile(text, schemaOptions("order.schema.haus"))
const order = h.parse(schemas.Order!, data)
```

| schema file | `h.` schema | TypeScript |
|---|---|---|
| `String`, `Bytes`, `Bool` | `h.String`, `h.Bytes`, `h.Bool` | `string`, `Uint8Array`, `boolean` |
| `Int`, `Int64`, `UInt64` | `h.Int`, `h.Int64`, `h.UInt64` | `bigint` |
| `Int8` … `UInt32`, `Float32`, `Float64` | `h.Int8` …, `h.Float64` | `number` |
| `Decimal` | `h.Decimal` | `string`, the exact literal (`"19.90"`) |
| `Maybe a`, `Array a`, `Map v` | `h.Maybe`, `h.Array`, `h.Map` | `A \| null`, `readonly A[]`, `ReadonlyMap<string, V>` |
| `Date`, `Instant`, … (std/time) | `h.Date`, `h.StdTime("Instant")`, … | `string`, as written |
| `{ a: T, b?: T }` | `h.Record({ a, b: h.Optional(…) })` | `{ readonly a: T; readonly b?: T }` |
| `< A \| B { x: T } >` | `h.Variant`, `h.OpenVariant`, `h.Enum` | `{ _tag: "B"; x: T } \| …`, open: `\| Unknown` |
| `Any` | `h.Any` | `Value`: the parsed value, unchanged |
| `Secret a` | `h.Secret(a)` | `Secret<A>`: prints `<redacted>`, `expose()` gives the value |

A `Secret` hides its value from `console.log`, `String()` and
`JSON.stringify`, and errors inside one name its place and type, never the
value. Encode one with `h.Secret.make(value)`. `@deprecated` and other
attributes don't change decoding; the declarations (`schemaDeclarations`) mark
deprecated types, fields and tags with JSDoc `@deprecated`, `checkData` hints
where data uses them, and `parseSchemaFile(…).warnings` lists attributes this
version doesn't know and each place the schema uses a deprecated type.

An `Any` (or an unknown tag's raw value) is written back after the same checks
as parsing: pass the parser's limits to both if you raise them,
`h.parse(h.Any, text, { maxNumberLength: 5000 })` and
`h.encode(h.Any, value, { maxNumberLength: 5000 })`. Number literals built in
code are normalized as the parser would (`"1E5"` is written `1e5`).

## Write haus

```ts
import { format, parseDocument, stringify } from "@haus-fmt/haus"

stringify(value)                                   // one value in the standard layout
stringify(value, { style: "compact" })             // on one line
format(values)                                     // a file of values (a stream)

const { values, comments } = parseDocument(text)
format(values, { source: text, comments })         // reformat a file, comments kept
```

## Also inside

| | |
|---|---|
| `parseStream(chunks)` | values one by one, from any chunked source |
| `infer(values)`, `inferSchema` | the schema a file's data has |
| `parseSchemaFile`, `checkData` | schema files and checking data against them, with positions |
| `parseDocument`, `completeAt` | positions, comments and completions, for editors |

Typed `.haus` imports: [`@haus-fmt/import`](../import). Effect: [`@haus-fmt/effect`](../effect).
