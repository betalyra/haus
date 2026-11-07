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
 */
import { format, stringify as stringifyValue, type FormatOptions } from "./format.js"
import { Parser } from "./parser.js"
import { parseStream, type ChunkSource } from "./stream.js"
import { arr, num, rec, str, variant, type HRecord, type HVariant, type Value } from "./value.js"

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

export interface Schema<A> {
  /** Human-readable description used in error messages. */
  readonly expected: string
  readonly decode: (value: Value, path: Path) => A
  readonly encode: (value: A, path: Path) => Value
  /**
   * What a record field of this type decodes to when the field is absent.
   * Unset: absence is an error. `Maybe` → undefined, `Patch` → Keep.
   */
  readonly missing?: () => A
  /** As a record field, leave the field out when this is true (`Maybe` undefined, `Patch` Keep). */
  readonly omit?: (value: A) => boolean
}

export type Infer<S> = S extends Schema<infer A> ? A : never

/** Any schema; schemas both produce and consume their type, so `Schema<unknown>` won't do as a bound. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySchema = Schema<any>

const describe = (v: Value): string => {
  switch (v.kind) {
    case "number": return `number ${v.text}`
    case "string": return `string ${JSON.stringify(v.value.length > 30 ? v.value.slice(0, 30) + "…" : v.value)}`
    case "array": return "array"
    case "record": return "record"
    case "variant": return `variant ${v.tag}`
  }
}

const mismatch = (expected: string, v: Value, path: Path): never => {
  throw new HausDecodeError(`expected ${expected}, found ${describe(v)}`, path)
}

const make = <A>(expected: string, decode: (value: Value, path: Path) => A, encode: (value: A, path: Path) => Value): Schema<A> => ({
  expected,
  decode,
  encode,
})

const invalid = (what: string, value: unknown, path: Path): never => {
  throw new HausEncodeError(`expected ${what}, got ${typeof value === "string" ? JSON.stringify(value) : String(value)}`, path)
}

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
  if (!Number.isSafeInteger(n)) throw new HausDecodeError(`integer ${v.text} does not fit a JS number exactly (use BigInt)`, p)
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

/** A prelude scalar: `Tag("text")` where the text must match `format`. */
const taggedString = <A>(tag: string, format: RegExp, convert: (s: string) => A | undefined, toText: (a: A) => string) =>
  make(tag, (v, p) => {
    if (v.kind !== "variant" || v.tag !== tag) return mismatch(`${tag}("…")`, v, p)
    const arg = v.args[0]
    if (v.args.length !== 1 || arg?.kind !== "string") return mismatch(`${tag}("…")`, v, p)
    const out = format.test(arg.value) ? convert(arg.value) : undefined
    if (out === undefined) throw new HausDecodeError(`invalid ${tag} ${JSON.stringify(arg.value)}`, [...p, 0])
    return out
  }, (a, p) => {
    const text = toText(a)
    if (!format.test(text) || convert(text) === undefined) return invalid(`a valid ${tag}`, text, p)
    return variant(tag, [str(text)])
  })

/** `Date("2026-11-07")`, returned as the validated ISO string. */
const date = taggedString("Date", /^\d{4}-\d{2}-\d{2}$/, (s) => {
  const d = new globalThis.Date(s + "T00:00:00Z")
  return !isNaN(d.getTime()) && d.toISOString().startsWith(s) ? s : undefined
}, (s) => s)

/** `Instant("2026-11-07T10:00:00Z")`, returned as a JS Date. */
const instant = taggedString(
  "Instant",
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  (s) => {
    const d = new globalThis.Date(s)
    return isNaN(d.getTime()) ? undefined : d
  },
  (d) => (d instanceof globalThis.Date && !isNaN(d.getTime()) ? d.toISOString() : String(d)),
)

export {
  bigint_ as BigInt,
  bool as Bool,
  date as Date,
  decimal as Decimal,
  float64 as Float64,
  instant as Instant,
  int as Int,
  string_ as String,
}

// ── containers ───────────────────────────────────────────────

const array_ = <A>(item: Schema<A>): Schema<A[]> =>
  make(
    `Array ${item.expected}`,
    (v, p) => (v.kind === "array" ? v.items.map((x, i) => item.decode(x, [...p, i])) : mismatch(`Array ${item.expected}`, v, p)),
    (xs, p) => (Array.isArray(xs) ? arr(xs.map((x, i) => item.encode(x, [...p, i]))) : invalid("an array", xs, p)),
  )

export { array_ as Array }

/** `None` → undefined, `Some(x)` → x. As a record field it may also be missing. */
export const Maybe = <A>(inner: Schema<A>): Schema<A | undefined> => ({
  missing: () => undefined,
  omit: (a) => a === undefined,
  ...make(
    `Maybe ${inner.expected}`,
    (v, p) => {
      if (v.kind === "variant" && v.tag === "None" && v.args.length === 0) return undefined
      if (v.kind === "variant" && v.tag === "Some" && v.args.length === 1) return inner.decode(v.args[0]!, [...p, 0])
      return mismatch(`None | Some(${inner.expected})`, v, p)
    },
    (a, p) => (a === undefined ? variant("None") : variant("Some", [inner.encode(a, [...p, 0])])),
  ),
})

