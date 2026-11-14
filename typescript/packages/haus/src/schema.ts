/**
 * Schemas in code: describe the expected shape once, get a TypeScript type
 * and a decoder from the generic haus `Value` tree into plain JS values.
 *
 *   import * as h from "@haus-fmt/haus/schema"
 *   const User = h.Record({ id: h.Int, name: h.String })
 *   type User = h.Infer<typeof User>
 *   const user = h.parse(User, text)
 *
 * Decoding never loses precision silently: `Int` is a bigint of any size,
 * `Int32` etc. are JS numbers in their range, `Decimal` keeps the exact literal text.
 *
 * Every schema also encodes: `h.stringify(User, user)` writes haus text,
 * `h.encodeStream(Event, events)` writes a stream.
 *
 * Decoding is linear in the input whatever the schema (spec §9.8): variants
 * dispatch on the tag, depth is limited, and every call has a work budget.
 * Types that contain themselves are declared with `h.Recursive`.
 */
import { START } from "./errors.js"
import { format, stringify as stringifyValue, type FormatOptions } from "./format.js"
import { INTEGER, normalizeNumber, numberLimitIssue } from "./number.js"
import { longerThan, Parser, withDefaults, type Limits as ValueLimits } from "./parser.js"
import { parseStream, type ChunkSource } from "./stream.js"
import { checkStdTime, type StdTimeType } from "./std-time.js"
import { floatValue, specialFloat, toFloat, type FloatType } from "./float.js"
import { arr, bytes as bytesValue, num, rec, str, variant, type HNumber, type HRecord, type HVariant, type Value } from "./value.js"
import { issuesOf, type StandardSchemaV1 } from "./standard.js"
import { Secret as SecretValue } from "./secret.js"

export type { Value }

// ── core ─────────────────────────────────────────────────────

export type Path = readonly (string | number)[]

export class HausDecodeError extends Error {
  override readonly name = "HausDecodeError"

  constructor(
    /** Message without the path. */
    readonly reason: string,
    /** Where in the value the mismatch is, e.g. ["events", 2, "amount"]. */
    readonly path: Path,
  ) {
    super(`${reason} at ${formatPath(path)}`)
  }
}

/** A value that doesn't fit its schema when encoding (e.g. an Int that isn't a safe integer). */
export class HausEncodeError extends Error {
  override readonly name = "HausEncodeError"

  constructor(
    readonly reason: string,
    readonly path: Path,
  ) {
    super(`${reason} at ${formatPath(path)}`)
  }
}

export const formatPath = (path: Path) =>
  "$" + path.map((p) => (typeof p === "number" ? `[${p}]` : /^[a-z_]\w*$/.test(p) ? `.${p}` : `[${JSON.stringify(p)}]`)).join("")

/**
 * Limits for one decode or encode call. They hold whatever the schema looks
 * like, so a mistake in a schema (or a hostile input meeting a recursive one)
 * ends in an error instead of exhausting CPU, memory or the stack.
 */
export interface Limits extends Partial<ValueLimits> {
  /** Deepest nesting of values (default 256, the parser's limit). */
  readonly maxDepth?: number
  /**
   * Most schema steps (one per schema applied to a value). Decoding defaults
   * to 16 per value in the input plus 1024, so decoding is linear in the
   * input. Encoding defaults to 16 Mi steps, which also bounds values that
   * share sub-objects (a DAG of depth 64 would otherwise expand to 2^64 nodes).
   */
  readonly maxSteps?: number
  // The parser's limits (maxNumberLength, maxExponent, maxStringLength, default
  // DEFAULT_LIMITS) apply when `parse` reads the text, and when a raw value
  // (an `Any`, an unknown variant) is written again (spec §9.8): pass the same
  // limits to both, and a parsed value always encodes again.
}

const DEFAULT_MAX_DEPTH = 256
const STEPS_PER_VALUE = 16
const DEFAULT_ENCODE_STEPS = 16 * 1024 * 1024

interface Context {
  readonly mode: "decode" | "encode"
  /** The parser's limits, for raw values. */
  readonly values: ValueLimits
  readonly maxDepth: number
  readonly maxSteps: number
  steps: number
  /** Per `h.Recursive`: how deeply it is nested, and the value it was last entered with. */
  readonly recursion: Map<object, { depth: number; current: unknown }>
  /** Encoding: the objects being encoded on the current path, to detect cycles. */
  readonly ancestors: Set<object>
}

/**
 * Where a schema is applied: the path (linked to its parent and only turned
 * into an array when an error is reported), the depth, and the limits shared
 * by the whole call. Schemas receive it and pass `at.child(key)` down.
 */
export class At {
  private constructor(
    private readonly ctx: Context,
    private readonly parent: At | undefined,
    private readonly key: string | number | undefined,
    readonly depth: number,
  ) {}

  /** @internal */
  static root(ctx: Context, key?: string | number): At {
    return new At(ctx, undefined, key, 0)
  }

  /** The position of a child value. Fails beyond the depth limit. */
  child(key: string | number): At {
    if (this.depth >= this.ctx.maxDepth) this.fail(`nesting deeper than ${this.ctx.maxDepth} levels`, key)
    return new At(this.ctx, this, key, this.depth + 1)
  }

  /** The parser's limits for this call, for checking raw values (spec §9.8). */
  get limits(): ValueLimits {
    return this.ctx.values
  }

  /** Count one schema step. Fails when the budget is used up. */
  step(): void {
    if (++this.ctx.steps > this.ctx.maxSteps) {
      this.fail(`${this.ctx.mode} budget of ${this.ctx.maxSteps} steps exceeded (a schema doing more work than the input justifies)`)
    }
  }

  path(): Path {
    const out: (string | number)[] = []
    for (let at: At | undefined = this; at; at = at.parent) if (at.key !== undefined) out.push(at.key)
    return out.reverse()
  }

