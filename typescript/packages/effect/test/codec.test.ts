import { nodeResolver, schemaOptions } from "@haus-fmt/haus/node"
import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { BigDecimal, Effect, Exit, Schema, SchemaIssue, SchemaTransformation } from "effect"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as Haus from "../src/index.js"

const repo = (path: string) => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const packages = { "@haus/money": repo("extensions/money"), "@haus/geo": repo("extensions/geo") }
const resolver = nodeResolver({ packages })

// The schemas, typed as the content mapper declares them (see schemaDeclarations).
type Currency<C = {}> = Haus.Lookup<C, "@haus/money@1#Currency", string | Haus.Unknown>
type Decimal<C = {}> = Haus.Lookup<C, "prelude#Decimal", string>
type Money<C = {}> = Haus.Lookup<C, "@haus/money@1#Money", { readonly _tag: "Money"; readonly values: readonly [Decimal<C>, Currency<C>] }>
type LatLng<C = {}> = Haus.Lookup<C, "@haus/geo@1#LatLng", { readonly _tag: "LatLng"; readonly values: readonly [number, number] }>
type Order<C = {}> = Haus.Lookup<C, "app/order#Order", { readonly total: Money<C>; readonly to: LatLng<C>; readonly day: Haus.Lookup<C, "std/time#Date", string> }>
interface OrderF extends Haus.TypeLambda {
  readonly type: Order<this["C"]>
}
type OrderIds = "app/order#Order" | "@haus/money@1#Money" | "@haus/money@1#Currency" | "@haus/geo@1#LatLng" | "std/time#Date" | "prelude#Decimal"

const order = Haus.compileSchemaFile(
  `import std/time (Date)
   import @haus/money (Money)
   import @haus/geo (LatLng)
   type Order = { total: Money, to: LatLng, day: Date }`,
  { resolver, id: "app/order" },
).schemas
const Order = order.Order as unknown as Haus.Named<Schema.Codec<Order>, "app/order#Order", OrderF, OrderIds>

// The packages' own schema modules: what `import * as money from "@haus/money/money.schema.haus"` gives.
const moneyModule = Haus.compileSchemaFile(
  readFileSync(repo("extensions/money/money.schema.haus"), "utf8"),
  schemaOptions(repo("extensions/money/money.schema.haus")),
).schemas
const geoModule = Haus.compileSchemaFile(
  readFileSync(repo("extensions/geo/geo.schema.haus"), "utf8"),
  schemaOptions(repo("extensions/geo/geo.schema.haus")),
).schemas
const MoneySchema = moneyModule.Money as unknown as Haus.Named<Schema.Codec<Money>, "@haus/money@1#Money">
const CurrencySchema = moneyModule.Currency as unknown as Haus.Named<Schema.Codec<Currency>, "@haus/money@1#Currency">
const LatLngSchema = geoModule.LatLng as unknown as Haus.Named<Schema.Codec<LatLng>, "@haus/geo@1#LatLng">

// ── codecs ──

/** 1990n → "19.90". */
const minorText = (minor: bigint) => {
  const digits = (minor < 0n ? -minor : minor).toString().padStart(3, "0")
  return `${minor < 0n ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`
}

/** Integer minor units, failing on more than 2 decimal places. */
const Cents = Schema.Struct({ minor: Schema.BigInt, currency: Schema.String })
const cents = Haus.codec(MoneySchema, (base) =>
  base.pipe(Schema.decodeTo(Cents, SchemaTransformation.transformEffect({
    decode: ({ values: [text, currency] }) => {
      const amount = BigDecimal.fromStringUnsafe(text)
      return BigDecimal.normalize(amount).scale > 2 || typeof currency !== "string"
        ? Effect.fail(new SchemaIssue.InvalidValue({ message: `${text} has more than 2 decimal places` }))
        : Effect.succeed({ minor: BigDecimal.scale(amount, 2).value, currency })
    },
    encode: ({ minor, currency }) => Effect.succeed({ _tag: "Money" as const, values: [minorText(minor), currency] as const }),
  }))))

/** Only the shape of ISO 4217 codes (the @haus/money/iso profile). */
const iso = Haus.codec(CurrencySchema, (base) =>
  base.pipe(Schema.check(Schema.makeFilter((c: string | Haus.Unknown) => (typeof c === "string" && /^[A-Z]{3}$/.test(c)) || "a currency is three letters A–Z"))))

/** GeoJSON order: [lng, lat]. */
const geojson = Haus.codec(LatLngSchema, (base) =>
  base.pipe(Schema.decodeTo(Schema.Tuple([Schema.Number, Schema.Number]), SchemaTransformation.transform({
    decode: ({ values: [lat, lng] }) => [lng, lat] as const,
    encode: ([lng, lat]) => ({ _tag: "LatLng" as const, values: [lat, lng] as const }),
  }))))

/** std/time types take codecs too. */
const jsDate = Haus.codec(Haus.Date, (base) =>
  base.pipe(Schema.decodeTo(Schema.instanceOf(globalThis.Date), SchemaTransformation.transform({
    decode: (s) => new globalThis.Date(`${s}T00:00:00Z`),
    encode: (d) => d.toISOString().slice(0, 10),
  }))))

const text = `{ total: Money(19.90, EUR), to: LatLng(38.7223, -9.1393), day: Date("2026-11-09") }`