/**
 * A field in a partial update. Absence and `None` are different things in haus,
 * so a PATCH body can say all three:
 *   field absent      → { _tag: "Keep" }            leave unchanged
 *   field: <value>    → { _tag: "Set", value }      for Patch(Maybe(X)): None clears, Some(x) sets
 */
export type Patch<A> = { readonly _tag: "Keep" } | { readonly _tag: "Set"; readonly value: A }

export const Patch = <A>(inner: Schema<A>): Schema<Patch<A>> => ({
  missing: () => ({ _tag: "Keep" }),
  omit: (a) => a._tag === "Keep",
  ...make<Patch<A>>(
    `Patch ${inner.expected}`,
    (v, p) => ({ _tag: "Set", value: inner.decode(v, p) }),
    (a, p) => {
      // Inside a record, Keep is left out (omit). Anywhere else there's no way to say it.
      if (a._tag === "Keep") throw new HausEncodeError("Keep can only be encoded as an absent record field", p)
      // A Set(None) of a Patch(Maybe(X)) must still be written: as an explicit None.
      return inner.encode(a.value, p)
    },
  ),
})

// ── records ──────────────────────────────────────────────────

type Fields = Readonly<Record<string, AnySchema>>
export type RecordOf<F extends Fields> = { readonly [K in keyof F]: Infer<F[K]> }

export interface RecordSchema<A> extends Schema<A> {
  readonly kind: "record"
  readonly decodeRecord: (value: HRecord, path: Path) => A
  readonly encodeRecord: (value: A, path: Path) => HRecord
}

/**
 * A record with these fields. Open by default: extra fields are ignored, so
 * a newer sender can add fields without breaking this reader.
 * `{ closed: true }` rejects unknown fields instead.
 */
const record_ = <F extends Fields>(fields: F, options: { closed?: boolean } = {}): RecordSchema<RecordOf<F>> => {
  const expected = `{ ${Object.entries(fields).map(([k, s]) => `${k}: ${s.expected}`).join(", ")}${options.closed ? "" : " | _"} }`
  const decodeRecord = (v: HRecord, p: Path) => {
    const out: Record<string, unknown> = {}
    for (const [key, schema] of Object.entries(fields)) {
      const field = v.fields.get(key)
      // defineProperty: a schema field named "__proto__" must not replace the prototype.
      const set = (value: unknown) => Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
      if (field !== undefined) set(schema.decode(field, [...p, key]))
      else if (schema.missing) set(schema.missing())
      else throw new HausDecodeError(`missing field '${key}'`, p)
    }
    if (options.closed) {
      for (const key of v.fields.keys()) {
        if (!(key in fields)) throw new HausDecodeError(`unexpected field '${key}' (record is closed)`, [...p, key])
      }
    }
    return out as RecordOf<F>
  }
  const encodeRecord = (a: RecordOf<F>, p: Path): HRecord => {
    if (typeof a !== "object" || a === null) return invalid("an object", a, p)
    const out = new Map<string, Value>()
    for (const [key, schema] of Object.entries(fields)) {
      const value = (a as Record<string, unknown>)[key]
      // A Patch(Maybe(X)) set to None is written as an explicit None; other omits leave the field out.
      if (schema.omit?.(value)) continue
      out.set(key, schema.encode(value, [...p, key]))
    }
    return rec(out)
  }
  return {
    kind: "record",
    expected,
    decodeRecord,
    encodeRecord,
    decode: (v, p) => (v.kind === "record" ? decodeRecord(v, p) : mismatch("record", v, p)),
    encode: encodeRecord,
  }
}

export { record_ as Record }

// ── variants ─────────────────────────────────────────────────

/** A case without payload: `Heartbeat`. */
export const Unit: { readonly kind: "unit" } = { kind: "unit" }

/** A case with positional payload: `Point(1, 2)` → `{ _tag: "Point", values: [1, 2] }`. */
export const Tuple = <const S extends readonly AnySchema[]>(...items: S) => ({ kind: "tuple" as const, items })

export type TupleSchema<S extends readonly AnySchema[]> = { readonly kind: "tuple"; readonly items: S }

const UNIT_VALUE = (tag: string) => variant(tag)

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

