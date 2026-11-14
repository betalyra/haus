import { describe, expect, it } from "@effect/vitest"
import { floatText, toFloat32, toFloat64 } from "../src/float.js"
import { canonical, compileSchemaFile } from "../src/index.js"
import * as h from "../src/schema.js"

const view = new DataView(new ArrayBuffer(4))
const f32 = (bits: number) => (view.setUint32(0, bits), view.getFloat32(0))

/** A pseudo-random sequence, the same on every run. */
const random = (seed: number) => () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0), seed)

describe("float spelling", () => {
  it("uses JavaScript's layout without +", () => {
    expect([1, 100, 123000, 1.5, 12.25, 0.1, 0.000001, 1e-7, 1.5e-7, 1e20, 1e21, -2.5, -0, 0].map((x) => floatText(x, "Float64")))
      .toEqual(["1", "100", "123000", "1.5", "12.25", "0.1", "0.000001", "1e-7", "1.5e-7", "100000000000000000000", "1e21", "-2.5", "-0", "0"])
  })

  it("writes the fewest digits for Float32", () => {
    expect([0.1, 1.0000001, 3.4028235e38, 1e21, 16777216, 1.401298464324817e-45].map((x) => floatText(Math.fround(x), "Float32")))
      .toEqual(["0.1", "1.0000001", "3.4028235e38", "1e21", "16777216", "1e-45"])
  })

  it("reads every Float32 spelling back as the same value", () => {
    const next = random(1)
    const values = [...Array(20000)].map(() => f32(next()))
    // powers of two, where the rounding interval is lopsided
    for (let e = -149; e < 128; e++) values.push(2 ** e, -(2 ** e))
    for (const x of values.filter(Number.isFinite)) {
      const text = floatText(x, "Float32")
      expect(Object.is(toFloat32(text), x), `${x} written as ${text}`).toBe(true)
      expect(text.replace(/^-|e.*$|\./g, "").replace(/^0+|0+$/g, "").length).toBeLessThanOrEqual(9)
    }
  })

  it("reads every Float64 spelling back as the same value", () => {
    const next = random(2)
    const v = new DataView(new ArrayBuffer(8))
    for (let i = 0; i < 20000; i++) {
      v.setUint32(0, next()), v.setUint32(4, next())
      const x = v.getFloat64(0)
      if (Number.isFinite(x)) expect(Object.is(toFloat64(floatText(x, "Float64")), x)).toBe(true)
    }
  })
})

describe("Float32 rounding", () => {
  it("rounds directly from the decimal at a binary32 tie", () => {
    expect(toFloat32("1.000000059604644775390625")).toBe(1)
    expect(toFloat32("1.00000005960464477539062500000001")).toBe(1 + 2 ** -23)
    expect(toFloat32("-1.00000005960464477539062500000001")).toBe(-(1 + 2 ** -23))
    expect(toFloat32("1.00000017881393432617187499999999")).toBe(1 + 2 ** -23)
    expect(toFloat32("1.000000178813934326171875")).toBe(1 + 2 ** -22)
  })

  it("is an error only above half way to 2^128", () => {
    expect(toFloat32("340282356779733661637539395458142568447")).toBe(f32(0x7f7fffff))
    expect(toFloat32("340282356779733661637539395458142568448")).toBeUndefined()
    expect(toFloat32("1e39")).toBeUndefined()
    expect(toFloat64("1e400")).toBeUndefined()
  })
})

describe("< >", () => {
  const { schemas } = compileSchemaFile("type Currency = < >\ntype Price = { amount: Decimal, currency: Currency }")
  it("decodes a bare tag to its name and keeps others as Unknown", () => {
    expect(h.parse(schemas.Price!, "{ amount: 19.90, currency: EUR }")).toEqual({ amount: "19.90", currency: "EUR" })
    expect(h.parse(schemas.Currency!, 'Custom("XBT")')).toMatchObject({ _tag: "@unknown", tag: "Custom" })
    expect(canonical(h.encode(schemas.Price!, { amount: "1.5E+3", currency: "USD" }))).toBe("{amount:1.5e3,currency:USD}")
    expect(() => h.stringify(schemas.Currency!, "usd")).toThrow(h.HausEncodeError)
  })
})

describe("float ties", () => {
  it("writes the even one of two equally close spellings", () => {
    expect(floatText(1690060720831323.25, "Float64")).toBe("1690060720831323.2")
    expect(floatText(2097152.25, "Float32")).toBe("2097152.2")
    expect(floatText(2097152.75, "Float32")).toBe("2097152.8")
    expect(floatText(-2097152.25, "Float32")).toBe("-2097152.2")
  })
})
