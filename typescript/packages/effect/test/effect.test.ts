import { describe, expect, it } from "@effect/vitest"
import { BigDecimal, DateTime, Effect, Option, Schema, Stream } from "effect"
import * as Haus from "../src/index.js"

const Currency = Schema.Literals(["EUR", "USD", "GBP"])
const Money = Haus.Positional(Schema.TaggedStruct("Money", { amount: Schema.BigDecimal, currency: Currency }))

const UserCreated = Schema.TaggedStruct("UserCreated", { id: Schema.Number, email: Schema.String, at: Schema.DateTimeUtc })
const UserRenamed = Schema.TaggedStruct("UserRenamed", { id: Schema.Number, from: Schema.String, to: Schema.String })
const PaymentReceived = Schema.TaggedStruct("PaymentReceived", { id: Schema.Number, amount: Money })
const Heartbeat = Schema.TaggedStruct("Heartbeat", {})

/** The server only handles user events; everything else is Unknown. */
const ServerEvent = Haus.OpenUnion([UserCreated, UserRenamed])
const AppEvent = Schema.Union([UserCreated, UserRenamed, PaymentReceived, Heartbeat])

const Order = Schema.Struct({
  id: Schema.Number,
  total: Money,
  paid: Schema.Boolean,
  note: Schema.Option(Schema.String),
  tracking: Schema.optionalKey(Schema.String),
  coupon: Schema.OptionFromOptionalKey(Schema.String),
  tags: Schema.Array(Schema.String),
  origin: Haus.Positional(Schema.TaggedStruct("Point", { x: Schema.Number, y: Schema.Number })),
})

describe("decode", () => {
  it.effect("records, variants, exact decimals, Option and optional keys", () =>
    Effect.gen(function* () {
      const order = yield* Haus.decode(Order)(`{
        id: 1, total: Money(19.90, EUR), paid: True, note: Some("gift"),
        tags: ["a", "b"], origin: Point(1, 2), extra: "ignored",
      }`)
      expect(order.id).toBe(1)
      expect(BigDecimal.equals(order.total.amount, BigDecimal.fromStringUnsafe("19.90"))).toBe(true)
      expect(order.total.currency).toBe("EUR")
      expect(order.paid).toBe(true)
      expect(order.note).toEqual(Option.some("gift"))
      expect("tracking" in order).toBe(false)
      expect(order.coupon).toEqual(Option.none())
      expect(order.origin).toEqual({ _tag: "Point", x: 1, y: 2 })
    }))

  it.effect("bytes decode to Uint8Array and back", () =>
    Effect.gen(function* () {
      const S = Schema.Struct({ key: Schema.Uint8Array })
      const v = yield* Haus.decode(S)('{ key: x"0b34 ff" }')
      expect(v.key).toEqual(Uint8Array.from([0x0b, 0x34, 0xff]))
      expect(yield* Haus.encode(S, { style: "compact" })(v)).toBe('{ key: x"0b34ff" }')
    }))

  it.effect("an optional key is never None: missing and None are different things", () =>
    Effect.gen(function* () {
      const S = Schema.Struct({ tracking: Schema.optionalKey(Schema.String), note: Schema.Option(Schema.String) })
      expect(yield* Haus.decode(S)("{ note: None }")).toEqual({ note: Option.none() })
      const noneForString = yield* Effect.flip(Haus.decode(S)("{ tracking: None, note: None }"))
      expect(noneForString.message).toContain("Expected string")
      // A Maybe (Option) must be written: missing is not None.
      const missingOption = yield* Effect.flip(Haus.decode(S)("{}"))
      expect(missingOption.message).toContain("note")
    }))

  it.effect("decimals beyond float precision stay exact", () =>
    Effect.gen(function* () {
      const n = yield* Haus.decode(Schema.BigDecimal)("0.1000000000000000000000000001")
      expect(BigDecimal.equals(n, BigDecimal.fromStringUnsafe("0.1000000000000000000000000001"))).toBe(true)
      expect(BigDecimal.equals(n, BigDecimal.fromStringUnsafe("0.1"))).toBe(false)
    }))

  it.effect("instants become DateTime.Utc", () =>
    Effect.gen(function* () {
      const e = yield* Haus.decode(UserCreated)('UserCreated { id: 1, email: "a@b", at: Instant("2026-11-07T10:00:00Z") }')
      expect(DateTime.formatIso(e.at)).toBe("2026-11-07T10:00:00.000Z")
    }))

  it.effect("open unions of literals: known tags as strings, others as Unknown", () =>
    Effect.gen(function* () {
      const OpenCurrency = Haus.OpenUnion([Schema.Literals(["EUR", "USD"])])
      const all = yield* Haus.decode(Schema.Array(OpenCurrency))("[EUR, CHF]")
      expect(all[0]).toBe("EUR")
      expect(all[1]).toMatchObject({ _tag: "@unknown", tag: "CHF" })
    }))

  it.effect("open unions keep unknown tags", () =>
    Effect.gen(function* () {
      const e = yield* Haus.decode(ServerEvent)("PaymentReceived { id: 1, amount: Money(1, EUR) }")
      expect(e._tag).toBe("@unknown")
      if (e._tag === "@unknown") expect(e.tag).toBe("PaymentReceived")
    }))
})

