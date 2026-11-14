/**
 * Values for the schema fuzzer (schema.ts): haus text for a resolved type of
 * the schema suite (the JSON form of spec/lean/scripts/schema-types.ts),
 * mostly accepted by the type, plus near misses: the wrong kind of value,
 * missing and extra fields, unknown tags, the wrong number of arguments, and
 * numbers, strings and std/time values at the edges.
 */
import { blockString, Rng, value as anyValue, ws } from "./generate.ts"

export type Type =
  | { readonly builtin: string }
  | { readonly time: string }
  | { readonly array: Type }
  | { readonly map: Type }
  | { readonly maybe: Type }
  | { readonly secret: Type }
  | { readonly ref: string }
  | { readonly record: RecordType }
  | { readonly variant: { readonly closed: boolean; readonly cases: readonly Case[] } }

export interface RecordType {
  readonly closed: boolean
  readonly fields: readonly { readonly key: string; readonly optional: boolean; readonly type: Type }[]
}

export interface Case {
  readonly tag: string
  readonly payload: "none" | { readonly record: RecordType } | { readonly positional: readonly Type[] }
}

export type Env = ReadonlyMap<string, Type>

// ── numbers ──────────────────────────────────────────────────

const big = (n: number | bigint) => BigInt(n)

/** `1_000`: separators between some digits. */
function separated(r: Rng, digits: string): string {
  if (digits.length < 2 || !r.chance(0.15)) return digits
  return [...digits].map((d, i) => (i > 0 && r.chance(0.3) ? "_" + d : d)).join("")
}

/** An integer in one of its spellings: decimal (with separators), hex or binary. */
export function spellInt(r: Rng, n: bigint): string {
  const sign = n < 0n ? "-" : ""
  const abs = n < 0n ? -n : n
  const x = r.next()
  if (x < 0.75 && abs.toString().length <= 1000 - sign.length) return sign + separated(r, abs.toString())
  if (x < 0.95 || abs > 1n << 990n) {
    const hex = abs.toString(16)
    return sign + "0x" + separated(r, r.chance(0.5) ? hex : hex.toUpperCase())
  }
  return sign + "0b" + separated(r, abs.toString(2))
}

const RANGES: Readonly<Record<string, readonly [bigint, bigint]>> = {
  Int8: [-(2n ** 7n), 2n ** 7n - 1n],
  Int16: [-(2n ** 15n), 2n ** 15n - 1n],
  Int32: [-(2n ** 31n), 2n ** 31n - 1n],
  Int64: [-(2n ** 63n), 2n ** 63n - 1n],
  UInt8: [0n, 2n ** 8n - 1n],
  UInt16: [0n, 2n ** 16n - 1n],
  UInt32: [0n, 2n ** 32n - 1n],
  UInt64: [0n, 2n ** 64n - 1n],
}

/** Integers that sit on some edge: of a range, of 2^53, of the number limit (§7, §12). */
const BIG_INTS: readonly bigint[] = [
  0n, 1n, -1n, 2n ** 53n - 1n, 2n ** 53n, 2n ** 53n + 1n, 2n ** 64n, -(2n ** 64n), 10n ** 30n, 10n ** 998n, -(10n ** 998n),
  10n ** 999n - 1n, 10n ** 999n, -(10n ** 999n) + 1n, -(10n ** 999n), 10n ** 1000n, 2n ** 3988n - 1n, -(2n ** 3988n - 1n),
  ...Object.values(RANGES).flatMap(([lo, hi]) => [lo, hi, lo - 1n, hi + 1n]),
]

/** A random bigint below 2^bits. */
function bits(r: Rng, n: number): bigint {
  let x = 0n
  for (let i = 0; i < n; i += 30) x = (x << 30n) | big(r.int(1 << 30))
  return x & ((1n << big(n)) - 1n)
}

/** An integer for `name` (Int, Int8, …): in range, at its edges, or just past them. */
function integer(r: Rng, name: string): string {
  const range = RANGES[name]
  const x = r.next()
  let n: bigint
  if (x < 0.3 && range) n = r.pick([range[0], range[1], range[0] - 1n, range[1] + 1n, range[0] + 1n, range[1] - 1n])
  else if (x < 0.5 && range) n = range[0] + bits(r, 70) % (range[1] - range[0] + 1n)
  else if (x < 0.7) n = big(r.int(2000) - 1000)
  else if (x < 0.85) n = r.pick(BIG_INTS)
  else n = (r.chance(0.5) ? -1n : 1n) * bits(r, r.pick([8, 16, 31, 32, 53, 63, 64, 65, 100, 300]))
  // -0 is 0 (spec §15).
  if (n === 0n && r.chance(0.2)) return r.pick(["-0", "-0x0", "-0b0", "0x0", "0_0"])
  return spellInt(r, n)
}

