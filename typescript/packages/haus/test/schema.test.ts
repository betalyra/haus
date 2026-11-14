import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import * as h from "../src/schema.js"

/** Run a throwing schema call, failing with HausDecodeError. */
const decoding = <A>(f: () => A): Effect.Effect<A, h.HausDecodeError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(f())
    } catch (e) {
      return e instanceof h.HausDecodeError ? Effect.fail(e) : Effect.die(e)
    }
  })

/** Collect a decodeStream, failing with HausDecodeError. */
const collect = <A>(it: AsyncIterable<A>) =>
  Stream.fromAsyncIterable(it, (e) => e).pipe(
    Stream.runCollect,
    Effect.catch((e) => (e instanceof h.HausDecodeError ? Effect.fail(e) : Effect.die(e))),
  )

const Currency = h.OpenVariant({ EUR: h.Unit, USD: h.Unit })
const Money = h.Variant({ Money: h.Tuple(h.Decimal, Currency) })
const Event = h.OpenVariant({
  UserCreated: h.Record({ id: h.Int, email: h.String }),
  Paid: h.Record({ amount: Money, at: h.InstantAsDate }),
  Heartbeat: h.Unit,
})
const Shape = h.Variant({
  Circle: h.Record({ radius: h.Float64 }),
  Point: h.Tuple(h.Float64, h.Float64),
  Label: h.String,
})

describe("decoding", () => {
  it("scalars", () => {
    expect(h.parse(h.Record({ n: h.Int, i: h.Int32, b: h.Int64, f: h.Float64, d: h.Decimal, ok: h.Bool, s: h.String, day: h.Date }),
      '{ n: 42, i: -7, b: 1234567890123456789, f: 0.5, d: 19.90, ok: True, s: "x", day: Date("2026-11-07") }'))
      .toEqual({ n: 42n, i: -7, b: 1234567890123456789n, f: 0.5, d: "19.90", ok: true, s: "x", day: "2026-11-07" })
  })

  it("Int is a bigint of any size, and writes back unchanged", () => {
    const text = "340282366920938463463374607431768211457" // 2^128 + 1
    expect(h.parse(h.Int, text)).toBe(2n ** 128n + 1n)
    expect(h.stringify(h.Int, h.parse(h.Int, text))).toBe(text)
    expect(h.parse(h.Int, "-" + "9".repeat(500))).toBe(-(10n ** 500n - 1n))
  })

  it("Int8 … UInt64 are bounded: JS numbers up to 32 bits, bigints for 64", () => {
    expect(h.parse(h.Array(h.UInt8), "[0, 255]")).toEqual([0, 255])
    expect(h.parse(h.Int32, "-2147483648")).toBe(-2147483648)
    expect(h.parse(h.UInt64, "18446744073709551615")).toBe(2n ** 64n - 1n)
    expect(() => h.parse(h.UInt8, "256")).toThrow("256 is out of range for UInt8 (0 to 255)")
    expect(() => h.parse(h.Int32, "9".repeat(400))).toThrow("is out of range for Int32")
    expect(() => h.parse(h.Int64, "9223372036854775808")).toThrow("out of range for Int64")
    expect(() => h.encode(h.Int16, 40000)).toThrow("expected an integer from -32768 to 32767, got 40000")
    expect(h.stringify(h.UInt64, 2n ** 64n - 1n)).toBe("18446744073709551615")
  })

  it("variant cases: unit, record, tuple, single value", () => {
    expect(h.parse(h.Array(Shape), '[Circle { radius: 2 }, Point(1, 2), Label("hi")]')).toEqual([
      { _tag: "Circle", radius: 2 },
      { _tag: "Point", values: [1, 2] },
      { _tag: "Label", value: "hi" },
    ])
  })

  it("open variants keep unknown tags", () => {
    const [a, b] = h.parse(h.Array(Event), "[Heartbeat, Refunded { id: 1 }]")
    expect(a).toEqual({ _tag: "Heartbeat" })
    expect(b?._tag).toBe("@unknown")
    expect(b?._tag === "@unknown" && b.tag).toBe("Refunded")
  })

  it("Maybe is always written: None and Some(…); a missing field is an error", () => {
    const S = h.Array(h.Record({ v: h.Maybe(h.Int) }))
    expect(h.parse(S, "[{ v: None }, { v: Some(1) }]")).toEqual([{ v: null }, { v: 1n }])
    expect(() => h.parse(S, "[{}]")).toThrow("missing field 'v' at $[0]")
    expect(() => h.parse(S, "[{ v: 1 }]")).toThrow("expected None | Some(Int), found number 1")
  })

  it("Optional: a field that may be missing stays missing", () => {
    const Person = h.Record({ name: h.String, age: h.Optional(h.UInt8) })
    const people = h.parse(h.Array(Person), '[{ name: "Hans", age: 32 }, { name: "Mickey" }]')
    expect(people).toEqual([{ name: "Hans", age: 32 }, { name: "Mickey" }])
    expect(Object.hasOwn(people[1]!, "age")).toBe(false)
    // None is not "missing": for an Optional(UInt8) it's simply not a UInt8.
    expect(() => h.parse(Person, '{ name: "Mickey", age: None }')).toThrow("expected UInt8, found variant None")
  })

  it("Optional(Maybe(…)): not given, None and Some stay apart (partial updates)", () => {
    const UserUpdate = h.Record({ name: h.Optional(h.String), nickname: h.Optional(h.Maybe(h.String)) })
    expect(h.parse(UserUpdate, "{}")).toEqual({})
    expect(h.parse(UserUpdate, '{ name: "Jan", nickname: None }')).toEqual({ name: "Jan", nickname: null })
    expect(h.parse(UserUpdate, '{ nickname: Some("J") }')).toEqual({ nickname: "J" })
  })

  it("Bytes and Map", () => {
    expect(h.parse(h.Bytes, 'x"0b34 FF"')).toEqual(Uint8Array.from([0x0b, 0x34, 0xff]))
    expect(h.stringify(h.Bytes, Uint8Array.from([0, 255]))).toBe('x"00ff"')
    const Greetings = h.Map(h.String)
    const m = h.parse(Greetings, '{ en: "Hello", "pt-BR": "Olá", "__proto__": "x" }')
    expect([...m]).toEqual([["en", "Hello"], ["pt-BR", "Olá"], ["__proto__", "x"]])
    expect(h.stringify(Greetings, m, { style: "compact" })).toBe('{ en: "Hello", "pt-BR": "Olá", __proto__: "x" }')
    expect(() => h.parse(Greetings, "{ en: 1 }")).toThrow("expected String, found number 1 at $.en")
  })

  it("Float64 accepts NaN and infinities", () => {
    expect(h.parse(h.Array(h.Float64), "[NaN, Infinity, NegInfinity, 1.5]")).toEqual([NaN, Infinity, -Infinity, 1.5])
  })

  it("records are open unless closed", () => {
    expect(h.parse(h.Record({ a: h.Int }), "{ a: 1, extra: 2 }")).toEqual({ a: 1n })
  })

  it.effect("decodeStream yields typed values", () =>
    Effect.gen(function* () {
      const events = yield* collect(h.decodeStream(Event, ['UserCreated { id: 1, email: "a@b" },', " Heartbeat,"]))
      expect(events).toEqual([{ _tag: "UserCreated", id: 1n, email: "a@b" }, { _tag: "Heartbeat" }])
    }))
})