describe("design rules", () => {
  it.effect("positional payloads need Haus.Positional", () =>
    Effect.gen(function* () {
      const Point = Schema.TaggedStruct("Point", { x: Schema.Number, y: Schema.Number })
      const e = yield* Effect.flip(Haus.decode(Point)("Point(1, 2)"))
      expect(e.message).toContain("write Point { x: …, y: … } or wrap its schema in Haus.Positional")
      expect(yield* Haus.decode(Point)("Point { x: 1, y: 2 }")).toEqual({ _tag: "Point", x: 1, y: 2 })
      expect(yield* Haus.decode(Haus.Positional(Point))("Point(1, 2)")).toEqual({ _tag: "Point", x: 1, y: 2 })
    }))

  it.effect("partial updates: optionalKey(Option(X)) keeps not given, None and Some apart", () =>
    Effect.gen(function* () {
      const UserUpdate = Schema.Struct({ nickname: Schema.optionalKey(Schema.Option(Schema.String)) })
      expect(yield* Haus.decode(UserUpdate)("{}")).toEqual({})
      expect(yield* Haus.decode(UserUpdate)("{ nickname: None }")).toEqual({ nickname: Option.none() })
      expect(yield* Haus.decode(UserUpdate)('{ nickname: Some("J") }')).toEqual({ nickname: Option.some("J") })
    }))

  it.effect("Number accepts NaN and infinities", () =>
    Effect.gen(function* () {
      expect(yield* Haus.decode(Schema.Array(Schema.Number))("[NaN, Infinity, NegInfinity]")).toEqual([NaN, Infinity, -Infinity])
    }))
})

describe("security", () => {
  it.effect("a __proto__ key can't inject fields", () =>
    Effect.gen(function* () {
      const S = Schema.Struct({ role: Schema.optionalKey(Schema.String) })
      const decoded = yield* Haus.decode(S)('{ "__proto__": { role: "admin" } }')
      expect("role" in decoded).toBe(false)
      expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype)
    }))
})

describe("decodeStream", () => {
  const stream = (chunks: string[]) => Stream.fromIterable(chunks).pipe(Stream.toReadableStream())

  it.effect("decodes the repo's stream example, chunk by chunk", () =>
    Effect.gen(function* () {
      const text = yield* Effect.promise(() => import("node:fs/promises").then((fs) => fs.readFile(new URL("../../../../examples/events.haus", import.meta.url), "utf8")))
      const chunks = text.match(/[\s\S]{1,7}/g) ?? []

      const server = yield* Stream.runCollect(Haus.decodeStream(ServerEvent)(stream(chunks)))
      expect(server.map((e) => (e._tag === "@unknown" ? `?${e.tag}` : e._tag))).toEqual(["UserCreated", "UserRenamed", "?PaymentReceived", "?Heartbeat"])

      const app = yield* Stream.runCollect(Haus.decodeStream(AppEvent)(stream(chunks)))
      expect(app.map((e) => e._tag)).toEqual(["UserCreated", "UserRenamed", "PaymentReceived", "Heartbeat"])
    }))

  it.effect("errors carry the element index", () =>
    Effect.gen(function* () {
      const error = yield* Stream.runCollect(Haus.decodeStream(AppEvent)(stream(["Heartbeat, UserRenamed { id: 1 },"]))).pipe(Effect.flip)
      expect(error._tag).toBe("HausSchemaError")
      if (error._tag === "HausSchemaError") expect(error.index).toBe(1)
    }))
})