  fail(reason: string, childKey?: string | number): never {
    const path = childKey === undefined ? this.path() : [...this.path(), childKey]
    throw this.ctx.mode === "decode" ? new HausDecodeError(reason, path) : new HausEncodeError(reason, path)
  }

  /** @internal Bookkeeping for `h.Recursive`. */
  recursion(schema: object) {
    let state = this.ctx.recursion.get(schema)
    if (!state) this.ctx.recursion.set(schema, (state = { depth: 0, current: NOTHING }))
    return state
  }

  /** Encoding: is `value` an object currently being encoded further up? */
  isEncoding(value: unknown): boolean {
    return typeof value === "object" && value !== null && this.ctx.ancestors.has(value)
  }

  /** Encoding: run `f` with `obj` marked as being encoded; a cycle back to it fails. */
  enter<R>(obj: unknown, f: () => R): R {
    if (typeof obj !== "object" || obj === null) return f()
    if (this.ctx.ancestors.has(obj)) this.fail("cyclic value: an object contains itself")
    this.ctx.ancestors.add(obj)
    try {
      return f()
    } finally {
      this.ctx.ancestors.delete(obj)
    }
  }
}

const NOTHING = Symbol("nothing")

const context = (mode: "decode" | "encode", maxSteps: number, limits: Limits): Context => ({
  mode,
  values: withDefaults(limits),
  maxDepth: limits.maxDepth ?? DEFAULT_MAX_DEPTH,
  maxSteps: limits.maxSteps ?? maxSteps,
  steps: 0,
  recursion: new Map(),
  ancestors: new Set(),
})

/**
 * Count the values in a tree, failing beyond `maxDepth` or `cap` values. A
 * parsed value is a tree within the parser's limits; a `Value` built in code
 * might be deeper, share nodes (a DAG) or even contain itself.
 */
const countValues = (root: Value, maxDepth: number, cap: number, at: At): number => {
  let count = 0
  const stack: [Value, number][] = [[root, 0]]
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!
    if (++count > cap) at.fail(`value has more than ${cap} nodes`)
    if (depth > maxDepth) at.fail(`value nested deeper than ${maxDepth} levels`)
    if (v.kind === "array") for (const x of v.items) stack.push([x, depth + 1])
    else if (v.kind === "record") for (const x of v.fields.values()) stack.push([x, depth + 1])
    // `Tag { … }` is one level, as in the parser; `Tag(a, b)` nests its arguments.
    else if (v.kind === "variant") {
      const [first] = v.args
      if (v.args.length === 1 && first!.kind === "record") stack.push([first!, depth])
      else for (const x of v.args) stack.push([x, depth + 1])
    }
  }
  return count
}

/** Values beyond this are rejected before decoding (the parser's 64 Mi characters can't produce more). */
const MAX_VALUES = 64 * 1024 * 1024

const decodeAt = (value: Value, limits: Limits, key?: string | number): At => {
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH
  const probe = At.root(context("decode", Infinity, limits), key)
  const steps = limits.maxSteps ?? STEPS_PER_VALUE * countValues(value, maxDepth, MAX_VALUES, probe) + 1024
  return At.root(context("decode", steps, limits), key)
}

const encodeAt = (limits: Limits, key?: string | number): At => At.root(context("encode", DEFAULT_ENCODE_STEPS, limits), key)

/**
 * Every schema is also a Standard Schema (standard.ts), so it plugs into
 * libraries that accept one. Its input is haus: a text holding exactly one
 * value, or a parsed `Value`.
 */
export interface Schema<A> extends StandardSchemaV1<string | Value, A> {
  /** Human-readable description used in error messages. */
  readonly expected: string
  readonly decode: (value: Value, at: At) => A
  readonly encode: (value: A, at: At) => Value
  /**
   * Set by `h.Optional`: as a record field, it may be missing (`name?: T`).
   * A missing field stays missing in the decoded object; it never becomes
   * `None` or any other value (spec §1).
   */
  readonly optional?: true | undefined
}

export type Infer<S> = S extends Schema<infer A> ? A : never

/** Any schema; schemas both produce and consume their type, so `Schema<unknown>` won't do as a bound. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySchema = Schema<any>

const describe = (v: Value): string => {
  switch (v.kind) {
    case "number": return `number ${v.text.length > 30 ? v.text.slice(0, 30) + "…" : v.text}`
    case "string": return `string ${JSON.stringify(v.value.length > 30 ? v.value.slice(0, 30) + "…" : v.value)}`
    case "bytes": return `bytes (${v.bytes.length})`
    case "array": return "array"
    case "record": return "record"
    case "variant": return `variant ${v.tag}`
  }
}

/** A short description of a JS value for encode errors. Never calls the value's own methods. */
const describeJs = (value: unknown): string => {
  switch (typeof value) {
    case "string": return JSON.stringify(value.length > 30 ? value.slice(0, 30) + "…" : value)
    case "number":
    case "bigint":
    case "boolean":
    case "undefined": return String(value)
    case "symbol": return "a symbol"
    case "function": return "a function"
    default: return value === null ? "null" : Array.isArray(value) ? `an array of ${value.length}` : "an object"
  }
}

const mismatch = (expected: string, v: Value, at: At): never => at.fail(`expected ${expected}, found ${describe(v)}`)

/** The `~standard` property of a schema: validate haus text or a parsed Value. */
const standard = <A>(self: () => Schema<A>): StandardSchemaV1.Props<string | Value, A> => ({
  version: 1,
  vendor: "haus",
  validate: (input) => {
    try {
      if (typeof input === "string") return { value: parse(self(), input) }
      if (isValueNode(input)) return { value: decode(self(), input) }
      return { issues: [{ message: "expected haus text or a parsed haus Value" }] }
    } catch (e) {
      return issuesOf(e)
    }
  },
})

/** A schema written by hand (`expected`, `decode`, `encode`), made a Standard Schema too. */
export const withStandard = <A, S extends Omit<Schema<A>, "~standard">>(schema: S & Omit<Schema<A>, "~standard">): S & Schema<A> => {
  const self = { ...schema, "~standard": standard(() => self) } as S & Schema<A>
  return self
}

