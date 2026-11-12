/**
 * Schemas in code: describe the expected shape once, get a TypeScript type
 * and a decoder from the generic haus `Value` tree into plain JS values.
 *
 *   import * as h from "@haus-fmt/haus/schema"
 *   const User = h.Record({ id: h.Int, name: h.String })
 *   type User = h.Infer<typeof User>
 *   const user = h.parse(User, text)
 *
 * Decoding never loses precision silently: `Int` fails on integers beyond
 * 2^53 (use `BigInt`), `Decimal` keeps the exact literal text.
 *
 * Every schema also encodes: `h.stringify(User, user)` writes haus text,
 * `h.encodeStream(Event, events)` writes a stream.
 *
 * Decoding is linear in the input whatever the schema (spec §9.8): variants
 * dispatch on the tag, depth is limited, and every call has a work budget.
 * Types that contain themselves are declared with `h.Recursive`.
 */
import { format, stringify as stringifyValue, type FormatOptions } from "./format.js"
import { Parser } from "./parser.js"
import { parseStream, type ChunkSource } from "./stream.js"
import { checkStdTime, type StdTimeType } from "./std-time.js"
import { arr, bytes as bytesValue, num, rec, str, variant, type HRecord, type HVariant, type Value } from "./value.js"
import { issuesOf, type StandardSchemaV1 } from "./standard.js"

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
export interface Limits {
  /** Deepest nesting of values (default 256, the parser's limit). */
  readonly maxDepth?: number
  /**
   * Most schema steps (one per schema applied to a value). Decoding defaults
   * to 16 per value in the input plus 1024, so decoding is linear in the
   * input. Encoding defaults to 16 Mi steps, which also bounds values that
   * share sub-objects (a DAG of depth 64 would otherwise expand to 2^64 nodes).
   */
  readonly maxSteps?: number
}

const DEFAULT_MAX_DEPTH = 256
const STEPS_PER_VALUE = 16
const DEFAULT_ENCODE_STEPS = 16 * 1024 * 1024

