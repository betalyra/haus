# @haus-fmt/effect

haus with [Effect](https://effect.website): decode and encode with Effect
schemas, streams of values, schemas from `.schema.haus` files, and codecs that
map haus types onto your own.

```sh
npm install @haus-fmt/effect effect
```

> ⚠️ haus is a draft. Everything may still change.

## Decode and encode

```ts
import * as Haus from "@haus-fmt/effect"
import { Effect, Schema } from "effect"

const Order = Schema.Struct({
  id: Schema.BigInt,
  total: Schema.BigDecimal,
  status: Haus.OpenUnion([Schema.TaggedStruct("Pending", {}), Schema.TaggedStruct("Shipped", { tracking: Schema.String })]),
  note: Schema.Option(Schema.String),
})

const program = Effect.gen(function* () {
  const order = yield* Haus.decode(Order)(text)                    // HausParseError | HausSchemaError, with positions
  return yield* Haus.encode(Order, { style: "compact" })(order)    // haus text again
})
```

| haus | Effect |
|---|---|
| `Circle { radius: 5 }` | `TaggedStruct("Circle", { radius })` |
| `Point(1, 2)` | `TaggedStruct("Point", { x, y })`, arguments fill fields in order |
| `True` / `False` | `Boolean` |
| `None` / `Some(x)` | `Option(X)`, or an optional key |
| `19.90` | `BigDecimal` (exact), `Number` (Float64), `Haus.Float32`, `BigInt`, or a string |
| `Instant("…")`, `ZonedDateTime("…")` | `DateTimeUtc`, `DateTimeZoned` |
| an unknown tag in `Haus.OpenUnion` | `{ _tag: "@unknown", tag, value }` |

Three of these keep the value but not every spelling of it. Encoding what they
decoded can write a different haus value, with another canonical form and
hash (spec §13.4):

- `BigDecimal` keeps the scale (`19.90` stays `19.90`), but not `-0` or
  exponent notation: `-0` is written `0`, `15e2` as `1.5e3`, `1.5e-3` as `0.0015`.
- `DateTime.Utc` (`Haus.Instant`) keeps the instant, not the offset or the
  fraction as written: `10:00:00.250+01:00` is written `09:00:00.250Z`.
  `Haus.InstantText` keeps the text.
- `DateTime.Zoned` (`Haus.ZonedDateTime`) likewise; `Haus.ZonedDateTimeText`
  keeps the text.

Hash and sign the parsed values, not re-encoded ones.

## Streams

```ts
const events = Haus.decodeStream(Event)(response.body!)    // Stream<Event, HausError>
const text = Haus.encodeStream(Event)(events)               // Stream<string>, one value per chunk
```

## Schema files

```ts
import { schemaOptions } from "@haus-fmt/haus/node"

const { schemas } = Haus.compileSchemaFile(text, schemaOptions("order.schema.haus"))
const order = yield* Haus.decode(schemas.Order!)(data)
```

`Int` → `bigint`, `Decimal` → `BigDecimal`, `Maybe` → `Option`, `Instant` →
`DateTime.Utc`. With [`@haus-fmt/import`](../import) (target `"effect"`), you can
import schema files directly: `import { Order } from "./order.schema.haus"`.

## Codecs

A codec is your choice of type for a named haus type, applied after the
schema's own checks:

```ts
import * as money from "@haus/money/money.schema.haus"

const cents = Haus.codec(money.Money, (base) => base.pipe(Schema.decodeTo(Cents, toCents)))
const order = yield* Haus.decode(Order, cents)(text)   // order.total: Cents
```

See the [order example](../../examples/order) for a complete one.