/** A schema from its decoder and encoder; every application counts one step. */
const make = <A>(expected: string, decode: (value: Value, at: At) => A, encode: (value: A, at: At) => Value): Schema<A> => {
  const self: Schema<A> = {
  "~standard": standard(() => self),
  expected,
  decode: (v, at) => {
    at.step()
    return decode(v, at)
  },
  encode: (a, at) => {
    at.step()
    return encode(a, at)
  },
  }
  return self
}

const invalid = (what: string, value: unknown, at: At): never => at.fail(`expected ${what}, got ${describeJs(value)}`)

// ── scalars ──────────────────────────────────────────────────

const string_ = make(
  "String",
  (v, p) => (v.kind === "string" ? v.value : mismatch("String", v, p)),
  (s, p) => (typeof s === "string" ? str(s) : invalid("a string", s, p)),
)

const short = (text: string) => (text.length > 30 ? text.slice(0, 30) + "…" : text)

/** Any integer, as a bigint (the prelude's arbitrary-size `Int`). */
const int = make(
  "Int",
  (v, p) => (v.kind === "number" && INTEGER.test(v.text) ? BigInt(v.text) : mismatch("Int", v, p)),
  (n, p) => (typeof n === "bigint" ? num(n.toString()) : invalid("a bigint", n, p)),
)

/** A bounded integer as a JS number (Int8 … UInt32). Out of range is an error. */
const smallInt = (name: string, min: number, max: number) =>
  make(name, (v, p) => {
    if (v.kind !== "number" || !INTEGER.test(v.text)) return mismatch(name, v, p)
    const n = Number(v.text) + 0 // exact within these ranges (a longer literal is out of range anyway); + 0 turns -0 into 0
    return n >= min && n <= max ? n : p.fail(`${short(v.text)} is out of range for ${name} (${min} to ${max})`)
  }, (n, p) => (typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? num(String(n)) : invalid(`an integer from ${min} to ${max}`, n, p)))

/** A bounded integer as a bigint (Int64, UInt64). Out of range is an error. */
const bigInt = (name: string, min: bigint, max: bigint) =>
  make(name, (v, p) => {
    if (v.kind !== "number" || !INTEGER.test(v.text)) return mismatch(name, v, p)
    const n = BigInt(v.text)
    return n >= min && n <= max ? n : p.fail(`${short(v.text)} is out of range for ${name} (${min} to ${max})`)
  }, (n, p) => (typeof n === "bigint" && n >= min && n <= max ? num(n.toString()) : invalid(`a bigint from ${min} to ${max}`, n, p)))

const int8 = smallInt("Int8", -128, 127)
const int16 = smallInt("Int16", -32768, 32767)
const int32 = smallInt("Int32", -2147483648, 2147483647)
const uint8 = smallInt("UInt8", 0, 255)
const uint16 = smallInt("UInt16", 0, 65535)
const uint32 = smallInt("UInt32", 0, 4294967295)
const int64 = bigInt("Int64", -(2n ** 63n), 2n ** 63n - 1n)
const uint64 = bigInt("UInt64", 0n, 2n ** 64n - 1n)

/** @deprecated Use `Int`, which is a bigint of any size. */
const bigint_ = int

/**
 * Binary floating point (spec §15): the nearest value, too large is an error.
 * Also `NaN`, `Infinity`, `NegInfinity` (prelude). Written in one spelling:
 * the fewest digits that read back as the same value.
 */
const float = (name: FloatType) => make(
  name,
  (v, p) =>
    v.kind === "number" ? (toFloat(v.text, name) ?? p.fail(`${short(v.text)} is too large for ${name}`))
    : (specialFloat(v) ?? mismatch(name, v, p)),
  (n, p) => (typeof n === "number" ? (floatValue(n, name) ?? invalid(`a number within the range of ${name}`, n, p)) : invalid("a number", n, p)),
)

const float64 = float("Float64")
/** A binary32 value, as a JS number (an exact `Math.fround` value). */
const float32 = float("Float32")

/**
 * Exact decimal, returned as its normalized literal text (e.g. "19.90",
 * "1.5e3"): any number, scale and exponent kept. Pass it to a decimal library.
 */
const decimal = make(
  "Decimal",
  (v, p) => (v.kind === "number" ? v.text : mismatch("Decimal", v, p)),
  (d, p) => numberFromText(d, 'a decimal string like "19.90"', p),
)

/**
 * A number given as literal text (a `Decimal`, a number in a raw value) as a
 * number value: normalized as the parser would (`1E5` → `1e5`, `0xFF` →
 * `255`), and within the call's limits (spec §9.8).
 */
const numberFromText = (text: unknown, expected: string, at: At): HNumber => {
  const normalized = typeof text === "string" ? normalizeNumber(text, at.limits) : undefined
  if (normalized === undefined) return invalid(expected, text, at)
  const issue = numberLimitIssue(normalized, at.limits)
  return issue === undefined ? num(normalized) : at.fail(issue)
}

const bool = make(
  "Bool",
  (v, p) =>
    v.kind === "variant" && v.args.length === 0 && (v.tag === "True" || v.tag === "False")
      ? v.tag === "True"
      : mismatch("Bool (True | False)", v, p),
  (b, p) => (typeof b === "boolean" ? variant(b ? "True" : "False") : invalid("a boolean", b, p)),
)

/** A byte string, `x"0b34ff"`, as a Uint8Array. */
const bytes_ = make(
  "Bytes",
  (v, p) => (v.kind === "bytes" ? v.bytes : mismatch("Bytes", v, p)),
  (b, p) => (b instanceof Uint8Array ? bytesValue(b) : invalid("a Uint8Array", b, p)),
)