/** Not whole numbers, or not numbers: near misses for an integer type. */
const NOT_INTEGERS = ["1.0", "1e3", "1E0", "0.0", "-0.0", "0e0", "1.5", "-1e-1", "1e-0", '"42"', "Some(1)", "True", "1.00e2", "NaN", "Infinity"]

/** The exact decimal value of m · 2^e, as a literal. */
function exact(m: bigint, e: number): { digits: bigint; exp: number } {
  return e >= 0 ? { digits: m << big(e), exp: 0 } : { digits: m * 5n ** big(-e), exp: e }
}

/** A literal for digits · 10^exp in one of its spellings. */
function decimalLiteral(r: Rng, digits: bigint, exp: number, negative: boolean): string {
  const sign = negative ? "-" : ""
  const ds = digits.toString()
  let text: string
  switch (r.int(3)) {
    case 0: text = exp === 0 ? ds : `${ds}e${exp}`; break
    case 1: {
      // d.ddd e x
      const e = ds.length - 1 + exp
      text = ds.length > 1 ? `${ds[0]}.${ds.slice(1)}e${e}` : `${ds}e${e}`
      break
    }
    default: {
      // plain decimal when the exponent is small, otherwise scientific
      if (exp >= 0 && exp < 30) text = ds + "0".repeat(exp)
      else if (exp < 0 && -exp < 400) {
        const pad = ds.padStart(-exp + 1, "0")
        text = `${pad.slice(0, pad.length + exp)}.${pad.slice(pad.length + exp)}`
      } else text = `${ds}e${exp}`
    }
  }
  return sign + text
}

interface FloatFormat {
  readonly mant: number // explicit significand bits
  readonly emin: number // exponent of the smallest subnormal unit
  readonly emax: number // largest unbiased exponent
}
const F64: FloatFormat = { mant: 52, emin: -1074, emax: 1023 }
const F32: FloatFormat = { mant: 23, emin: -149, emax: 127 }

/** A float of the format as m · 2^e (m < 2^(mant+1)): random bits, edges, or simple values. */
function randomFloat(r: Rng, f: FloatFormat): { m: bigint; e: number } {
  const top = 1n << big(f.mant)
  const x = r.next()
  if (x < 0.25) {
    // edges: max, min normal, min subnormal, max subnormal, 1, around 2^mant+1
    return r.pick([
      { m: 2n * top - 1n, e: f.emax - f.mant },
      { m: top, e: f.emin },
      { m: 1n, e: f.emin },
      { m: top - 1n, e: f.emin },
      { m: top, e: -f.mant },
      { m: top + 1n, e: 1 },
      { m: top + 1n, e: 0 },
      { m: 2n * top - 1n, e: -f.mant },
    ])
  }
  if (x < 0.45) return { m: big(1 + r.int(1000)), e: -r.int(12) } // small and simple: 1.25, 0.5
  // random significand and exponent across the whole range
  const sub = r.chance(0.1)
  const m = sub ? 1n + bits(r, f.mant) % (top - 1n) : top | bits(r, f.mant)
  const e = sub ? f.emin : f.emin + r.int(f.emax - f.mant - f.emin + 1)
  return { m, e }
}