describe("errors", () => {
  it.effect.each([
    { schema: Order, src: "{ id: \"1\" }", tag: "HausSchemaError", message: "Expected number" },
    { schema: AppEvent, src: "Refunded { id: 1 }", tag: "HausSchemaError", message: "" },
    { schema: Money, src: "Money(19.99, CHF)", tag: "HausSchemaError", message: 'Expected "EUR" | "USD" | "GBP"\n  at ["currency"]' },
    { schema: Schema.Boolean, src: "true", tag: "HausParseError", message: "booleans are the variants True / False" },
    { schema: Schema.Number, src: "1, 2", tag: "HausSchemaError", message: "exactly one value" },
  ] as const)("$src", ({ schema, src, tag, message }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Haus.decode(schema as Schema.Top as Schema.Codec<unknown>)(src))
      expect(error._tag).toBe(tag)
      expect(error.message).toContain(message)
    }))
})

describe("encode", () => {
  it.effect("writes haus that decodes back to the same value", () =>
    Effect.gen(function* () {
      const src = `{
        id: 1, total: Money(19.90, EUR), paid: True, note: Some("gift"),
        tags: ["a", "b"], origin: Point(1, 2), coupon: Some("X"),
      }`
      const order = yield* Haus.decode(Order)(src)
      const text = yield* Haus.encode(Order)(order)
      expect(text).toBe(
        '{\n  id: 1,\n  total: Money(19.90, EUR),\n  paid: True,\n  note: Some("gift"),\n  coupon: "X",\n  tags: [\n    "a",\n    "b",\n  ],\n  origin: Point(1, 2),\n}',
      )
      expect(yield* Haus.decode(Order)(text)).toEqual(order)
    }))

  it.effect("DateTime, Unknown passthrough and open literals", () =>
    Effect.gen(function* () {
      const created = yield* Haus.decode(UserCreated)('UserCreated { id: 1, email: "a@b", at: Instant("2026-11-07T10:00:00Z") }')
      expect(yield* Haus.encode(UserCreated, { style: "compact" })(created)).toBe('UserCreated { id: 1, email: "a@b", at: Instant("2026-11-07T10:00:00Z") }')
      const events = yield* Haus.decode(Schema.Array(ServerEvent))("[Refunded { id: 7 }]")
      expect(yield* Haus.encode(Schema.Array(ServerEvent), { style: "compact" })(events)).toBe("[Refunded { id: 7 }]")
      const OpenCurrency = Haus.OpenUnion([Schema.Literals(["EUR", "USD"])])
      const all = yield* Haus.decode(Schema.Array(OpenCurrency))("[EUR, CHF]")
      expect(yield* Haus.encode(Schema.Array(OpenCurrency), { style: "compact" })(all)).toBe("[EUR, CHF]")
    }))

  it.effect("Haus.Date keeps the Date(…) tag in both directions", () =>
    Effect.gen(function* () {
      const S = Schema.Struct({ day: Haus.Date })
      const v = yield* Haus.decode(S)('{ day: Date("2026-11-07") }')
      expect(v).toEqual({ day: "2026-11-07" })
      expect(yield* Haus.encode(S, { style: "compact" })(v)).toBe('{ day: Date("2026-11-07") }')
      expect((yield* Effect.flip(Haus.decode(S)('{ day: Date("07.11.2026") }')))._tag).toBe("HausSchemaError")
    }))

  it.effect("encodeStream: comma-terminated chunks that decode back", () =>
    Effect.gen(function* () {
      const events = [{ _tag: "Heartbeat" as const }, { _tag: "UserRenamed" as const, id: 1, from: "a", to: "b" }]
      const chunks = yield* Stream.runCollect(Haus.encodeStream(AppEvent)(Stream.fromIterable(events)))
      expect(chunks.join("")).toBe('Heartbeat,\nUserRenamed { id: 1, from: "a", to: "b" },\n')
      const back = yield* Stream.runCollect(Haus.decodeStream(AppEvent)([chunks.join("")]))
      expect(back).toEqual(events)
    }))

  it.effect("schema violations fail with HausSchemaError", () =>
    Effect.gen(function* () {
      const e = yield* Effect.flip(Haus.encode(Order)({ id: "x" } as never))
      expect(e._tag).toBe("HausSchemaError")
    }))
})