/** A prelude scalar: `Tag("text")` where the text must match `format`. */
const taggedString = <A>(tag: string, format: RegExp, convert: (s: string) => A | undefined, toText: (a: A) => string) =>
  make(tag, (v, p) => {
    if (v.kind !== "variant" || v.tag !== tag) return mismatch(`${tag}("…")`, v, p)
    const arg = v.args[0]
    if (v.args.length !== 1 || arg?.kind !== "string") return mismatch(`${tag}("…")`, v, p)
    const out = format.test(arg.value) ? convert(arg.value) : undefined
    if (out === undefined) return p.fail(`invalid ${tag} ${JSON.stringify(arg.value.length > 40 ? arg.value.slice(0, 40) + "…" : arg.value)}`, 0)
    return out
  }, (a, p) => {
    const text = toText(a)
    if (!format.test(text) || convert(text) === undefined) return invalid(`a valid ${tag}`, text, p)
    return variant(tag, [str(text)])
  })

/** `Date("2026-11-07")`, returned as the validated ISO string. */
const date = taggedString("Date", /^\d{4}-\d{2}-\d{2}$/, (s) => (checkStdTime("Date", s) === undefined ? s : undefined), (s) => s)

/**
 * `Instant("2026-11-07T10:00:00Z")` as a JS Date, for applications that want
 * one. Lossy (spec §13.4): a Date keeps the instant in milliseconds, not the
 * offset or the fraction as written, so `Instant("…10:00:00.250+01:00")` is
 * written back as `Instant("…09:00:00.250Z")`, a different haus value with
 * another hash. `h.Instant` keeps the text.
 */
export const InstantAsDate: Schema<globalThis.Date> = taggedString(
  "Instant",
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  (s) => (checkStdTime("Instant", s) === undefined ? new globalThis.Date(s) : undefined),
  (d) => (d instanceof globalThis.Date && !isNaN(d.getTime()) ? d.toISOString() : String(d)),
)

/**
 * Any std/time type as its validated text, exactly as written:
 * `Time("09:30:00")` → "09:30:00", `Duration("PT48H")` → "PT48H". Encoding
 * writes it back unchanged, offsets and fractions included.
 */
export const StdTime = (type: StdTimeType): Schema<string> =>
  taggedString(type, /^/, (s) => (checkStdTime(type, s) === undefined ? s : undefined), (s) => s)

/** `Instant("2026-11-07T10:00:00.250+01:00")` → "2026-11-07T10:00:00.250+01:00", as written. For a JS Date, `h.InstantAsDate`. */
const instant = StdTime("Instant")

export {
  bigint_ as BigInt,
  bool as Bool,
  bytes_ as Bytes,
  date as Date,
  decimal as Decimal,
  float32 as Float32,
  float64 as Float64,
  instant as Instant,
  int as Int,
  int8 as Int8,
  int16 as Int16,
  int32 as Int32,
  int64 as Int64,
  string_ as String,
  uint8 as UInt8,
  uint16 as UInt16,
  uint32 as UInt32,
  uint64 as UInt64,
}

// ── containers ───────────────────────────────────────────────

const array_ = <A>(item: Schema<A>): Schema<readonly A[]> =>
  make<readonly A[]>(
    `Array ${item.expected}`,
    (v, p) => (v.kind === "array" ? v.items.map((x, i) => item.decode(x, p.child(i))) : mismatch(`Array ${item.expected}`, v, p)),
    (xs, p) => (Array.isArray(xs) ? p.enter(xs, () => arr((xs as readonly A[]).map((x, i) => item.encode(x, p.child(i))))) : invalid("an array", xs, p)),
  )

export { array_ as Array }

/**
 * A record used as a dictionary: any string keys, one value type
 * (`Map v` in the prelude). `{ en: "Hello", "pt-BR": "Olá" }` →
 * `Map { "en" => "Hello", "pt-BR" => "Olá" }`. A JS Map, so keys like
 * `__proto__` are plain data.
 */
const map_ = <A>(value: Schema<A>): Schema<ReadonlyMap<string, A>> =>
  make<ReadonlyMap<string, A>>(
    `Map ${value.expected}`,
    (v, p) => {
      if (v.kind !== "record") return mismatch(`Map ${value.expected} (a record)`, v, p)
      const out = new Map<string, A>()
      for (const [k, x] of v.fields) out.set(k, value.decode(x, p.child(k)))
      return out
    },
    (m, p) => {
      if (!(m instanceof Map)) return invalid("a Map", m, p)
      return p.enter(m, () => rec(new Map([...m].map(([k, x]) => {
        if (typeof k !== "string") return invalid("string keys", k, p)
        return [k, value.encode(x, p.child(k))] as const
      }))))
    },
  )

export { map_ as Map }

/**
 * `Maybe a`: `None` → `{ _tag: "None" }`, `Some(x)` → `{ _tag: "Some", value: x }`,
 * like every other variant with one argument. Tagged, never `x | null`, so
 * that `Maybe (Maybe Int)` keeps `None` and `Some(None)` apart. Always written
 * out in the data: `Maybe` is an ordinary variant, and a missing field is not
 * `None` (use `h.Optional`: `h.Optional(h.Maybe(T))` has three states, key
 * missing, None and Some).
 *
 *   const note = h.parse(h.Maybe(h.String), `Some("gift")`)   // { _tag: "Some", value: "gift" }
 *   h.Maybe.toNullable(note)                                   // "gift"
 *   h.stringify(h.Maybe(h.String), h.Maybe.none)               // "None"
 */
export type Maybe<A> = { readonly _tag: "None" } | { readonly _tag: "Some"; readonly value: A }

const none: Maybe<never> = Object.freeze({ _tag: "None" })

const isMaybe = (u: unknown): u is Maybe<unknown> =>
  typeof u === "object" && u !== null &&
  ((u as { _tag?: unknown })._tag === "None" || ((u as { _tag?: unknown })._tag === "Some" && Object.hasOwn(u, "value")))

