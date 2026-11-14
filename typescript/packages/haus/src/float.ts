/**
 * Floats with a schema (spec §15): decoding a number literal to the nearest
 * binary64 or binary32 value, and writing a float in its one spelling.
 */
import { num, variant, type Value } from "./value.js"

export type FloatType = "Float64" | "Float32"

const view = new DataView(new ArrayBuffer(8))

const bits32 = (x: number): number => (view.setFloat32(0, x), view.getUint32(0))
const fromBits32 = (b: number): number => (view.setUint32(0, b), view.getFloat32(0))

/** A finite, non-negative double as X × 2^B, exactly. */
const binary = (x: number): [bigint, number] => {
  view.setFloat64(0, x)
  const hi = view.getUint32(0)
  const exp = (hi >>> 20) & 0x7ff
  const mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(view.getUint32(4))
  return exp === 0 ? [mantissa, -1074] : [mantissa | (1n << 52n), exp - 1075]
}

const LITERAL = /^-?(\d+)(?:\.(\d+))?(?:e(-?\d+))?$/

/** Compare the magnitude of a normalized decimal literal with a finite x ≥ 0, exactly. */
const compareExact = (text: string, x: number): number => {
  const m = LITERAL.exec(text)
  if (!m) throw new Error(`not a decimal literal: ${text}`)
  let left = BigInt(m[1]! + (m[2] ?? ""))
  const e10 = Number(m[3] ?? 0) - (m[2]?.length ?? 0)
  let [right, e2] = binary(x)
  if (e10 >= 0) left *= 10n ** BigInt(e10)
  else right *= 10n ** BigInt(-e10)
  if (e2 >= 0) right <<= BigInt(e2)
  else left <<= BigInt(-e2)
  return left < right ? -1 : left > right ? 1 : 0
}

/** The nearest binary64 value of a normalized number literal; undefined if it is too large. */
export const toFloat64 = (text: string): number | undefined => {
  const d = Number(text)
  return Number.isFinite(d) ? d : undefined
}

/** Half way between the largest binary32 value and 2^128: from here on, binary32 rounds to infinity. */
const FLOAT32_LIMIT = 2 ** 128 - 2 ** 103

/**
 * The nearest binary32 value of a normalized number literal, rounded directly
 * from the decimal (ties to even); undefined if it is too large. Rounding the
 * binary64 value again is wrong only when that value lies exactly half way
 * between two binary32 values; then the exact decimal decides.
 */
export const toFloat32 = (text: string): number | undefined => {
  const d = Number(text)
  if (!Number.isFinite(d)) return undefined
  let f = Math.fround(d)
  const a = Math.abs(d)
  if (f !== d) {
    // The binary32 neighbours of |d|: lo below, hi above (hi may be 2^128, "infinity").
    let lo = Math.fround(a)
    if (lo > a) lo = fromBits32(bits32(lo) - 1)
    const hi = fromBits32(bits32(lo) + 1)
    const mid = hi === Infinity ? FLOAT32_LIMIT : (lo + hi) / 2
    if (a === mid) {
      const c = compareExact(text, a)
      if (c !== 0) f = Math.sign(d) * (c > 0 ? hi : lo)
    }
  }
  return Number.isFinite(f) ? f : undefined
}

/** The nearest value of `type` of a normalized number literal; undefined if it is too large. */
export const toFloat = (text: string, type: FloatType): number | undefined => (type === "Float32" ? toFloat32(text) : toFloat64(text))

/** The prelude tags of the floats that aren't numbers (spec §15). */
const SPECIAL_FLOATS: ReadonlyMap<string, number> = new Map([["NaN", NaN], ["Infinity", Infinity], ["NegInfinity", -Infinity]])

/** The float `NaN`, `Infinity` or `NegInfinity` (without a payload) stands for; undefined for any other value. */
export const specialFloat = (v: Value): number | undefined =>
  v.kind === "variant" && v.args.length === 0 ? SPECIAL_FLOATS.get(v.tag) : undefined

/**
 * A float as the haus value an encoder writes (spec §15): `NaN`, `Infinity`,
 * `NegInfinity`, or the number in its one spelling; a Float32 as the nearest
 * binary32 value of `x`. Undefined when `x` is out of the type's range.
 */
export const floatValue = (x: number, type: FloatType): Value | undefined => {
  if (Number.isNaN(x)) return variant("NaN")
  if (x === Infinity) return variant("Infinity")
  if (x === -Infinity) return variant("NegInfinity")
  const rounded = type === "Float32" ? Math.fround(x) : x
  return Number.isFinite(rounded) ? num(floatText(rounded, type)) : undefined
}

/** JavaScript's layout without the exponent's `+`: 1e+21 → 1e21. */
const layout = (shortest: string) => shortest.replace("e+", "e")

/**
 * The one spelling of a finite float (spec §15): the fewest digits that read
 * back as the same value of the type (of two equally close, the even one), in
 * JavaScript's layout without `+` in the exponent, and `-0` for negative zero.
 */
export const floatText = (x: number, type: FloatType): string => {
  if (x === 0) return Object.is(x, -0) ? "-0" : "0"
  const sign = x < 0 ? "-" : ""
  const a = Math.abs(x)
  if (type === "Float64") return sign + layout(String(a))
  for (let p = 1; p <= 9; p++) {
    // The closest p-digit decimal N × 10^E (exact ties rounded up), and its
    // neighbour on the other side of a: near a power of two the rounding
    // interval is lopsided, so the neighbour may read back when N doesn't.
    const [digits, exp = "0"] = a.toExponential(p - 1).split("e")
    const n = BigInt(digits!.replace(".", ""))
    const e = Number(exp) - (p - 1)
    const literal = (m: bigint) => `${m}e${e}`
    const reads = (m: bigint) => m > 0n && toFloat32(literal(m)) === a
    const above = Number(literal(n)) > a
    const other = above ? n - 1n : n + 1n
    if (reads(n)) {
      // Exactly half way between the two: the even one (spec §15).
      const tie = above && n % 2n === 1n && reads(other) && compareExact(`${(2n * n - 1n) * 5n}e${e - 1}`, a) === 0
      return sign + layout(String(Number(literal(tie ? other : n))))
    }
    if (reads(other)) return sign + layout(String(Number(literal(other))))
  }
  return sign + layout(String(a)) // unreachable: 9 digits always identify a binary32 value
}