describe("errors", () => {
  it.effect.each([
    { schema: h.Record({ id: h.Int }), src: '{ id: "1" }', reason: 'expected Int, found string "1"', path: "$.id" },
    { schema: h.Record({ id: h.Int }), src: "{}", reason: "missing field 'id'", path: "$" },
    { schema: h.Int32, src: "2147483648", reason: "2147483648 is out of range for Int32", path: "$" },
    { schema: h.Int, src: "1.5", reason: "expected Int, found number 1.5", path: "$" },
    { schema: h.Record({ a: h.Int }, { closed: true }), src: "{ a: 1, b: 2 }", reason: "unexpected field 'b'", path: "$.b" },
    { schema: Shape, src: "Square { side: 1 }", reason: "unknown tag 'Square', expected one of Circle | Point | Label", path: "$" },
    { schema: Shape, src: "Point(1)", reason: "'Point' expects 2 argument(s)", path: "$" },
    { schema: h.Array(Event), src: "[Heartbeat, Paid { amount: Money(19.99, EUR), at: Instant(\"yesterday\") }]", reason: 'invalid Instant "yesterday"', path: "$[1].at[0]" },
    { schema: h.Array(Event), src: "[Paid { amount: Money(19.99, EUR), at: Instant(\"2026-11-07T10:00:00Z\") }, Paid { amount: Money(\"1e3\", EUR) }]", reason: "expected Decimal, found string", path: "$[1].amount[0]" },
    { schema: h.Bool, src: "Yes", reason: "expected Bool (True | False), found variant Yes", path: "$" },
  ])("$src", ({ schema, src, reason, path }) =>
    Effect.gen(function* () {
      const e = yield* Effect.flip(decoding(() => h.parse(schema as h.AnySchema, src)))
      expect(e.reason).toContain(reason)
      expect(h.formatPath(e.path)).toBe(path)
    }))

  it.effect("decodeStream errors carry the element index", () =>
    Effect.gen(function* () {
      const e = yield* Effect.flip(collect(h.decodeStream(Event, ["Heartbeat, UserCreated { id: 1 },"])))
      expect(e.message).toBe("missing field 'email' at $[1]")
    }))
})