/** A number for `Float64` or `Float32`. */
function float(r: Rng, name: string): string {
  const f = name === "Float32" ? F32 : F64
  const neg = r.chance(0.3)
  const x = r.next()
  if (x < 0.05) return r.pick(["NaN", "Infinity", "NegInfinity"])
  if (x < 0.1) return r.pick(["0", "-0", "0.0", "-0.0", "0e5", "-0e-3", "1e-400", "-1e-400", "1e-6144", "1e400", "-1e309", "1e6144", "1e39", "-3.5e38", "1e38", "1.7976931348623157e308", "1.7976931348623158e308", "3.4028235e38", "3.4028236e38", "5e-324", "2.4703282292062328e-324", "1e-45", "7e-46", "0.1", "19.90", "9007199254740993", "16777217"])
  if (x < 0.15) return spellInt(r, (neg ? -1n : 1n) * bits(r, r.pick([24, 25, 53, 54, 64, 128, 1024, 1100])))
  const { m, e } = randomFloat(r, f)
  const y = r.next()
  if (y < 0.35) {
    // the float itself, exactly
    const { digits, exp } = exact(m, e)
    return decimalLiteral(r, digits, exp, neg)
  }
  // the point halfway to the next float, exactly, or just below or above it
  const half = exact(2n * m + 1n, e - 1)
  const nudge = r.int(3)
  if (nudge === 0) return decimalLiteral(r, half.digits, half.exp, neg)
  const k = r.pick([1, 3, 20, 40])
  const digits = half.digits * 10n ** big(k) + (nudge === 1 ? 1n : -1n)
  return decimalLiteral(r, digits, half.exp - k, neg)
}

/** A number for `Decimal`: scale, exponents and signs of zero matter. */
function decimal(r: Rng): string {
  const sign = r.chance(0.3) ? "-" : ""
  const ds = () => (1 + r.int(9)) + Array.from({ length: r.int(8) }, () => r.int(10)).join("")
  switch (r.int(9)) {
    case 0: return sign + r.pick(["0", "0.0", "0.00", "0e0", "0e5", "0e-3", "0.0e1", "0_0.0"])
    case 1: return sign + ds()
    case 2: return sign + r.int(100) + "." + Array.from({ length: 1 + r.int(5) }, () => r.int(10)).join("") + "0".repeat(r.int(3))
    case 3: {
      const exp = r.pick(["0", "00", "05", "0_5", "1", "-1", "+3", "-07", "6144", "-6144", "6145", String(r.int(400))])
      return sign + ds() + (r.chance(0.4) ? "." + r.int(100) : "") + r.pick(["e", "E"]) + exp
    }
    case 4: return sign + spellInt(r, bits(r, r.pick([8, 64, 200])))
    case 5: return sign + "19.90"
    case 6: return sign + "1" + "0".repeat(r.pick([20, 998, 999])) // at the literal limit
    case 7: return sign + "0." + "0".repeat(r.int(30)) + ds()
    default: return r.pick(['"1.5"', "NaN", "Infinity", "Some(1)"])
  }
}

// ── strings, bytes, time ─────────────────────────────────────

const STRING_PARTS = ["a", "hello", " ", "é", "é", "😀", "𝄞", "中文", "\u{10FFFF}", "\\n", "\\t", "\\r", '\\"', "\\\\",
  "\\u{41}", "\\u{1F600}", "\\u{10FFFF}", "\\u{0}", "\\u{1B}", "\\u{7F}", "\\u{85}", "\\u{9F}", "\\u{202E}", "\\u{2066}", "\\u{FEFF}",
  "\\u{2028}", "\\u{FFFD}", "'", "/*", "//", ",", "${x}", "<redacted>", "\\u{000041}"]

function string(r: Rng, depth: number): string {
  if (r.chance(0.05)) return blockString(r, "  ".repeat(depth))
  if (r.chance(0.02)) return '"' + "x".repeat(r.pick([1000, 5000])) + '"'
  return '"' + Array.from({ length: r.int(6) }, () => r.pick(STRING_PARTS)).join("") + '"'
}

function bytes(r: Rng): string {
  const hex = "0123456789abcdefABCDEF"
  const n = r.pick([0, 0, 1, 2, 3, 8, 33])
  return 'x"' + Array.from({ length: n }, () => hex[r.int(22)]! + hex[r.int(22)]! + r.pick(["", "", " ", "\t"])).join("").trimEnd() + '"'
}