describe("codecs", () => {
  it("without codecs: the generic types", () => {
    const v = Effect.runSync(Haus.decode(Order)(text))
    expectTypeOf(v.total).toEqualTypeOf<{ readonly _tag: "Money"; readonly values: readonly [string, string | Haus.Unknown] }>()
    expect(v.total.values).toEqual(["19.90", "EUR"])
    expect(v.to).toEqual({ _tag: "LatLng", values: [38.7223, -9.1393] })
    expect(v.day).toBe("2026-11-09")
  })

  it("with codecs: their types, in any order", () => {
    const v = Effect.runSync(Haus.decode(Order, geojson, cents, jsDate)(text))
    expectTypeOf(v.total).toEqualTypeOf<{ readonly minor: bigint; readonly currency: string }>()
    expectTypeOf(v.to).toEqualTypeOf<readonly [number, number]>()
    expectTypeOf(v.day).toEqualTypeOf<globalThis.Date>()
    expect(v.total).toEqual({ minor: 1990n, currency: "EUR" })
    expect(v.to).toEqual([-9.1393, 38.7223])
    expect(v.day.toISOString()).toBe("2026-11-09T00:00:00.000Z")
  })

  it("encodes back to the same text with the same codecs", () => {
    const v = Effect.runSync(Haus.decode(Order, cents, geojson)(text))
    expect(Effect.runSync(Haus.encode(Order, cents, geojson)(v, { style: "compact" }))).toBe(text)
  })

  it("codecs add rules; the schema's rules stay", () => {
    expect(Exit.isSuccess(Effect.runSyncExit(Haus.decode(Order)(text.replace("EUR", "Eur"))))).toBe(true)
    expect(Exit.isFailure(Effect.runSyncExit(Haus.decode(Order, iso)(text.replace("EUR", "Eur"))))).toBe(true)
    expect(Exit.isFailure(Effect.runSyncExit(Haus.decode(Order, cents)(text.replace("19.90", "19.999"))))).toBe(true)
    expect(Exit.isFailure(Effect.runSyncExit(Haus.decode(Order, cents)(text.replace("Money(19.90, EUR)", "Money(19.90)"))))).toBe(true)
    expect(Exit.isFailure(Effect.runSyncExit(Haus.decode(Order, jsDate)(text.replace("2026-11-09", "2026-02-30"))))).toBe(true)
  })

  it("groups: several codecs as one; members may target types the schema doesn't use", () => {
    const all = Haus.codecs(cents, geojson, Haus.codec(Haus.Time, (b) => b))
    const v = Effect.runSync(Haus.decode(Order, all)(text))
    expectTypeOf(v.total).toEqualTypeOf<{ readonly minor: bigint; readonly currency: string }>()
    expect(v.to).toEqual([-9.1393, 38.7223])
  })

  it("a single codec must target a type of the schema; two codecs for one type are an error", () => {
    const time = Haus.codec(Haus.Time, (b) => b)
    // @ts-expect-error the schema contains no std/time#Time
    void (() => Haus.decode(Order, time))
    expect(() => Haus.decode(Order, cents, cents)).toThrow("two codecs for @haus/money@1#Money")
  })

  it("the lossy Effect types are codecs: Decimal as BigDecimal", () => {
    const v = Effect.runSync(Haus.decode(Order, Haus.decimalAsBigDecimal)(text))
    expectTypeOf(v.total).toEqualTypeOf<{ readonly _tag: "Money"; readonly values: readonly [BigDecimal.BigDecimal, string | Haus.Unknown] }>()
    expect(BigDecimal.equals(v.total.values[0], BigDecimal.fromStringUnsafe("19.9"))).toBe(true)
    expect(v.total.values[0].scale).toBe(2)
    expect(Effect.runSync(Haus.encode(Order, Haus.decimalAsBigDecimal)(v, { style: "compact" }))).toBe(text)
    // What it drops: -0 and exponent notation.
    const lossy = (amount: string) =>
      Effect.runSync(Effect.flatMap(Haus.decode(Order, Haus.decimalAsBigDecimal)(text.replace("19.90", amount)), Haus.encode(Order, Haus.decimalAsBigDecimal)))
    expect(lossy("-0")).toContain("Money(0, EUR)")
    expect(lossy("15e2")).toContain("Money(1.5e3, EUR)")
    expect(lossy("1.5e-3")).toContain("Money(0.0015, EUR)")
    expect(lossy("1e-40")).toContain("Money(1e-40, EUR)")
  })

  it("convert: codecs for values already decoded without them", () => {
    const plain = Effect.runSync(Haus.decode(Order)(text))
    const v = Effect.runSync(Haus.convert(Order, cents)(plain))
    expectTypeOf(v.total).toEqualTypeOf<{ readonly minor: bigint; readonly currency: string }>()
    expect(v.total).toEqual({ minor: 1990n, currency: "EUR" })
  })

  it("streams take codecs", () =>
    Effect.gen(function* () {
      const { Stream } = yield* Effect.promise(() => import("effect"))
      const items = yield* Stream.runCollect(Haus.decodeStream(Order, cents)(Stream.make(`${text},\n${text},\n`)))
      expect([...items].map((o) => o.total.minor)).toEqual([1990n, 1990n])
    }).pipe(Effect.runPromise))

  it("ids: named types know theirs", () => {
    expect(Haus.idOf(MoneySchema)).toBe("@haus/money@1#Money")
    expect(Haus.idOf(Haus.Date)).toBe("std/time#Date")
    expect(Haus.idOf(Order)).toBe("app/order#Order")
    expect(() => Haus.codec(Schema.String, (b) => b)).toThrow("named type")
  })
})