const maybe_ = <A>(inner: Schema<A>): Schema<Maybe<A>> =>
  make(
    `Maybe ${inner.expected}`,
    (v, p) => {
      if (v.kind === "variant" && v.tag === "None" && v.args.length === 0) return none
      if (v.kind === "variant" && v.tag === "Some" && v.args.length === 1) return { _tag: "Some", value: inner.decode(v.args[0]!, p.child(0)) }
      return mismatch(`None | Some(${inner.expected})`, v, p)
    },
    (a, p) => {
      if (!isMaybe(a)) return invalid(`a Maybe ({ _tag: "None" } or { _tag: "Some", value })`, a, p)
      if (a._tag === "None") return variant("None")
      return p.enter(a, () => variant("Some", [inner.encode((a as { readonly value: A }).value, p.child(0))]))
    },
  )

export const Maybe = Object.assign(maybe_, {
  /** `None`. */
  none,
  /** `Some(value)`. */
  some: <A>(value: A): Maybe<A> => ({ _tag: "Some", value }),
  /** `Some(value)` for a value, `None` for null and undefined. */
  fromNullable: <A>(value: A | null | undefined): Maybe<A> => (value === null || value === undefined ? none : { _tag: "Some", value }),
  /** The value of a `Some`, or null for `None`. Collapses `Some(None)` and `None` of a nested Maybe: use it at the edge only. */
  toNullable: <A>(m: Maybe<A>): A | null => (m._tag === "Some" ? m.value : null),
  /** The value of a `Some`, or `orElse()` for `None`. */
  getOrElse: <A, B>(m: Maybe<A>, orElse: () => B): A | B => (m._tag === "Some" ? m.value : orElse()),
  /** Whether `u` is a Maybe: `{ _tag: "None" }` or `{ _tag: "Some", value }`. */
  is: isMaybe,
})

/**
 * A record field that may be missing: `name?: T` in a schema. In the decoded
 * object the key is then absent (`name?: T` in TypeScript); when encoding, an
 * absent key (or `undefined`) leaves the field out. Only meaningful as a
 * record field.
 *
 *   h.Record({ name: h.String, nickname: h.Optional(h.String) })
 *   // { name: "Ada" } and { name: "Ada", nickname: "ada" } are both valid
 *
 * For a partial update that can also clear a value, combine it with Maybe:
 * `h.Optional(h.Maybe(h.String))` reads a missing key (not given), `None`
 * (`{ _tag: "None" }`: clear) and `Some(x)` (`{ _tag: "Some", value: x }`: set).
 */
export const Optional = <A>(inner: Schema<A>): OptionalSchema<A> => {
  const self: OptionalSchema<A> = { ...inner, "~standard": standard(() => self), optional: true }
  return self
}

export interface OptionalSchema<A> extends Schema<A> {
  readonly optional: true
}

// ── records ──────────────────────────────────────────────────

export type Fields = Readonly<Record<string, AnySchema>>
type OptionalKeys<F extends Fields> = { [K in keyof F]: F[K] extends { readonly optional: true } ? K : never }[keyof F]
type Simplify<T> = { [K in keyof T]: T[K] } & {}
/** Required fields as `key: T`, `h.Optional` fields as `key?: T`. */
export type RecordOf<F extends Fields> = Simplify<
  { readonly [K in Exclude<keyof F, OptionalKeys<F>>]: Infer<F[K]> } & { readonly [K in OptionalKeys<F>]?: Infer<F[K]> }
>

export interface RecordSchema<A> extends Schema<A> {
  readonly kind: "record"
  readonly decodeRecord: (value: HRecord, at: At) => A
  readonly encodeRecord: (value: A, at: At) => HRecord
}

/**
 * A record with these fields. Open by default: extra fields are ignored, so
 * a newer sender can add fields without breaking this reader.
 * `{ closed: true }` rejects unknown fields instead.
 */
const record_ = <F extends Fields>(fields: F, options: { closed?: boolean } = {}): RecordSchema<RecordOf<F>> => {
  const entries = Object.entries(fields)
  const expected = `{ ${entries.map(([k, s]) => `${k}${s.optional ? "?" : ""}: ${s.expected}`).join(", ")}${options.closed ? "" : " | _"} }`
  const decodeRecord = (v: HRecord, at: At) => {
    const out: Record<string, unknown> = {}
    for (const [key, schema] of entries) {
      const field = v.fields.get(key)
      if (field !== undefined) setOwn(out, key, schema.decode(field, at.child(key)))
      else if (!schema.optional) at.fail(`missing field '${key}'`)
    }
    if (options.closed) {
      for (const key of v.fields.keys()) {
        if (!Object.hasOwn(fields, key)) at.fail(`unexpected field '${key}' (record is closed)`, key)
      }
    }
    return out as RecordOf<F>
  }
  const encodeRecord = (a: RecordOf<F>, at: At): HRecord => {
    if (typeof a !== "object" || a === null) return invalid("an object", a, at)
    return at.enter(a, () => {
      const out = new Map<string, Value>()
      for (const [key, schema] of entries) {
        const value = Object.hasOwn(a, key) ? (a as Record<string, unknown>)[key] : undefined
        // An optional field without a value is left out; nothing is written in its place.
        if (schema.optional && value === undefined) continue
        out.set(key, schema.encode(value, at.child(key)))
      }
      return rec(out)
    })
  }
  const self: RecordSchema<RecordOf<F>> = {
    "~standard": standard(() => self),
    kind: "record",
    expected,
    decodeRecord,
    encodeRecord,
    decode: (v, at) => {
      at.step()
      return v.kind === "record" ? decodeRecord(v, at) : mismatch("record", v, at)
    },
    encode: (a, at) => {
      at.step()
      return encodeRecord(a, at)
    },
  }
  return self
}

/** defineProperty: a field named "__proto__" must not replace the object's prototype. */
const setOwn = (out: Record<string, unknown>, key: string, value: unknown) =>
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })

export { record_ as Record }

// ── variants ─────────────────────────────────────────────────