const pad = (n: number, w: number) => String(n).padStart(w, "0")
const daysIn = (y: number, m: number) => (m === 2 ? (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31)
/** Usually a valid date; otherwise fields at and past their edges. */
function date(r: Rng): string {
  if (r.chance(0.75)) {
    const y = r.pick([2026, 2024, 2000, 1900, 0, 9999, r.int(10000)])
    const m = 1 + r.int(12)
    return `${pad(y, 4)}-${pad(m, 2)}-${pad(r.chance(0.3) ? daysIn(y, m) : 1 + r.int(daysIn(y, m)), 2)}`
  }
  return `${pad(r.pick([2026, 2024, 2000, 1900, 0, 9999, r.int(10000)]), 4)}-${pad(r.pick([1, 2, 12, 13, 0, 1 + r.int(12)]), 2)}-${pad(r.pick([1, 28, 29, 30, 31, 32, 1 + r.int(28)]), 2)}`
}
const fraction = (r: Rng) => (r.chance(0.6) ? "" : "." + Array.from({ length: r.pick([1, 3, 6, 9, 10]) }, () => r.int(10)).join(""))
const time = (r: Rng) =>
  r.chance(0.75)
    ? `${pad(r.int(24), 2)}:${pad(r.int(60), 2)}:${pad(r.int(60), 2)}${fraction(r)}`
    : `${pad(r.pick([0, 23, 24, r.int(24)]), 2)}:${pad(r.pick([0, 59, 60, r.int(60)]), 2)}:${pad(r.pick([0, 59, 60, r.int(60)]), 2)}${fraction(r)}`
const offset = (r: Rng) =>
  r.pick(["Z", "Z", "+01:00", "-05:30", "+14:00", "-00:00", "+00:00", "+23:59", "+24:00", "z", `${r.pick(["+", "-"])}${pad(r.int(24), 2)}:${pad(r.pick([0, 30, 45]), 2)}`])
// Zone names are checked for their syntax, never looked up (spec §13.2): unknown names are valid.
const zone = (r: Rng) =>
  r.pick(["Europe/Lisbon", "America/Argentina/Buenos_Aires", "America/Buenos_Aires", "Asia/Kolkata", "UTC", "Etc/GMT+5", "Etc/UTC", "+01:00", "-00:00", "Z",
    "Mars/Olympus_Mons", "Foo/Bar", "europe/lisbon", "EST5EDT", "a/../b", "Europe/", "x".repeat(255), "x".repeat(256)])
const duration = (r: Rng) =>
  r.pick(["PT0S", "P1D", "-P1Y2M", "PT1.5S", "P1W", "P1Y2M3DT4H5M6.789S", "PT36H", "-PT0S", "P", "PT", "P0D", "PT4294967296S", "P1M1W", "pt1s", "+P1D"])

const TIME_TYPES = ["Date", "Time", "DateTime", "Instant", "ZonedDateTime", "Duration", "YearMonth", "TimeZone"]

/** The string of a std/time value: mostly well formed for its type. */
function timeText(r: Rng, type: string): string {
  switch (type) {
    case "Date": return date(r)
    case "Time": return time(r)
    case "DateTime": return `${date(r)}${r.pick(["T", "T", "t", " "])}${time(r)}`
    case "Instant": return `${date(r)}T${time(r)}${offset(r)}`
    case "ZonedDateTime": return `${date(r)}T${time(r)}${offset(r)}[${zone(r)}]`
    case "Duration": return duration(r)
    case "YearMonth": return `${pad(r.pick([2026, 0, 9999, r.int(10000)]), 4)}-${pad(r.pick([1, 12, 13, 0, 1 + r.int(12)]), 2)}`
    default: return zone(r)
  }
}

function timeValue(r: Rng, type: string, miss: boolean): string {
  if (miss) {
    switch (r.int(5)) {
      case 0: return `${r.pick(TIME_TYPES)}("${timeText(r, type)}")` // another type's tag
      case 1: return `${type}("${timeText(r, type)}", "${timeText(r, type)}")`
      case 2: return r.pick([type, `${type}(1)`, `"${timeText(r, type)}"`, `${type} { s: "x" }`])
      default: return `${type}("${timeText(r, r.pick(TIME_TYPES))}")` // another type's text
    }
  }
  return `${type}${r.pick(["", "", " "])}(${ws(r)}"${timeText(r, type)}"${ws(r)})`
}

// ── containers ───────────────────────────────────────────────

/** A value of the wrong kind for most types. */
const WRONG = ['0', '1.5', '"x"', 'x""', 'x"00"', '[]', '[1]', '{}', '{ a: 1 }', 'None', 'Some(1)', 'True', 'Tag', 'Tag(1, 2)', 'Unknown { x: 1 }']

const BARE_KEY = /^[a-z_][A-Za-z0-9_]*$/
const quote = (s: string) => JSON.stringify(s).replace(/\\u00([0-9a-f]{2})/g, (_, h) => `\\u{${h.toUpperCase()}}`)

/** A key as written: bare when it can be, sometimes quoted anyway. */
const key = (r: Rng, k: string) => (BARE_KEY.test(k) && !r.chance(0.15) ? k : quote(k))

// Keys whose order differs between code points and UTF-16 units (U+FF61 and U+E000 against 😀), and JavaScript's special names.
const EXTRA_KEYS = ["extra", "x", "_", "id2", "zz", "x-y", "", "__proto__", "constructor", "Upper", "café", "😀", "\uFF61", "\uE000", "\u0000", "a b", "toString", "hasOwnProperty"]

function list(r: Rng, open: string, close: string, items: readonly string[]): string {
  if (items.length === 0) return open + ws(r) + close
  const sep = () => ws(r) + "," + ws(r)
  return open + ws(r) + items.join(sep()) + (r.chance(0.2) ? sep() : ws(r)) + close
}

function shuffle<T>(r: Rng, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = r.int(i + 1)
    ;[xs[i], xs[j]] = [xs[j]!, xs[i]!]
  }
  return xs
}

