import { readFile } from "node:fs/promises"
import { createReadStream } from "node:fs"
import * as Haus from "@haus-fmt/effect"
import { BigDecimal, Console, DateTime, Effect, Match, Option, Stream } from "effect"
import { Order, OrderStatus, ShopEvent, type Money } from "./model.ts"

const dataPath = (file: string) => new URL(`../data/${file}`, import.meta.url)
const readData = (file: string) => Effect.promise(() => readFile(dataPath(file), "utf8"))

/** Keeps the scale as written: 7.90 stays "7.90" (BigDecimal.format would print 7.9). */
const formatDecimal = ({ value, scale }: BigDecimal.BigDecimal) => {
  if (scale <= 0) return (value * 10n ** BigInt(-scale)).toString()
  const digits = (value < 0n ? -value : value).toString().padStart(scale + 1, "0")
  return `${value < 0n ? "-" : ""}${digits.slice(0, -scale)}.${digits.slice(-scale)}`
}

const formatMoney = ({ amount, currency }: Money) =>
  `${formatDecimal(amount)} ${typeof currency === "string" ? currency : currency.tag}`

/** Exhaustive: adding a case to OrderStatus makes this fail to compile. */
const describeStatus = Match.type<OrderStatus>().pipe(
  Match.tagsExhaustive({
    Pending: () => "pending",
    Paid: ({ at }) => `paid on ${DateTime.formatIso(at)}`,
    Shipped: ({ at, tracking }) => `shipped on ${DateTime.formatIso(at)} (tracking: ${Option.getOrElse(tracking, () => "none")})`,
    Cancelled: ({ reason }) => `cancelled: ${reason}`,
  }),
)

// ── 1. Decode a document ─────────────────────────────────────

const decodeOrder = Effect.gen(function* () {
  yield* Console.log("── 1. order.haus → Order")
  const order = yield* Haus.decode(Order)(yield* readData("order.haus"))
  yield* Console.log(`order #${order.id} placed ${order.placedOn} by ${order.customer.name}`)
  for (const item of order.items) yield* Console.log(`  ${item.quantity} × ${item.sku} @ ${formatMoney(item.price)}`)

  // Exact arithmetic: amounts are BigDecimal, never floats.
  const total = order.items
    .map((i) => BigDecimal.multiply(i.price.amount, BigDecimal.fromNumberUnsafe(i.quantity)))
    .reduce(BigDecimal.sum, BigDecimal.fromNumberUnsafe(0))
  yield* Console.log(`  total:  ${formatDecimal(total)}`)
  yield* Console.log(`  status: ${describeStatus(order.status)}`)
  yield* Console.log(`  note:   ${Option.getOrElse(order.note, () => "(none)")}`)
})

// ── 2. Decode a stream ───────────────────────────────────────

const describeEvent = Match.type<typeof ShopEvent.Type>().pipe(
  Match.tagsExhaustive({
    OrderPlaced: ({ orderId, total }) => `order ${orderId} placed, total ${formatMoney(total)}`,
    OrderShipped: ({ orderId, at }) => `order ${orderId} shipped at ${DateTime.formatIso(at)}`,
    "@unknown": ({ tag }) => `(ignoring unknown event ${tag})`,
  }),
)

const decodeEvents = Effect.gen(function* () {
  yield* Console.log("\n── 2. events.haus → Stream<ShopEvent>")
  yield* Haus.decodeStream(ShopEvent)(createReadStream(dataPath("events.haus"), { highWaterMark: 16 })).pipe(
    Stream.map(describeEvent),
    Stream.runForEach((line) => Console.log(`  ${line}`)),
  )
})

// ── 3. Typed errors ──────────────────────────────────────────

const failures = Effect.gen(function* () {
  yield* Console.log("\n── 3. failures")
  const valid = yield* readData("order.haus")
  const broken: ReadonlyArray<readonly [string, string]> = [
    ["quantity is a string", valid.replace("quantity: 2", 'quantity: "2"')],
    ["quantity is zero", valid.replace("quantity: 2", "quantity: 0")],
    ["required field missing", valid.replace('email: "ada@example.com",', "")],
    ["unknown status tag", valid.replace("status: Shipped", "status: Lost")],
    ["Money with one argument", valid.replace("Money(14.50, EUR)", "Money(14.50)")],
    ["syntax error", valid.replace("id: 1042,", "id: 1042")],
  ]
  yield* Effect.forEach(broken, ([label, text]) =>
    Haus.decode(Order)(text).pipe(
      Effect.matchEffect({
        onSuccess: () => Console.log(`  ${label}: unexpectedly OK`),
        onFailure: Effect.fn(function* (error) {
          // Typed errors: HausParseError | HausSchemaError
          const where = error._tag === "HausParseError" ? ` (line ${error.line})` : ""
          yield* Console.log(`  ${label}: ${error._tag}${where}\n    ${error.message.replaceAll("\n", "\n    ")}`)
        }),
      }),
    ))
})

// ── 4. Encode typed values back to haus ──────────────────────

const encodeOrder = Effect.gen(function* () {
  yield* Console.log("\n── 4. encode")
  const order = yield* Haus.decode(Order)(yield* readData("order.haus"))
  const updated: Order = { ...order, status: { _tag: "Cancelled", reason: "customer request" }, note: Option.some("refund issued") }
  yield* Console.log(yield* Haus.encode(Order)(updated))
})

Effect.runPromise(Effect.andThen(decodeOrder, decodeEvents).pipe(Effect.andThen(failures), Effect.andThen(encodeOrder)))