const variantSchema = <C extends Cases, A>(cases: C, open: boolean): Schema<A> => {
  const tags = Object.keys(cases)
  const expected = `< ${tags.join(" | ")}${open ? " | _" : ""} >`
  return make(expected, (v, p) => {
    if (v.kind !== "variant") return mismatch(expected, v, p)
    const c = Object.hasOwn(cases, v.tag) ? cases[v.tag] : undefined
    if (c === undefined) {
      if (open) return { _tag: "@unknown", tag: v.tag, value: v } as A
      throw new HausDecodeError(`unknown tag '${v.tag}', expected one of ${tags.join(" | ")}`, p)
    }
    const arity = (n: number, shape: string) => {
      if (v.args.length !== n) throw new HausDecodeError(`'${v.tag}' expects ${shape}, found ${v.args.length} argument(s)`, p)
    }
    if (c === Unit) {
      arity(0, "no payload")
      return { _tag: v.tag } as A
    }
    if (isRecordSchema(c)) {
      arity(1, "a record payload")
      const arg = v.args[0]!
      if (arg.kind !== "record") return mismatch(`${v.tag} { … }`, arg, [...p, 0])
      return { _tag: v.tag, ...(c.decodeRecord(arg, p) as object) } as A
    }
    if (isTuple(c)) {
      arity(c.items.length, `${c.items.length} argument(s)`)
      return { _tag: v.tag, values: c.items.map((s, i) => s.decode(v.args[i]!, [...p, i])) } as A
    }
    arity(1, "one argument")
    return { _tag: v.tag, value: (c as AnySchema).decode(v.args[0]!, [...p, 0]) } as A
  }, (a, p) => {
    const obj = a as { _tag?: unknown; tag?: unknown; value?: unknown; values?: unknown }
    if (typeof obj !== "object" || obj === null || typeof obj._tag !== "string") return invalid("an object with a _tag", a, p)
    // Unknown variants are written back as they were received.
    if (open && obj._tag === "@unknown") return obj.value as Value
    const c = Object.hasOwn(cases, obj._tag) ? cases[obj._tag] : undefined
    if (c === undefined) return invalid(`one of ${tags.join(" | ")}`, obj._tag, p)
    if (c === Unit) return UNIT_VALUE(obj._tag)
    if (isRecordSchema(c)) {
      const { _tag, ...fields } = obj as Record<string, unknown>
      return variant(obj._tag, [c.encodeRecord(fields, p)])
    }
    if (isTuple(c)) {
      const values = obj.values
      if (!Array.isArray(values) || values.length !== c.items.length) return invalid(`${c.items.length} values`, values, p)
      return variant(obj._tag, c.items.map((s, i) => s.encode(values[i], [...p, i])))
    }
    return variant(obj._tag, [(c as AnySchema).encode(obj.value, [...p, 0])])
  })
}

/** A closed variant: any other tag is an error. */
export const Variant = <const C extends Cases>(cases: C): Schema<VariantOf<C>> => variantSchema(cases, false)

/** An open variant (`< A | B | _ >`): other tags decode as `Unknown` instead of failing. */
export const OpenVariant = <const C extends Cases>(cases: C): Schema<VariantOf<C> | Unknown> => variantSchema(cases, true)

/** Shorthand for a closed variant of payload-less tags, decoded to string literals. */
export const Enum = <const T extends readonly string[]>(...tags: T): Schema<T[number]> =>
  make(
    `< ${tags.join(" | ")} >`,
    (v, p) =>
      v.kind === "variant" && v.args.length === 0 && tags.includes(v.tag)
        ? (v.tag as T[number])
        : mismatch(`one of ${tags.join(" | ")}`, v, p),
    (t, p) => (tags.includes(t) ? variant(t) : invalid(`one of ${tags.join(" | ")}`, t, p)),
  )

// ── entry points ─────────────────────────────────────────────

export const decode = <A>(schema: Schema<A>, value: Value): A => schema.decode(value, [])

/** Parse a text holding exactly one value and decode it. */
export const parse = <A>(schema: Schema<A>, text: string): A => {
  const values = new Parser(text).parseSequence()
  if (values.length !== 1) throw new HausDecodeError(`expected exactly one value, found ${values.length}`, [])
  return decode(schema, values[0]!)
}

/** Parse and decode a stream; each element's errors carry its index in the path. */
export async function* decodeStream<A>(schema: Schema<A>, source: ChunkSource): AsyncGenerator<A, void, undefined> {
  let i = 0
  for await (const value of parseStream(source)) yield schema.decode(value, [i++])
}

/** Encode a typed value into a haus `Value`. */
export const encode = <A>(schema: Schema<A>, value: A): Value => schema.encode(value, [])

/** Encode and write as haus text in the standard format (no trailing newline). */
export const stringify = <A>(schema: Schema<A>, value: A, options: FormatOptions = {}): string =>
  stringifyValue(encode(schema, value), options)

/** Encode several values as a stream file: a comma after every value. */
export const formatAll = <A>(schema: Schema<A>, values: Iterable<A>, options: FormatOptions = {}): string =>
  format([...values].map((v, i) => schema.encode(v, [i])), options)

/**
 * Encode values one at a time as stream chunks, each ending in ",\n", e.g.
 * to write them to a response or a log file as they are produced.
 */
export async function* encodeStream<A>(
  schema: Schema<A>,
  values: AsyncIterable<A> | Iterable<A>,
  options: FormatOptions = {},
): AsyncGenerator<string, void, undefined> {
  let i = 0
  // Streams default to compact: one item per line.
  for await (const v of values) yield stringifyValue(schema.encode(v, [i++]), { style: "compact", ...options }) + ",\n"
}