/** A case without payload: `Heartbeat`. */
export const Unit: { readonly kind: "unit" } = { kind: "unit" }

/** A case with positional payload: `Point(1, 2)` → `{ _tag: "Point", values: [1, 2] }`. */
export const Tuple = <const S extends readonly AnySchema[]>(...items: S) => ({ kind: "tuple" as const, items })

export type TupleSchema<S extends readonly AnySchema[]> = { readonly kind: "tuple"; readonly items: S }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Case = typeof Unit | RecordSchema<any> | TupleSchema<readonly AnySchema[]> | AnySchema
type Cases = Readonly<Record<string, Case>>

/**
 * The decoded form of each case:
 *   Unit          → { _tag }
 *   Record({...}) → { _tag, ...fields }        (`Circle { radius: 5 }`)
 *   Tuple(a, b)   → { _tag, values: [a, b] }    (`Point(1, 2)`)
 *   any schema    → { _tag, value }             (`Ok("done")`)
 */
export type CaseOf<T extends string, C> =
  C extends typeof Unit ? { readonly _tag: T }
  : C extends RecordSchema<infer A> ? { readonly _tag: T } & A
  : C extends TupleSchema<infer S> ? { readonly _tag: T; readonly values: { readonly [I in keyof S]: Infer<S[I]> } }
  : C extends Schema<infer A> ? { readonly _tag: T; readonly value: A }
  : never

export type VariantOf<C extends Cases> = { [T in keyof C & string]: CaseOf<T, C[T]> }[keyof C & string]

/** A tag an open variant doesn't know. The raw value is kept for logging or forwarding. */
export interface Unknown {
  readonly _tag: "@unknown"
  readonly tag: string
  readonly value: HVariant
}

/** The unknown value for a variant an open type doesn't list: the tag, and the variant as it was parsed. */
const unknownOf = (v: HVariant): Unknown => ({ _tag: "@unknown", tag: v.tag, value: v })

/** Whether `u` is an `Unknown` (to encode: its raw value, after `checkedValue`). */
const isUnknown = (u: unknown): u is { readonly _tag: "@unknown"; readonly value: unknown } =>
  typeof u === "object" && u !== null && (u as { readonly _tag?: unknown })._tag === "@unknown"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isRecordSchema = (c: Case): c is RecordSchema<any> => "kind" in c && c.kind === "record"
const isTuple = (c: Case): c is TupleSchema<readonly AnySchema[]> => "kind" in c && c.kind === "tuple"

/** A list of tags for error messages, shortened for very large variants. */
const tagList = (tags: readonly string[]) => (tags.length > 10 ? `${tags.slice(0, 10).join(" | ")} | … (${tags.length} tags)` : tags.join(" | "))

const variantSchema = <C extends Cases, A>(cases: C, open: boolean): Schema<A> => {
  const tags = Object.keys(cases)
  const expected = `< ${tagList(tags)}${open ? " | _" : ""} >`
  // Dispatch is one hash lookup on the tag: never "try each case and backtrack".
  const byTag = new Map<string, Case>(Object.entries(cases))
  return make(expected, (v, at) => {
    if (v.kind !== "variant") return mismatch(expected, v, at)
    const c = byTag.get(v.tag)
    if (c === undefined) {
      if (open) return unknownOf(v) as A
      return at.fail(`unknown tag '${v.tag}', expected one of ${tagList(tags)}`)
    }
    const arity = (n: number, shape: string) => {
      if (v.args.length !== n) at.fail(`'${v.tag}' expects ${shape}, found ${v.args.length} argument(s)`)
    }
    if (c === Unit) {
      arity(0, "no payload")
      return { _tag: v.tag } as A
    }
    if (isRecordSchema(c)) {
      arity(1, "a record payload")
      const arg = v.args[0]!
      if (arg.kind !== "record") return mismatch(`${v.tag} { … }`, arg, at.child(0))
      const out = c.decodeRecord(arg, at) as Record<string, unknown>
      return Object.defineProperties({ _tag: v.tag }, Object.getOwnPropertyDescriptors(out)) as A
    }
    if (isTuple(c)) {
      arity(c.items.length, `${c.items.length} argument(s)`)
      return { _tag: v.tag, values: c.items.map((s, i) => s.decode(v.args[i]!, at.child(i))) } as A
    }
    arity(1, "one argument")
    return { _tag: v.tag, value: (c as AnySchema).decode(v.args[0]!, at.child(0)) } as A
  }, (a, at) => {
    const obj = a as { _tag?: unknown; tag?: unknown; value?: unknown; values?: unknown }
    if (typeof obj !== "object" || obj === null || typeof obj._tag !== "string") return invalid("an object with a _tag", a, at)
    // Unknown variants are written back as they were received, after checking
    // that what's there really is a haus value within the limits.
    if (open && isUnknown(obj)) return checkedValue(obj.value, at)
    const c = byTag.get(obj._tag)
    if (c === undefined) return invalid(`one of ${tagList(tags)}`, obj._tag, at)
    if (c === Unit) return variant(obj._tag)
    return at.enter(obj, () => {
      const tag = obj._tag as string
      if (isRecordSchema(c)) {
        const { _tag, ...fields } = obj as Record<string, unknown>
        return variant(tag, [c.encodeRecord(fields, at)])
      }
      if (isTuple(c)) {
        const values = obj.values
        if (!Array.isArray(values) || values.length !== c.items.length) return invalid(`${c.items.length} values`, values, at)
        return variant(tag, c.items.map((s, i) => s.encode(values[i], at.child(i))))
      }
      return variant(tag, [(c as AnySchema).encode(obj.value, at.child(0))])
    })
  })
}

const VALUE_KINDS: ReadonlySet<unknown> = new Set<Value["kind"]>(["number", "string", "bytes", "array", "record", "variant"])

/** Whether `u` looks like a haus `Value` at its top (its kind); `checkedValue` checks the rest. */
const isValueNode = (u: unknown): u is Value => typeof u === "object" && u !== null && VALUE_KINDS.has((u as { readonly kind?: unknown }).kind)