/**
 * How one value is generated: `miss` is the chance that a node is made a near
 * miss, `depth` limits nesting, and `deep` is how many levels a recursive
 * spine still goes down.
 */
interface Ctx {
  readonly env: Env
  readonly miss: number
  readonly maxDepth: number
}

export class Generator {
  private readonly minimals = new Map<string, string | null>()
  readonly env: Env
  constructor(env: Env) {
    this.env = env
  }

  /** haus text for `type`. */
  value(r: Rng, type: Type, opts: { miss: number; maxDepth: number; deep: number }): string {
    return this.gen(r, type, { env: this.env, miss: opts.miss, maxDepth: opts.maxDepth }, 0, opts.deep)
  }

  private gen(r: Rng, t: Type, c: Ctx, depth: number, deep: number): string {
    if (depth > c.maxDepth && deep <= 0) {
      const m = this.minimal(t)
      if (m !== null) return m
    }
    if (r.chance(c.miss * 0.15)) return r.pick(WRONG)
    const miss = r.chance(c.miss)
    if ("builtin" in t) return this.builtin(r, t.builtin, miss, depth)
    if ("time" in t) return timeValue(r, t.time, miss)
    if ("ref" in t) return this.gen(r, this.env.get(t.ref)!, c, depth, deep)
    if ("secret" in t) return this.gen(r, t.secret, c, depth, deep)
    if ("maybe" in t) {
      if (miss) return r.pick(["Some", "Some()", `Some(${this.gen(r, t.maybe, c, depth + 1, 0)}, 1)`, this.gen(r, t.maybe, c, depth + 1, 0), "None(1)", "Nothing"])
      if (deep <= 0 && r.chance(0.3)) return "None"
      const inner = this.gen(r, t.maybe, c, depth + 1, deep - 1)
      return inner.startsWith("{") && r.chance(0.5) ? `Some${r.pick(["", " "])}${inner}` : `Some${r.pick(["", "", " "])}(${ws(r)}${inner}${ws(r)})`
    }
    if ("array" in t) {
      if (miss) return r.pick([`{ a: ${this.gen(r, t.array, c, depth + 1, 0)} }`, `Some([])`, this.gen(r, t.array, c, depth + 1, 0)])
      const n = deep > 0 ? 1 + r.int(2) : r.pick([0, 0, 1, 1, 2, 3, 5])
      const spine = r.int(n)
      return list(r, "[", "]", Array.from({ length: n }, (_, i) => this.gen(r, t.array, c, depth + 1, i === spine ? deep - 1 : 0)))
    }
    if ("map" in t) {
      if (miss) return r.pick([`[${this.gen(r, t.map, c, depth + 1, 0)}]`, "None"])
      const keys = shuffle(r, [...EXTRA_KEYS, "a", "b", "id", "name"]).slice(0, deep > 0 ? 1 : r.pick([0, 1, 2, 3, 5]))
      const spine = r.int(keys.length)
      return list(r, "{", "}", keys.map((k, i) => `${key(r, k)}${ws(r)}:${ws(r)}${this.gen(r, t.map, c, depth + 1, i === spine ? deep - 1 : 0)}`))
    }
    if ("record" in t) return this.record(r, t.record, c, depth, deep, miss)
    return this.variant(r, t.variant, c, depth, deep, miss)
  }