interface Context {
  readonly mode: "decode" | "encode"
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

/** A schema from its decoder and encoder; every application counts one step. */
/** The `~standard` property of a schema: validate haus text or a parsed Value. */
const standard = <A>(self: () => Schema<A>): StandardSchemaV1.Props<string | Value, A> => ({
  version: 1,
  vendor: "haus",
  validate: (input) => {
    try {
      if (typeof input === "string") return { value: parse(self(), input) }
      if (typeof input === "object" && input !== null && VALUE_KINDS.has((input as { kind?: unknown }).kind as string)) {
        return { value: decode(self(), input as Value) }
      }
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

const INTEGER = /^-?\d+$/

/** An integer that fits a JS number exactly (|n| <= 2^53 - 1). */
const int = make("Int", (v, p) => {
  if (v.kind !== "number" || !INTEGER.test(v.text)) return mismatch("Int", v, p)
  const n = Number(v.text)
  if (!Number.isSafeInteger(n)) p.fail(`integer ${v.text.length > 30 ? v.text.slice(0, 30) + "…" : v.text} does not fit a JS number exactly (use BigInt)`)
  return n
}, (n, p) => (Number.isSafeInteger(n) ? num(String(n)) : invalid("a safe integer", n, p)))

/** Any integer, as a bigint. */
const bigint_ = make(
  "BigInt",
  (v, p) => (v.kind === "number" && INTEGER.test(v.text) ? BigInt(v.text) : mismatch("BigInt", v, p)),
  (n, p) => (typeof n === "bigint" ? num(n.toString()) : invalid("a bigint", n, p)),
)

/** Binary floating point. Rounding is accepted. Also `NaN`, `Infinity`, `NegInfinity` (prelude). */
const float64 = make("Float64", (v, p) => {
  if (v.kind === "number") return Number(v.text)
  if (v.kind === "variant" && v.args.length === 0) {
    if (v.tag === "NaN") return NaN
    if (v.tag === "Infinity") return Infinity
    if (v.tag === "NegInfinity") return -Infinity
  }
  return mismatch("Float64", v, p)
}, (n, p) => {
  if (typeof n !== "number") return invalid("a number", n, p)
  if (Number.isNaN(n)) return variant("NaN")
  if (n === Infinity) return variant("Infinity")
  if (n === -Infinity) return variant("NegInfinity")
  return num(String(n)) // shortest round-trip form, e.g. 0.1 or 1e+21
})

/** Exact decimal, returned as its literal text (e.g. "19.90"). Pass it to a decimal library. */
const DECIMAL = /^-?\d+(\.\d+)?$/
const decimal = make(
  "Decimal",
  (v, p) => (v.kind === "number" && DECIMAL.test(v.text) ? v.text : mismatch("Decimal", v, p)),
  (d, p) => (typeof d === "string" && DECIMAL.test(d) ? num(d) : invalid('a decimal string like "19.90"', d, p)),
)

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

/** `Instant("2026-11-07T10:00:00Z")`, returned as a JS Date. */
const instant = taggedString(
  "Instant",
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  (s) => (checkStdTime("Instant", s) === undefined ? new globalThis.Date(s) : undefined),
  (d) => (d instanceof globalThis.Date && !isNaN(d.getTime()) ? d.toISOString() : String(d)),
)

/**
 * Any std/time type as its validated ISO text: `Time("09:30:00")` → "09:30:00",
 * `Duration("PT48H")` → "PT48H". (`h.Instant` gives a JS Date instead.)
 */
export const StdTime = (type: StdTimeType): Schema<string> =>
  taggedString(type, /^/, (s) => (checkStdTime(type, s) === undefined ? s : undefined), (s) => s)

export {
  bigint_ as BigInt,
  bool as Bool,
  bytes_ as Bytes,
  date as Date,
  decimal as Decimal,
  float64 as Float64,
  instant as Instant,
  int as Int,
  string_ as String,
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
 * `None` → null, `Some(x)` → x. Always written out in the data: `Maybe` is an
 * ordinary variant, and a missing field is not `None` (use `h.Optional`).
 * `null` rather than `undefined`, so that `h.Optional(h.Maybe(T))` keeps all
 * three states apart: key missing, `null` (None) and a value.
 */
export const Maybe = <A>(inner: Schema<A>): Schema<A | null> =>
  make(
    `Maybe ${inner.expected}`,
    (v, p) => {
      if (v.kind === "variant" && v.tag === "None" && v.args.length === 0) return null
      if (v.kind === "variant" && v.tag === "Some" && v.args.length === 1) return inner.decode(v.args[0]!, p.child(0))
      return mismatch(`None | Some(${inner.expected})`, v, p)
    },
    (a, p) => (a === null ? variant("None") : variant("Some", [inner.encode(a, p.child(0))])),
  )

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
 * (`null`: clear) and `Some(x)` (set).
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
      if (open) return { _tag: "@unknown", tag: v.tag, value: v } as A
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
    if (open && obj._tag === "@unknown") return checkedValue(obj.value, at)
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

const VALUE_KINDS = new Set(["number", "string", "bytes", "array", "record", "variant"])

/** A raw `Value` handed to the encoder (an Unknown's payload): check its shape, depth and size. */
const checkedValue = (raw: unknown, at: At): Value => {
  const stack: [unknown, At][] = [[raw, at]]
  while (stack.length > 0) {
    const [v, here] = stack.pop()!
    here.step()
    const kind = typeof v === "object" && v !== null ? (v as { kind?: unknown }).kind : undefined
    if (typeof kind !== "string" || !VALUE_KINDS.has(kind)) return invalid("a haus value", v, here)
    const value = v as Value
    if (value.kind === "array") value.items.forEach((x, i) => stack.push([x, here.child(i)]))
    else if (value.kind === "record") for (const [k, x] of value.fields) stack.push([x, here.child(k)])
    else if (value.kind === "variant") value.args.forEach((x, i) => stack.push([x, here.child(i)]))
  }
  return raw as Value
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

// ── recursion ────────────────────────────────────────────────

export interface RecursiveOptions {
  /**
   * How deeply this type may be nested in itself (default 64). Kept well
   * below the overall depth limit: recursion is where a small input can
   * make a schema do the most work, so it gets its own, explicit bound.
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
  const maxDepth = options.maxDepth ?? 64
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
  const values = new Parser(text).parseSequence()
  if (values.length !== 1) throw new HausDecodeError(`expected exactly one value, found ${values.length}`, [])
  return decode(schema, values[0]!, limits)
}

/** Parse and decode a stream; each element's errors carry its index in the path. Limits apply per element. */
export async function* decodeStream<A>(schema: Schema<A>, source: ChunkSource, limits: Limits = {}): AsyncGenerator<A, void, undefined> {
  let i = 0
  for await (const value of parseStream(source)) {
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