/** `xs` mapped with `f`, or `xs` itself when `f` changed nothing. */
const mapSame = <T>(xs: readonly T[], f: (x: T, i: number) => T): readonly T[] => {
  const ys = xs.map(f)
  return ys.every((y, i) => y === xs[i]) ? xs : ys
}

/**
 * A raw `Value` handed to the encoder (an `Any`, an Unknown's payload): a
 * haus value within the call's limits (spec §9.5, §9.8), checked node by
 * node: shape, depth, work, number literals, string lengths, tags. It is
 * written back as it is, except that number literals are normalized as the
 * parser would (`1E5` → `1e5`); parts without such a change are kept as they
 * are (the same objects), so a parsed value comes back unchanged.
 */
const checkedValue = (raw: unknown, at: At): Value => {
  at.step()
  if (!isValueNode(raw)) return invalid("a haus value", raw, at)
  const { maxStringLength } = at.limits
  const checkedString = (s: unknown, what: string): string => {
    if (typeof s !== "string") return invalid(what, s, at)
    return longerThan(s, maxStringLength) ? at.fail(`string longer than ${maxStringLength} characters`) : s
  }
  switch (raw.kind) {
    case "number": {
      const n = numberFromText(raw.text, "a number literal", at)
      return n.text === raw.text ? raw : n
    }
    case "string":
      checkedString(raw.value, "a string value")
      return raw
    case "bytes":
      return raw.bytes instanceof Uint8Array ? raw : invalid("a Uint8Array", raw.bytes, at)
    case "array": {
      if (!Array.isArray(raw.items)) return invalid("an array of items", raw.items, at)
      const items = mapSame(raw.items, (x, i) => checkedValue(x, at.child(i)))
      return items === raw.items ? raw : arr(items)
    }
    case "record": {
      if (!(raw.fields instanceof globalThis.Map)) return invalid("a Map of fields", raw.fields, at)
      const fields = new globalThis.Map<string, Value>()
      let changed = false
      for (const [k, x] of raw.fields) {
        const y = checkedValue(x, at.child(checkedString(k, "a string key")))
        changed ||= y !== x
        fields.set(k, y)
      }
      return changed ? rec(fields) : raw
    }
    case "variant": {
      if (typeof raw.tag !== "string" || !TAG.test(raw.tag)) return invalid("a tag name", raw.tag, at)
      if (!Array.isArray(raw.args)) return invalid("an array of arguments", raw.args, at)
      const args = mapSame(raw.args, (x, i) => checkedValue(x, at.child(i)))
      return args === raw.args ? raw : variant(raw.tag, args)
    }
  }
}

/** A closed variant: any other tag is an error. */
export const Variant = <const C extends Cases>(cases: C): Schema<VariantOf<C>> => variantSchema(cases, false)

/** An open variant (`< A | B | _ >`): other tags decode as `Unknown` instead of failing. */
export const OpenVariant = <const C extends Cases>(cases: C): Schema<VariantOf<C> | Unknown> => variantSchema(cases, true)

/** Shorthand for a closed variant of payload-less tags, decoded to string literals. */
export const Enum = <const T extends readonly string[]>(...tags: T): Schema<T[number]> => {
  const known = new Set<string>(tags)
  return make(
    `< ${tagList(tags)} >`,
    (v, at) =>
      v.kind === "variant" && v.args.length === 0 && known.has(v.tag)
        ? (v.tag as T[number])
        : mismatch(`one of ${tagList(tags)}`, v, at),
    (t, at) => (typeof t === "string" && known.has(t) ? variant(t) : invalid(`one of ${tagList(tags)}`, t, at)),
  )
}

/**
 * `< >`, a variant with any tags (spec §15): every value is an unknown one. A
 * tag without payload decodes to its name (`EUR` → "EUR"); any other value
 * to an `Unknown` that keeps it exactly.
 */
export const AnyTag: Schema<string | Unknown> = make(
  "< >",
  (v, at) => (v.kind !== "variant" ? mismatch("a variant", v, at) : v.args.length === 0 ? v.tag : unknownOf(v)),
  (a, at) =>
    typeof a === "string" ? (TAG.test(a) ? variant(a) : invalid("a tag name", a, at))
    : isUnknown(a) ? checkedValue(a.value, at)
    : invalid("a tag name or an Unknown", a, at),
)

const TAG = /^[A-Z][A-Za-z0-9_]*$/

// ── Any and Secret ───────────────────────────────────────────

/**
 * `Any` (spec §15): any value, kept exactly as parsed, as the generic haus
 * `Value` tree. For a payload this schema passes on without knowing its
 * shape. Encoding writes it back unchanged, after checking that it is a haus
 * value within the limits. Treat its content as untrusted data.
 */
const any_: Schema<Value> = make("Any", (v) => v, (a, at) => checkedValue(a, at))

export { any_ as Any }

/**
 * `f`, for the secret at `at` of type `expected`. A secret's own errors give
 * its place and its type, never the value or any part of it (spec §15):
 * errors from inside (including paths, which may hold map keys from the
 * data) are replaced by one at the secret's place.
 */
const concealed = <R>(expected: string, at: At, f: () => R): R => {
  try {
    return f()
  } catch (e) {
    if (e instanceof HausDecodeError || e instanceof HausEncodeError) at.fail(`expected ${expected} (a Secret: the value is not shown)`)
    throw e
  }
}

/**
 * `Secret a` (spec §15): the same data as `a`, decoded into a `Secret` that
 * shows `<redacted>` when printed, logged or converted to JSON; `expose()`
 * gives the value out. Errors never contain the value. Encode a
 * `h.Secret.make(value)` (or `new Secret(value)`).
 *
 *   const Config = h.Record({ apiKey: h.Secret(h.String) })
 *   const config = h.parse(Config, text)
 *   String(config.apiKey)    // "<redacted>"
 *   config.apiKey.expose()   // "sk-…"
 */
