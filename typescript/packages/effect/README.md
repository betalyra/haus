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
  total: Haus.Decimal,
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
| `None` / `Some(x)` | `Option(X)`; a missing field is not `None` (`optionalKey` for `x?: T`) |
| `19.90` | `Haus.Decimal`: the exact text, `"19.90"`; or `Number` (Float64), `Haus.Float32`, `BigInt` |
| `Instant("…")`, `ZonedDateTime("…")` | `Haus.Instant`, `Haus.ZonedDateTime`: the text as written |
| `Date("…")` and the other std/time types | `Haus.Date`, …: the text as written |
| an unknown tag in `Haus.OpenUnion` | `{ _tag: "@unknown", tag, value }` |
| any value (`Any`) | `Haus.Any`: the parsed haus `Value`, unchanged |
| a secret (`Secret a`) | `Schema.Redacted(A)`: shows `<redacted>`; errors inside never show the value |

These keep the value: encoding what they decoded writes an equal haus value
(spec §13.4), apart from what §15 drops by design (the spelling of a float,
`-0` as an integer, fields an open record ignores).

### Lossy Effect types, by choice

Effect's `BigDecimal` and `DateTime` keep less than the haus value. They are
there when you ask for them: as schemas for hand-written schemas, and as
codecs for schema files. Encoding what they decoded can write a different
haus value, with another canonical form and hash. Hash and sign the parsed
values, not re-encoded ones.

| Schema | Codec | Type | What it drops |
|---|---|---|---|
| `Haus.DecimalAsBigDecimal` | `Haus.decimalAsBigDecimal` | `BigDecimal` | exponent notation and `-0`: it keeps the scale (`19.90` stays `19.90`), but `-0` is written `0`, `15e2` as `1.5e3`, `1.5e-3` as `0.0015` |
| `Haus.InstantAsDateTime` | `Haus.instantAsDateTime` | `DateTime.Utc` | digits below the millisecond, the offset and the fraction as written: `10:00:00.250999+01:00` is written `09:00:00.250Z` |
| `Haus.ZonedDateTimeAsDateTime` | `Haus.zonedDateTimeAsDateTime` | `DateTime.Zoned` | the same, and zone names are looked up with Intl: an unknown zone is an error (std/time accepts any well-formed name), and a name Intl canonicalises is written that way (`Etc/UTC` as `UTC`) |

```ts
const Payment = Schema.Struct({ amount: Haus.DecimalAsBigDecimal, at: Haus.InstantAsDateTime })
const order = yield* Haus.decode(schemas.Order, Haus.decimalAsBigDecimal)(text)   // Decimals as BigDecimals
```

A DateTime that std/time can't write (a year beyond 9999) is an encoding
error: the writer never emits an invalid value. `Schema.BigDecimal`,
`Schema.DateTimeUtc` and `Schema.DateTimeZoned` work directly too, with the
same losses.

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

`Int` → `bigint`, `Decimal` → `string` (the exact text), `Maybe` → `Option`,
std/time types → `string` (the text as written), `Any` → `Haus.Value`,
`Secret a` → `Redacted<A>`. For `BigDecimal` and `DateTime`, pass the codecs
above. Attributes
don't change decoding; `schemaDeclarations` marks `@deprecated` types, fields
and tags with JSDoc `@deprecated`. With [`@haus-fmt/import`](../import) (target `"effect"`), you can
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