  private builtin(r: Rng, name: string, miss: boolean, depth: number): string {
    switch (name) {
      case "String": return miss ? r.pick(['x"61"', "a", "Some(\"a\")", "1"]) : string(r, depth)
      case "Bytes": return miss ? r.pick(['"00"', "[0]", "x"]) : bytes(r)
      case "Bool": return miss ? r.pick(["true", '"True"', "True(1)", "Some(True)", "TRUE", "1", "Yes"]) : r.pick(["True", "False"])
      case "Decimal": return miss ? r.pick(['"1.5"', "NaN", "Some(1)"]) : decimal(r)
      case "Float32":
      case "Float64": return miss ? r.pick(['"1.5"', "NaN(1)", "Infinity()", "Nan", "NegInfinity(0)", "-Infinity", "1e10000"]) : float(r, name)
      case "Any": return miss ? r.pick(["", ","]) + anyValue(r, depth) : anyValue(r, depth)
      default:
        return miss ? r.pick(NOT_INTEGERS) : integer(r, name)
    }
  }

  private fields(r: Rng, rec: RecordType, c: Ctx, depth: number, deep: number, miss: boolean): string {
    const declared = new Set(rec.fields.map((f) => f.key))
    const out: string[] = []
    const spineCandidates = rec.fields.filter((f) => !f.optional || r.chance(0.5))
    const spine = deep > 0 && spineCandidates.length ? r.pick(spineCandidates).key : undefined
    // A near miss drops a required field, or adds one to a closed record.
    const drop = miss && r.chance(0.5) ? r.pick(rec.fields.filter((f) => !f.optional).map((f) => f.key).concat([""])) : undefined
    for (const f of rec.fields) {
      if (f.key === drop) continue
      if (f.optional && f.key !== spine && r.chance(0.5)) continue
      out.push(`${key(r, f.key)}${ws(r)}:${ws(r)}${this.gen(r, f.type, c, depth + 1, f.key === spine ? deep - 1 : 0)}`)
    }
    const extras = (!rec.closed && r.chance(0.3)) || (miss && drop === undefined) ? 1 + r.int(2) : 0
    for (const k of shuffle(r, EXTRA_KEYS.filter((k) => !declared.has(k))).slice(0, extras)) {
      out.push(`${key(r, k)}${ws(r)}:${ws(r)}${anyValue(r, depth + 1)}`)
    }
    return list(r, "{", "}", shuffle(r, out))
  }

  private record(r: Rng, rec: RecordType, c: Ctx, depth: number, deep: number, miss: boolean): string {
    if (miss && r.chance(0.25)) return r.pick(["[]", `Rec ${this.fields(r, rec, c, depth, 0, false)}`, `[${this.fields(r, rec, c, depth + 1, 0, false)}]`])
    return this.fields(r, rec, c, depth, deep, miss)
  }

  private variant(r: Rng, v: { readonly closed: boolean; readonly cases: readonly Case[] }, c: Ctx, depth: number, deep: number, miss: boolean): string {
    const unknownTag = () => r.pick(["Unknown", "Other", "X", "None", "Some", "True", "Ok", "Err", "Nil", "Num", "Leaf"].filter((t) => !v.cases.some((k) => k.tag === t)))
    // An unknown tag: valid in an open variant, an error in a closed one.
    if (v.cases.length === 0 || r.chance(miss ? 0.4 : v.closed ? 0 : 0.12)) {
      // In a near miss, sometimes a listed tag with some other payload.
      const tag = miss && v.cases.length && r.chance(0.3) ? r.pick(v.cases).tag : unknownTag()
      const n = r.pick([0, 0, 1, 2, 3])
      if (n === 0) return tag
      if (n === 1 && r.chance(0.3)) return `${tag} ${list(r, "{", "}", [`a: ${anyValue(r, depth + 2)}`])}`
      return tag + list(r, "(", ")", Array.from({ length: n }, () => anyValue(r, depth + 2)))
    }
    // In deep mode, prefer cases that recurse.
    const recursive = v.cases.filter((k) => this.recurses(k))
    const kase = deep > 0 && recursive.length ? r.pick(recursive) : r.pick(v.cases)
    const p = kase.payload
    const sp = () => r.pick(["", "", " ", "\t"])
    if (p === "none") {
      if (miss) return r.pick([`${kase.tag}(1)`, `${kase.tag} { }`, `${kase.tag}()`, `${kase.tag}(None)`])
      return kase.tag
    }
    if ("record" in p) {
      if (miss && r.chance(0.5)) return r.pick([kase.tag, `${kase.tag}(1)`, `${kase.tag}(${this.fields(r, p.record, c, depth + 1, 0, false)}, 1)`])
      const fields = this.fields(r, p.record, c, depth + 1, deep, miss)
      return r.chance(0.5) ? `${kase.tag}${r.pick([" ", "", "\t"])}${fields}` : `${kase.tag}${sp()}(${ws(r)}${fields}${ws(r)})`
    }
    const types = p.positional
    let n = types.length
    if (miss && r.chance(0.6)) n = r.pick([0, n + 1, Math.max(0, n - 1)].filter((x) => x !== types.length))
    if (n === 0) return r.chance(0.7) ? kase.tag : `${kase.tag}()`
    const spineCandidates = types.map((t, i) => [t, i] as const).filter(([t]) => this.mentionsRef(t)).map(([, i]) => i)
    const spine = deep > 0 && spineCandidates.length ? r.pick(spineCandidates) : -1
    const args = Array.from({ length: n }, (_, i) =>
      i < types.length ? this.gen(r, types[i]!, c, depth + 1, i === spine ? deep - 1 : 0) : anyValue(r, depth + 2))
    if (n === 1 && args[0]!.startsWith("{") && r.chance(0.5)) return `${kase.tag}${sp()}${args[0]}`
    return kase.tag + sp() + list(r, "(", ")", args)
  }