export const Secret = Object.assign(
  <A>(inner: Schema<A>): Schema<SecretValue<A>> =>
    make(
      `Secret ${inner.expected}`,
      (v, at) => new SecretValue(concealed(inner.expected, at, () => inner.decode(v, at))),
      (s, at) =>
        // Not even a short description of what was given instead: it may be the secret itself.
        s instanceof SecretValue ? concealed(inner.expected, at, () => inner.encode(s.expose(), at))
        : at.fail(`expected a Secret (h.Secret.make(…)), got ${s === null ? "null" : Array.isArray(s) ? "an array" : typeof s}`),
    ),
  {
    /** A secret holding `value`, to encode. */
    make: SecretValue.make,
    /** Whether `u` is a Secret. */
    is: SecretValue.is,
  },
)

/** A decoded `Secret a`: `expose()` gives the value; printing it shows `<redacted>`. */
export type Secret<A> = SecretValue<A>

// ── recursion ────────────────────────────────────────────────

export interface RecursiveOptions {
  /**
   * How deeply this type may be nested in itself. By default only the call's
   * nesting depth limit (`Limits.maxDepth`, 256) applies, so every binding
   * accepts the same values (spec §9.9); set a smaller limit here for a type
   * whose values should stay shallower.
   */
  readonly maxDepth?: number
}

/**
 * A type that contains itself, such as a tree or a comment thread. Schemas
 * can't refer to themselves otherwise, so recursion is always visible.
 *
 *   interface Tree { readonly name: string; readonly children: readonly Tree[] }
 *   const Tree: h.Schema<Tree> = h.Recursive<Tree>("Tree", (self) =>
 *     h.Record({ name: h.String, children: h.Array(self) }))
 *
 * Every cycle must pass through a record field, array element or variant
 * payload ("guarded"), so each level consumes one level of the input. A
 * schema that refers to itself directly, or decodes or encodes the same value
 * with itself again, fails instead of looping.
 */
export const Recursive = <A>(name: string, build: (self: Schema<A>) => Schema<A>, options: RecursiveOptions = {}): Schema<A> => {
  // Each level consumes a level of the value, so the call's depth limit bounds it too.
  const maxDepth = options.maxDepth ?? Infinity
  let body: Schema<A> | undefined
  let building = false
  // Built on first use, so it may refer to schemas defined after it (mutual recursion).
  const force = (): Schema<A> => {
    if (body) return body
    if (building) throw new Error(`h.Recursive("${name}"): used while it is being built`)
    building = true
    const built = build(self)
    if (built === self) throw new Error(`h.Recursive("${name}"): the schema is only itself (unguarded recursion)`)
    return (body = built)
  }
  const run = <R>(value: unknown, at: At, f: (body: Schema<A>) => R): R => {
    at.step()
    const b = force()
    const state = at.recursion(self)
    if (state.current === value) {
      // Entering again with the very value we're inside: an object that
      // contains itself, or a schema that consumed nothing in between.
      if (at.isEncoding(value)) at.fail("cyclic value: an object contains itself")
      at.fail(`unguarded recursion in ${name}: it applies itself to the same value again`)
    }
    if (state.depth >= maxDepth) at.fail(`${name} nested deeper than ${maxDepth} levels`)
    const saved = state.current
    state.depth++
    state.current = value
    try {
      return f(b)
    } finally {
      state.depth--
      state.current = saved
    }
  }
  const self: Schema<A> = {
    "~standard": standard(() => self),
    expected: name,
    decode: (v, at) => run(v, at, (b) => b.decode(v, at)),
    encode: (a, at) => run(a, at, (b) => b.encode(a, at)),
  }
  return self
}

// ── entry points ─────────────────────────────────────────────

export const decode = <A>(schema: Schema<A>, value: Value, limits: Limits = {}): A => schema.decode(value, decodeAt(value, limits))

/** Parse a text holding exactly one value and decode it. */
export const parse = <A>(schema: Schema<A>, text: string, limits: Limits = {}): A => {
  const values = new Parser(text, START, withDefaults(limits)).parseSequence()
  if (values.length !== 1) throw new HausDecodeError(`expected exactly one value, found ${values.length}`, [])
  return decode(schema, values[0]!, limits)
}

/** Parse and decode a stream; each element's errors carry its index in the path. Limits apply per element. */
export async function* decodeStream<A>(schema: Schema<A>, source: ChunkSource, limits: Limits = {}): AsyncGenerator<A, void, undefined> {
  let i = 0
  for await (const value of parseStream(source, { limits })) {
    yield schema.decode(value, decodeAt(value, limits, i))
    i++
  }
}

/** Encode a typed value into a haus `Value`. */
export const encode = <A>(schema: Schema<A>, value: A, limits: Limits = {}): Value => schema.encode(value, encodeAt(limits))

/** Encode and write as haus text in the standard format (no trailing newline). */
export const stringify = <A>(schema: Schema<A>, value: A, options: FormatOptions & Limits = {}): string =>
  stringifyValue(encode(schema, value, options), options)

/** Encode several values as a stream file: a comma after every value. */
export const formatAll = <A>(schema: Schema<A>, values: Iterable<A>, options: FormatOptions & Limits = {}): string =>
  format([...values].map((v, i) => schema.encode(v, encodeAt(options, i))), options)

/**
 * Encode values one at a time as stream chunks, each ending in ",\n", e.g.
 * to write them to a response or a log file as they are produced.
 */
export async function* encodeStream<A>(
  schema: Schema<A>,
  values: AsyncIterable<A> | Iterable<A>,
  options: FormatOptions & Limits = {},
): AsyncGenerator<string, void, undefined> {
  let i = 0
  // Streams default to compact: one item per line.
  for await (const v of values) yield stringifyValue(schema.encode(v, encodeAt(options, i++)), { style: "compact", ...options }) + ",\n"
}