describe("encoding", () => {
  const Order = h.Record({
    id: h.Int32,
    big: h.Int,
    price: h.Decimal,
    ratio: h.Float64,
    paid: h.Bool,
    day: h.Date,
    at: h.InstantAsDate,
    note: h.Maybe(h.String),
    tags: h.Array(h.String),
    shape: Shape,
    level: h.Enum("Debug", "Info"),
  })
  type Order = h.Infer<typeof Order>

  const order: Order = {
    id: 1,
    big: 123456789012345678901n,
    price: "19.90",
    ratio: 0.1,
    paid: true,
    day: "2026-11-07",
    at: new Date("2026-11-07T10:00:00.000Z"),
    note: null,
    tags: ["a", 'quote "x"'],
    shape: { _tag: "Point", values: [1, 2] },
    level: "Info",
  }

  it("writes haus text that decodes back to the same value", () => {
    const text = h.stringify(Order, order)
    expect(text).toBe(
      '{\n  id: 1,\n  big: 123456789012345678901,\n  price: 19.90,\n  ratio: 0.1,\n  paid: True,\n  day: Date("2026-11-07"),\n' +
        '  at: Instant("2026-11-07T10:00:00.000Z"),\n  note: None,\n  tags: [\n    "a",\n    "quote \\"x\\"",\n  ],\n  shape: Point(1, 2),\n  level: Info,\n}',
    )
    expect(h.parse(Order, text)).toEqual(order)
  })

  it("round-trips every variant case and Unknown", () => {
    const shapes = [{ _tag: "Circle", radius: 2 }, { _tag: "Point", values: [1, 2] }, { _tag: "Label", value: "hi" }] as const
    expect(h.stringify(h.Array(Shape), [...shapes], { style: "compact" })).toBe('[Circle { radius: 2 }, Point(1, 2), Label("hi")]')
    const events = h.parse(h.Array(Event), "[Heartbeat, Refunded { id: 1, reason: \"x\" }]")
    expect(h.stringify(h.Array(Event), events, { style: "compact" })).toBe('[Heartbeat, Refunded { id: 1, reason: "x" }]')
  })

  it("Optional fields without a value are left out; Maybe always writes None or Some", () => {
    const UserUpdate = h.Record({ name: h.Optional(h.String), nickname: h.Optional(h.Maybe(h.String)) })
    expect(h.stringify(UserUpdate, { nickname: null }, { style: "compact" })).toBe("{ nickname: None }")
    expect(h.stringify(UserUpdate, { name: "Jan" }, { style: "compact" })).toBe('{ name: "Jan" }')
    expect(h.stringify(UserUpdate, { name: "Jan", nickname: "J" }, { style: "compact" })).toBe('{ name: "Jan", nickname: Some("J") }')
    expect(h.Record({ a: h.Optional(h.Int), b: h.Maybe(h.Int) }).expected).toBe("{ a?: Int, b: Maybe Int | _ }")
  })

  it("NaN and infinities", () => {
    expect(h.stringify(h.Array(h.Float64), [NaN, Infinity, -Infinity, 1e21], { style: "compact" })).toBe("[NaN, Infinity, NegInfinity, 1e21]")
  })

  it.effect.each([
    { schema: h.Int, value: 1, reason: "expected a bigint, got 1" },
    { schema: h.Int32, value: 1.5, reason: "expected an integer from -2147483648 to 2147483647, got 1.5" },
    { schema: h.Decimal, value: "1,5", reason: 'expected a decimal string like "19.90", got "1,5"' },
    { schema: h.Date, value: "2026-02-30", reason: 'expected a valid Date, got "2026-02-30"' },
    { schema: Shape, value: { _tag: "Square" }, reason: 'expected one of Circle | Point | Label, got "Square"' },
  ])("rejects $value", ({ schema, value, reason }) =>
    Effect.gen(function* () {
      const e = yield* Effect.flip(Effect.try({ try: () => h.encode(schema as h.AnySchema, value), catch: (e) => e as h.HausEncodeError }))
      expect(e.reason).toBe(reason)
    }))

  it.effect("encodeStream writes comma-terminated values that parse back", () =>
    Effect.gen(function* () {
      const chunks = yield* Stream.runCollect(Stream.fromAsyncIterable(h.encodeStream(Event, [{ _tag: "Heartbeat" }, { _tag: "UserCreated", id: 1n, email: "a@b" }]), (e) => e))
      expect(chunks.join("")).toBe('Heartbeat,\nUserCreated { id: 1, email: "a@b" },\n')
      const back = yield* collect(h.decodeStream(Event, [chunks.join("")]))
      expect(back).toEqual([{ _tag: "Heartbeat" }, { _tag: "UserCreated", id: 1n, email: "a@b" }])
    }))
})