  private mentionsRef(t: Type): boolean {
    if ("ref" in t) return true
    if ("array" in t) return this.mentionsRef(t.array)
    if ("map" in t) return this.mentionsRef(t.map)
    if ("maybe" in t) return this.mentionsRef(t.maybe)
    if ("secret" in t) return this.mentionsRef(t.secret)
    if ("record" in t) return t.record.fields.some((f) => this.mentionsRef(f.type))
    if ("variant" in t) return t.variant.cases.some((k) => this.recurses(k))
    return false
  }

  private recurses(k: Case): boolean {
    const p = k.payload
    if (p === "none") return false
    if ("record" in p) return p.record.fields.some((f) => this.mentionsRef(f.type))
    return p.positional.some((t) => this.mentionsRef(t))
  }

  /** The smallest value `t` accepts (to end recursion), or null if it has none. */
  minimal(t: Type, seen: ReadonlySet<string> = new Set()): string | null {
    if ("ref" in t) {
      if (this.minimals.has(t.ref)) return this.minimals.get(t.ref)!
      if (seen.has(t.ref)) return null
      const m = this.minimal(this.env.get(t.ref)!, new Set([...seen, t.ref]))
      if (seen.size === 0 || m !== null) this.minimals.set(t.ref, m)
      return m
    }
    if ("builtin" in t) {
      return { String: '""', Bytes: 'x""', Bool: "True", Decimal: "0", Float32: "0", Float64: "0", Any: "0" }[t.builtin] ?? "0"
    }
    if ("time" in t) {
      return `${t.time}("${{ Date: "2026-11-14", Time: "10:00:00", DateTime: "2026-11-14T10:00:00", Instant: "2026-11-14T10:00:00Z", ZonedDateTime: "2026-11-14T10:00:00+01:00[Europe/Paris]", Duration: "PT1H", YearMonth: "2026-11", TimeZone: "UTC" }[t.time]}")`
    }
    if ("array" in t) return "[]"
    if ("map" in t) return "{}"
    if ("maybe" in t) return "None"
    if ("secret" in t) return this.minimal(t.secret, seen)
    if ("record" in t) return this.minimalFields(t.record, seen)
    if (t.variant.cases.length === 0) return "X"
    for (const k of [...t.variant.cases].sort((a, b) => Number(this.recurses(a)) - Number(this.recurses(b)))) {
      const p = k.payload
      if (p === "none") return k.tag
      if ("record" in p) {
        const f = this.minimalFields(p.record, seen)
        if (f !== null) return k.tag + f
        continue
      }
      const args = p.positional.map((a) => this.minimal(a, seen))
      if (args.every((a) => a !== null)) return `${k.tag}(${args.join(",")})`
    }
    return null
  }

  private minimalFields(rec: RecordType, seen: ReadonlySet<string>): string | null {
    const fields: string[] = []
    for (const f of rec.fields) {
      if (f.optional) continue
      const m = this.minimal(f.type, seen)
      if (m === null) return null
      fields.push(`${quote(f.key)}:${m}`)
    }
    return `{${fields.join(",")}}`
  }
}
