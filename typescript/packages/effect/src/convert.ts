/**
 * haus `Value` → the encoded JS shape an Effect schema expects.
 *
 * A schema is compiled once into a tree of small converter functions
 * (pattern matching on the schema AST happens here, at compile time). Per
 * value only those closures run, which keeps stream decoding fast. Effect's
 * own decoder then validates the result, so a converter never fails: on a
 * mismatch it falls back to a schema-less conversion and lets Effect report
 * the error with its path.
 */
import {
  arr as vArr, bytes as vBytes, checkStdTime, equals, floatValue as coreFloatValue, num as vNum, rec as vRec, specialFloat, str as vStr, toFloat,
  variant as vVariant, type FloatType, type HVariant, type StdTimeType, type Value,
} from "@haus-fmt/haus"
import * as h from "@haus-fmt/haus/schema"
import { Array as Arr, BigDecimal, DateTime, Match, Option, Predicate, Redacted, SchemaAST } from "effect"

export type Converter = (value: Value) => unknown

type AST = SchemaAST.AST

/** Tag of the payload-less variant produced for unknown tags in an OpenUnion. */
export const UNKNOWN_TAG = "@unknown"

/** Annotation set by `Haus.Positional`: positional args may fill the struct's fields in order. */
export const POSITIONAL = "hausPositional"

/** Annotation set by `Haus.Date` & co.: a string written as a prelude tag, `Date("…")`. */
export const PRELUDE_TAG = "hausPreludeTag"

/** Annotation on a string schema: the value is a bare tag, `EUR` ↔ "EUR". */
export const BARE_TAG = "hausBareTag"

/** Annotation on a tagged struct `{ _tag, values }`: the variant's positional arguments are `values`. */
export const VALUES = "hausValues"

/** Annotation on a struct: a closed record `{| … |}`, other fields are an error. */
export const CLOSED = "hausClosed"

/** Annotation on a string schema: only a haus string, never a number or `Tag("…")` (a schema file's `String`). */
export const STRICT = "hausStrict"

/** Annotation on a string schema (`Haus.Decimal`): a haus number, as its exact normalized literal (`"19.90"`, `"1.5e3"`, `"-0"`). */
export const DECIMAL = "hausDecimal"

/** Annotation on an `Any` schema (`Haus.Any`): the value is the parsed haus `Value`, unchanged. */
export const VALUE = "hausValue"

/**
 * Annotation on a `Schema.Redacted` (a schema file's `Secret a`): the haus
 * type inside, for error messages that name it without the value.
 */
export const SECRET = "hausSecret"

/**
 * Annotation on a number schema: which haus number type it is. "Int" takes
 * whole numbers only (Int8 … UInt32), "Float32" rounds to binary32; without
 * it, a number schema is a Float64.
 */
export const NUMBER = "hausNumber"

export type NumberType = "Int" | FloatType

/** Thrown during conversion; `decodeValue` turns it into a HausSchemaError. `path` is where, as in Effect's issues. */
export class ConversionError {
  constructor(readonly message: string, readonly path: ReadonlyArray<string | number> = []) {}
}

/** Convert the value at `key`: an error inside names its place. */
const at = <A>(key: string | number, f: () => A): A => {
  try {
    return f()
  } catch (e) {
    if (e instanceof ConversionError) throw new ConversionError(e.message, [key, ...e.path])
    throw e
  }
}

/** A short description of a value, for errors. */
const describe = (v: Value): string => {
  switch (v.kind) {
    case "string":
      return v.value.length > 40 ? `a string ${JSON.stringify(v.value.slice(0, 40))}…` : `a string ${JSON.stringify(v.value)}`
    case "number":
      return `the number ${v.text.length > 40 ? v.text.slice(0, 40) + "…" : v.text}`
    case "bytes":
      return "a byte string"
    case "array":
      return "an array"
    case "record":
      return "a record"
    case "variant":
      return v.args.length === 0 ? `the tag ${v.tag}` : `${v.tag} with ${v.args.length === 1 && v.args[0]!.kind === "record" ? "a record" : `${v.args.length} argument(s)`}`
  }
}

/**
 * A value the schema doesn't take (spec §15: no conversion between kinds).
 * An error here, rather than a schema-less conversion that a lenient Effect
 * schema might accept (a struct takes any object, a string literal any equal string).
 */
const mismatch = (expected: string, v: Value): never => {
  throw new ConversionError(`expected ${expected}, got ${describe(v)}`)
}

const INTEGER = /^-?\d+$/

// ── value helpers ────────────────────────────────────────────

const variant = (v: Value, tag?: string, arity?: number): Option.Option<HVariant> =>
  v.kind === "variant" && (tag === undefined || v.tag === tag) && (arity === undefined || v.args.length === arity)
    ? Option.some(v)
    : Option.none()

/** A prelude scalar like `Instant("…")`: the tag with one string argument. */
const scalarString = (v: Value, tag?: string): Option.Option<string> =>
  variant(v, tag, 1).pipe(
    Option.flatMap(({ args: [arg] }) => (arg?.kind === "string" ? Option.some(arg.value) : Option.none())),
  )

// ── limits ───────────────────────────────────────────────────

/**
 * Limits for one conversion. Converters are plain closures shared by all
 * calls, so the entry points set these around each (synchronous) conversion.
 */
interface Guard {
  steps: number
  readonly maxSteps: number
  depth: number
}

/** Nested converter calls: schema wrappers plus value levels, comfortably above the parser's 256 levels. */
export const MAX_NESTING = 2048
/** Steps per input value when decoding: conversion stays linear in the input. */
export const STEPS_PER_VALUE = 16
/** Default budget when encoding, which also bounds objects shared many times (a DAG). */
export const DEFAULT_ENCODE_STEPS = 16 * 1024 * 1024

let guard: Guard = { steps: 0, maxSteps: Infinity, depth: 0 }

/** Run `f` with a fresh budget. */
export const guarded = <R>(maxSteps: number, f: () => R): R => {
  const saved = guard
  guard = { steps: 0, maxSteps, depth: 0 }
  try {
    return f()
  } finally {
    guard = saved
  }
}

const enter = () => {
  if (++guard.steps > guard.maxSteps) throw new ConversionError(`conversion budget of ${guard.maxSteps} steps exceeded`)
  if (guard.depth >= MAX_NESTING) throw new ConversionError(`value nested deeper than ${MAX_NESTING} levels (or cyclic)`)
  guard.depth++
}

const leave = () => {
  guard.depth--
}

/** The decode budget for `value`: proportional to its size. Fails on values too deep or large to be parsed input. */
export const decodeBudget = (value: Value): number => {
  let count = 0
  const stack: [Value, number][] = [[value, 0]]
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!
    if (++count > 64 * 1024 * 1024) throw new ConversionError("value has too many nodes")
    if (depth > 256) throw new ConversionError("value nested deeper than 256 levels (or cyclic)")
    if (v.kind === "array") for (const x of v.items) stack.push([x, depth + 1])
    else if (v.kind === "record") for (const x of v.fields.values()) stack.push([x, depth + 1])
    // `Tag { … }` is one level, as in the parser; `Tag(a, b)` nests its arguments.
    else if (v.kind === "variant") {
      const [first] = v.args
      if (v.args.length === 1 && first!.kind === "record") stack.push([first!, depth])
      else for (const x of v.args) stack.push([x, depth + 1])
    }
  }
  return STEPS_PER_VALUE * count + 1024
}

/** Schema-less conversion, used where the schema gives no guidance. */
const genericNode: Converter = Match.type<Value>().pipe(
  Match.discriminatorsExhaustive("kind")({
    string: (v) => v.value,
    bytes: (v) => v.bytes,
    // Exact, as spec §3 requires without a schema: whole numbers are bigints (whatever their
    // size, so the type never depends on the data), decimals BigDecimals (keeping their scale: 19.90).
    number: (v) => (/^-?\d+$/.test(v.text) ? BigInt(v.text) : BigDecimal.fromStringUnsafe(v.text)),
    array: (v) => v.items.map(generic),
    record: (v) => Object.fromEntries(Arr.map([...v.fields], ([k, x]) => [k, generic(x)])),
    variant: (v) =>
      Arr.match(v.args, {
        onEmpty: () => ({ _tag: v.tag }),
        onNonEmpty: (args) =>
          args.length === 1 && args[0].kind === "record"
            ? { _tag: v.tag, ...(generic(args[0]) as object) }
            : { _tag: v.tag, values: args.map(generic) },
      }),
  }),
)

/** Schema-less conversion, used where the schema gives no guidance. */
export const generic: Converter = (v) => {
  enter()
  try {
    return genericNode(v)
  } finally {
    leave()
  }
}

// ── AST helpers ──────────────────────────────────────────────

const resolve = (ast: AST): AST => (ast._tag === "Suspend" ? resolve(ast.thunk()) : ast)

const declarationId = (ast: SchemaAST.Declaration): Option.Option<unknown> =>
  Option.fromNullishOr((ast.annotations?.["representation"] as { readonly id?: unknown } | undefined)?.id)

/** Whether `ast` is a `Schema.Redacted`. */
export const isRedacted = (ast: AST): boolean => ast._tag === "Declaration" && Option.contains(declarationId(ast), "effect/schema/Redacted")

/** What a secret's errors say instead of anything about its value (spec §15): its type. */
export const secretMessage = (ast: AST): string => {
  const type = ast.annotations?.[SECRET]
  return `expected ${typeof type === "string" ? type : "a valid value"} (a Secret: the value is not shown)`
}

/** The `_tag` literal of a tagged-struct AST. */
const tagOf = (ast: AST): Option.Option<string> => {
  const a = resolve(ast)
  return a._tag === "Objects"
    ? Arr.findFirst(a.propertySignatures, (p) => p.name === "_tag").pipe(
      Option.flatMap(({ type }) =>
        type._tag === "Literal" && Predicate.isString(type.literal) ? Option.some(type.literal) : Option.none()),
    )
    : Option.none()
}

/**
 * Set an own property. Plain `out[key] = …` with key "__proto__" would
 * replace the object's prototype, letting data inject fields it doesn't
 * contain (`{ "__proto__": { role: "admin" } }` → `out.role === "admin"`).
 */
const setOwn = (out: Record<string, unknown>, key: string, value: unknown) => {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
}

// ── compilation ──────────────────────────────────────────────

const cache = new WeakMap<AST, Converter>()

/** Compile an encoded-side AST into a converter (memoised; handles recursive schemas). */
export const compile = (ast: AST): Converter => {
  const cached = cache.get(ast)
  if (cached) return cached
  let compiled: Converter | undefined
  const lazy: Converter = (v) => {
    enter()
    try {
      return (compiled ??= compileNode(resolve(ast)))(v)
    } finally {
      leave()
    }
  }
  cache.set(ast, lazy)
  return lazy
}

/** `Haus.Any`: the parsed value as it is. */
const asValue: Converter = (v) => v

const compileNode = (ast: AST): Converter => (ast.annotations?.[VALUE] === true ? asValue : compileByTag(ast))

const compileByTag: (ast: AST) => Converter = Match.type<AST>().pipe(
  Match.tag("String", "TemplateLiteral", compileString),
  Match.tag("Number", compileNumber),
  Match.tag("BigInt", (): Converter => (v) => (v.kind === "number" && INTEGER.test(v.text) ? BigInt(v.text) : generic(v))),
  Match.tag("Boolean", (): Converter => (v) =>
    Option.isSome(variant(v, "True", 0)) ? true : Option.isSome(variant(v, "False", 0)) ? false : generic(v)),
  // A literal takes exactly the value it is written as: `EUR` for "EUR", `"a b"` for "a b".
  Match.tag("Literal", (ast): Converter => {
    const written = literalValue(ast.literal)
    return (v) => (equals(v, written) ? ast.literal : mismatch(describe(written), v))
  }),
  Match.tag("Enum", (): Converter => (v) =>
    Option.match(variant(v, undefined, 0), { onSome: (x) => x.tag, onNone: () => generic(v) })),
  Match.tag("Arrays", (ast): Converter => {
    const elements = ast.elements.map(compile)
    const rest = Arr.head(ast.rest).pipe(Option.map(compile), Option.getOrElse(() => generic))
    return (v) => (v.kind === "array" ? v.items.map((item, i) => at(i, () => (elements[i] ?? rest)(item))) : generic(v))
  }),
  Match.tag("Objects", compileObject),
  Match.tag("Union", compileUnion),
  Match.tag("Declaration", compileDeclaration),
  Match.orElse((): Converter => generic),
)

function compileString(ast: SchemaAST.String | SchemaAST.TemplateLiteral): Converter {
  const tag = ast.annotations?.[PRELUDE_TAG]
  // `Haus.Date` & co.: the type's own tag around a string, `Date("…")`.
  if (typeof tag === "string") return (v) => Option.getOrElse(scalarString(v, tag), () => mismatch(`${tag}("…")`, v))
  // `< >` (only ever a member of a union, which hands it bare tags).
  if (ast.annotations?.[BARE_TAG] === true) return (v) => (v.kind === "variant" && v.args.length === 0 ? v.tag : mismatch("a tag", v))
  if (ast.annotations?.[STRICT] === true) return (v) => (v.kind === "string" ? v.value : mismatch("a string", v))
  // `Decimal`: the literal exactly as parsed (normalized, spec §2), scale, exponent and `-0` included.
  if (ast.annotations?.[DECIMAL] === true) return (v) => (v.kind === "number" ? v.text : mismatch("a number (Decimal)", v))
  return (v) =>
    v.kind === "string" ? v.value
    : v.kind === "number" ? v.text // exact, for BigDecimalFromString, NumberFromString, …
    : Option.getOrElse(scalarString(v), () => generic(v))
}

/** The haus number type of a number schema (Float64 unless annotated). */
const numberType = (ast: AST): NumberType => {
  const t = ast.annotations?.[NUMBER]
  return t === "Int" || t === "Float32" ? t : "Float64"
}

/** Spec §15: Int* take whole numbers only (`-0` is 0); floats round to the nearest value, and a number too large is an error. */
function compileNumber(ast: SchemaAST.Number): Converter {
  const type = numberType(ast)
  if (type === "Int") return (v) => (v.kind === "number" && INTEGER.test(v.text) ? Number(v.text) + 0 : mismatch("a whole number", v))
  return (v) =>
    v.kind === "number" ? (toFloat(v.text, type) ?? fail(`${describe(v)} is too large for ${type}`))
    : (specialFloat(v) ?? generic(v))
}

const fail = (message: string): never => {
  throw new ConversionError(message)
}

function compileObject(ast: SchemaAST.Objects): Converter {
  const tag = tagOf(ast)
  // An optionalKey is a haus optional field (`name?: T`): missing stays missing.
  // Option is a haus Maybe: always written as None / Some(…). The two are never
  // converted into each other.
  const props = new Map(ast.propertySignatures.map((p) => [String(p.name), { convert: compile(p.type) }] as const))
  const positional = ast.propertySignatures.filter((p) => p.name !== "_tag").map((p) => String(p.name))
  const allowPositional = ast.annotations?.[POSITIONAL] === true
  const values = ast.annotations?.[VALUES] === true
  const closed = ast.annotations?.[CLOSED] === true
  // `Map v`: a record with an index signature converts every field with its value schema.
  const rest = Arr.head(ast.indexSignatures).pipe(Option.map((i) => compile(i.type)), Option.getOrElse(() => generic))

  /**
   * Fields of the value: a record for a struct; for a tagged struct, the
   * payload its variant takes (spec §15): none without fields, else one record.
   */
  const fieldsOf = (v: Value): ReadonlyArray<readonly [string, Value]> => {
    if (Option.isNone(tag)) return v.kind === "record" ? [...v.fields] : mismatch("a record", v)
    const name = tag.value
    if (v.kind !== "variant" || v.tag !== name) return mismatch(`the variant ${name}`, v)
    if (values) return [["values", vArr(v.args)]] // Point(1, 2) → { values: [1, 2] }
    const [first] = v.args
    if (positional.length === 0) return v.args.length === 0 ? [] : mismatch(`${name} without a payload`, v) // Heartbeat
    if (v.args.length === 1 && first?.kind === "record") return [...first.fields] // Circle { radius: 5 }
    const record = `${name} { ${positional.map((n) => `${n}: …`).join(", ")} }`
    if (v.args.length === 0) return mismatch(record, v)
    // Point(1, 2) fills fields in declaration order, but only when the schema
    // opts in: otherwise reordering fields would silently swap values.
    if (!allowPositional) throw new ConversionError(`'${name}' has positional arguments; write ${record} or wrap its schema in Haus.Positional`)
    return v.args.map((arg, i) => [positional[i] ?? `#${i}`, arg] as const)
  }

  return (v) => {
    const out: Record<string, unknown> = Option.match(tag, { onNone: () => ({}), onSome: (t) => ({ _tag: t }) })
    for (const [key, field] of fieldsOf(v)) {
      if (key === "_tag" && Option.isSome(tag)) throw new ConversionError(`'${tag.value}' has a field named _tag, which would replace its tag`)
      const prop = props.get(key)
      if (prop !== undefined) setOwn(out, key, at(key, () => prop.convert(field)))
      else if (closed) throw new ConversionError(`unexpected field ${JSON.stringify(key)} in a closed record`, [key])
      else setOwn(out, key, at(key, () => rest(field))) // excess property: ignored by the decoder (records are open), or a Map entry
    }
    return out
  }
}

/** Members of nested unions, flattened: Union([Literals([…]), Unknown]). */
const members = (ast: SchemaAST.Union): ReadonlyArray<AST> =>
  ast.types.flatMap((m) => {
    const r = resolve(m)
    return r._tag === "Union" ? members(r) : [r]
  })

function compileUnion(ast: SchemaAST.Union): Converter {
  const types = members(ast)
  // Variants are routed by tag: tagged-struct members and literals written as tags (`EUR`, `True`).
  const byTag = new Map<string, Converter>()
  // Literals written as other values (`"a b"`, `1`), with that value.
  const literals: Array<readonly [Value, unknown]> = []
  for (const m of types) {
    Option.match(tagOf(m), {
      onSome: (t) => byTag.set(t, compile(m)),
      onNone: () => {
        if (m._tag !== "Literal") return
        const written = literalValue(m.literal)
        if (written.kind === "variant") byTag.set(written.tag, compile(m))
        else literals.push([written, m.literal])
      },
    })
  }
  const open = byTag.has(UNKNOWN_TAG)
  // `< >`: any bare tag, as its name.
  const anyTag = types.find((m) => m._tag === "String" && m.annotations?.[BARE_TAG] === true)
  // Other members (Option, Boolean, string-encoded scalars, …), by value kind.
  const others = types.filter((m) => Option.isNone(tagOf(m)) && m._tag !== "Literal" && m !== anyTag)
  const forKind = (kinds: ReadonlyArray<AST["_tag"]>) =>
    Arr.findFirst(others, (m) => kinds.includes(resolve(m)._tag)).pipe(Option.map(compile))
  const byKind = {
    string: forKind(["String", "TemplateLiteral"]),
    number: forKind(["Number", "BigInt", "Declaration", "String"]),
    bytes: forKind(["Declaration"]),
    array: forKind(["Arrays"]),
    record: forKind(["Objects"]),
    variant: Arr.head(others).pipe(Option.map(compile)),
  }
  // A value no member takes: Effect's Any / Unknown take anything, otherwise it is an error.
  const tags = [...byTag.keys()].filter((t) => t !== UNKNOWN_TAG)
  const expected = [
    ...(open || anyTag ? ["a variant"] : tags.length > 0 ? [`one of the tags ${tags.join(", ")}`] : []),
    ...literals.map(([written]) => describe(written)),
    ...others.map((m) => `a value of ${resolve(m)._tag}`),
  ].join(" or ")
  const otherwise: Converter = others.some((m) => m.annotations?.[VALUE] === true) ? asValue
    : others.some((m) => m._tag === "Any" || m._tag === "Unknown") ? generic
    : (v) => mismatch(expected, v)
  return (v) => {
    if (v.kind === "variant") {
      const exact = byTag.get(v.tag)
      if (exact) return exact(v)
      if (anyTag && v.args.length === 0) return v.tag
      if (Option.isSome(byKind.variant)) return byKind.variant.value(v)
      // Closed: no member takes this tag, so Effect rejects its schema-less form (and says which tags it takes).
      return open ? { _tag: UNKNOWN_TAG, tag: v.tag, value: v } : generic(v)
    }
    for (const [written, literal] of literals) if (equals(v, written)) return literal
    return Option.match(byKind[v.kind], { onSome: (convert) => convert(v), onNone: () => otherwise(v) })
  }
}

/** A std/time string that follows the profile (spec/std/time.md); anything else is an error, whatever the host type accepts. */
const stdTime = (type: StdTimeType, s: string): string => {
  const reason = checkStdTime(type, s)
  if (reason !== undefined) throw new ConversionError(reason)
  return s
}

function compileDeclaration(ast: SchemaAST.Declaration): Converter {
  const id = Option.getOrUndefined(declarationId(ast))
  switch (id) {
    case "effect/schema/Uint8Array":
      return (v) => (v.kind === "bytes" ? v.bytes : generic(v))
    case "effect/schema/BigDecimal":
      // Exact: never goes through a JS number.
      return (v) => (v.kind === "number" && !/[xb]/.test(v.text) ? BigDecimal.fromStringUnsafe(v.text) : generic(v))
    case "effect/schema/DateTimeUtc":
      return (v) =>
        Option.match(scalarString(v, "Instant"), {
          onNone: () => generic(v),
          onSome: (s) => Option.getOrElse(DateTime.make(stdTime("Instant", s)), () => s),
        })
    case "effect/schema/DateTimeZoned":
      return (v) =>
        Option.match(scalarString(v, "ZonedDateTime"), {
          onNone: () => generic(v),
          onSome: (s) => Option.getOrElse(DateTime.makeZonedFromString(stdTime("ZonedDateTime", s)), () => s),
        })
    case "effect/schema/Option": {
      const inner = Arr.head(ast.typeParameters).pipe(Option.map(compile), Option.getOrElse(() => generic))
      return (v) =>
        Option.isSome(variant(v, "None", 0)) ? Option.none()
        : Option.match(variant(v, "Some", 1), { onSome: (s) => Option.some(inner(s.args[0]!)), onNone: () => generic(v) })
    }
    case "effect/schema/Redacted": {
      // `Secret a`: the value converted as `a`, in a Redacted. An error inside
      // is replaced by one at the secret's place that doesn't show the value.
      const inner = Arr.head(ast.typeParameters).pipe(Option.map(compile), Option.getOrElse(() => generic))
      const message = secretMessage(ast)
      return (v) => {
        try {
          return Redacted.make(inner(v))
        } catch (e) {
          if (e instanceof ConversionError) throw new ConversionError(message)
          throw e
        }
      }
    }
    default:
      return generic
  }
}

// ── encoding: JS (Effect's encoded form) → haus Value ────────

export type Encoder = (js: unknown) => Value

const TAG_NAME = /^[A-Z][A-Za-z0-9_]*$/

/** A float in its one spelling (spec §15); a Float32 as the nearest binary32 value. */
const floatValue = (n: number, type: FloatType = "Float64"): Value => coreFloatValue(n, type) ?? fail(`${n} is too large for ${type}`)

const numberValue = (n: number): Value => floatValue(n)

/** A number schema's writer: integers as decimal integers (`-0` as 0), floats in their one spelling. */
const numberWriter = (type: NumberType) => (n: number): Value => (type === "Int" ? vNum(String(n + 0)) : floatValue(n, type))

/** A literal: tag-like strings become tags (`"EUR"` → `EUR`), others stay strings. */
const literalValue = (js: unknown): Value =>
  typeof js === "string" ? (TAG_NAME.test(js) ? vVariant(js) : vStr(js))
  : typeof js === "number" ? numberValue(js)
  : typeof js === "boolean" ? vVariant(js ? "True" : "False")
  : encodeGeneric(js)

/**
 * Exact text of a BigDecimal, keeping its scale (7.90 stays "7.90"). A
 * negative scale, or a long run of leading zeros, is written with an exponent
 * and one digit before the point, as `1.5e3` decodes (value 15, scale -2):
 * not as `1500`, a different haus value (§2), and within the number limit.
 */
export const decimalText = ({ value, scale }: BigDecimal.BigDecimal): string => {
  const sign = value < 0n ? "-" : ""
  const digits = (value < 0n ? -value : value).toString()
  if (scale === 0) return sign + digits
  if (scale < 0 || scale - digits.length > 6) {
    const exponent = digits.length - 1 - scale
    return `${sign}${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ""}e${exponent}`
  }
  const padded = digits.padStart(scale + 1, "0")
  return `${sign}${padded.slice(0, -scale)}.${padded.slice(-scale)}`
}

/** A decimal's text as a number value: a number literal within the limits (spec §9.8), normalized as the parser would. */
const decimalValue = (text: string): Value => {
  try {
    return h.encode(h.Decimal, text)
  } catch (e) {
    if (e instanceof h.HausEncodeError) throw new ConversionError(e.reason, e.path)
    throw e
  }
}

/** Schema-less conversion of plain JS data. */
export const encodeGeneric = (js: unknown): Value => {
  enter()
  try {
    return encodeGenericNode(js)
  } finally {
    leave()
  }
}

const encodeGenericNode = (js: unknown): Value => {
  if (typeof js === "string") return vStr(js)
  if (typeof js === "number") return numberValue(js)
  if (typeof js === "bigint") return vNum(js.toString())
  if (typeof js === "boolean") return vVariant(js ? "True" : "False")
  if (js instanceof Uint8Array) return vBytes(js)
  if (js === null || js === undefined) return vVariant("None")
  if (Array.isArray(js)) return vArr(js.map(encodeGeneric))
  if (Option.isOption(js)) return Option.match(js, { onNone: () => vVariant("None"), onSome: (x) => vVariant("Some", [encodeGeneric(x)]) })
  if (BigDecimal.isBigDecimal(js)) return decimalValue(decimalText(js))
  if (DateTime.isDateTime(js)) return dateTimeValue(js)
  const entries = Object.entries(js as Record<string, unknown>).filter(([, v]) => v !== undefined)
  const tag = (js as { _tag?: unknown })._tag
  if (typeof tag === "string" && TAG_NAME.test(tag)) {
    const fields = entries.filter(([k]) => k !== "_tag")
    return fields.length === 0 ? vVariant(tag) : vVariant(tag, [vRec(new Map(fields.map(([k, v]) => [k, encodeGeneric(v)])))])
  }
  return vRec(new Map(entries.map(([k, v]) => [k, encodeGeneric(v)])))
}

/** Without a zero fraction: `…T09:00:00Z`, not `…T09:00:00.000Z` (the same instant, as written). */
const noZeroFraction = (iso: string) => iso.replace(/\.000(?=Z|[+-]\d{2}:\d{2})/, "")

/**
 * An Effect DateTime as std/time text: `DateTime.Utc` as an Instant,
 * `DateTime.Zoned` as a ZonedDateTime. A zone that is an offset is written in
 * brackets too (`…+01:00[+01:00]`), as std/time requires one zone. Text that
 * std/time doesn't accept (a year beyond 9999, an offset with seconds) is an
 * error, never written.
 */
export const dateTimeText = (d: DateTime.DateTime): { readonly type: "Instant" | "ZonedDateTime"; readonly text: string } => {
  const utc = noZeroFraction(DateTime.formatIso(d))
  if (!DateTime.isZoned(d)) return { type: "Instant", text: stdTimeText("Instant", utc) }
  const zone = DateTime.zoneToString(d.zone)
  // Effect rounds an offset with seconds (local mean time before 1900) when formatting, which
  // would move the instant: such a time is written in UTC, with its zone.
  const text = DateTime.zonedOffset(d) % 60_000 !== 0 ? `${utc}[${zone}]` : `${noZeroFraction(DateTime.formatIsoOffset(d))}[${zone}]`
  return { type: "ZonedDateTime", text: stdTimeText("ZonedDateTime", text) }
}

/** `text` when std/time accepts it as `type`, else a ConversionError. */
const stdTimeText = (type: StdTimeType, text: string): string => {
  const reason = checkStdTime(type, text)
  if (reason !== undefined) throw new ConversionError(`can't write ${type}("${text}"): ${reason}`)
  return text
}

const dateTimeValue = (d: DateTime.DateTime): Value => {
  const { type, text } = dateTimeText(d)
  return vVariant(type, [vStr(text)])
}

const encCache = new WeakMap<AST, Encoder>()

/** Compile an encoded-side AST into an encoder (memoised; handles recursive schemas). */
export const compileEncoder = (ast: AST): Encoder => {
  const cached = encCache.get(ast)
  if (cached) return cached
  let compiled: Encoder | undefined
  const lazy: Encoder = (js) => {
    enter()
    try {
      return (compiled ??= encodeNode(resolve(ast)))(js)
    } finally {
      leave()
    }
  }
  encCache.set(ast, lazy)
  return lazy
}

/**
 * `Haus.Any`: the value is written back unchanged, after the checks of the
 * core's `Any`: a haus value the parser could produce, within the limits.
 */
const encodeValue: Encoder = (js) => {
  try {
    return h.encode(h.Any, js as Value)
  } catch (e) {
    if (e instanceof h.HausEncodeError) throw new ConversionError(e.reason, e.path)
    throw e
  }
}

const encodeNode = (ast: AST): Encoder => (ast.annotations?.[VALUE] === true ? encodeValue : encodeByTag(ast))

const encodeByTag: (ast: AST) => Encoder = Match.type<AST>().pipe(
  Match.tag("String", "TemplateLiteral", (ast): Encoder => {
    const tag = ast.annotations?.[PRELUDE_TAG]
    const bare = ast.annotations?.[BARE_TAG] === true
    if (ast.annotations?.[DECIMAL] === true) return (js) => (typeof js === "string" ? decimalValue(js) : encodeGeneric(js))
    return (js) =>
      typeof js !== "string" ? encodeGeneric(js)
      : bare && TAG_NAME.test(js) ? vVariant(js)
      : typeof tag === "string" ? vVariant(tag, [vStr(js)])
      : vStr(js)
  }),
  Match.tag("Number", (ast): Encoder => {
    const write = numberWriter(numberType(ast))
    return (js) => (typeof js === "number" ? write(js) : encodeGeneric(js))
  }),
  Match.tag("BigInt", (): Encoder => (js) => (typeof js === "bigint" ? vNum(js.toString()) : encodeGeneric(js))),
  Match.tag("Boolean", (): Encoder => (js) => (typeof js === "boolean" ? vVariant(js ? "True" : "False") : encodeGeneric(js))),
  Match.tag("Literal", "Enum", (): Encoder => literalValue),
  Match.tag("Arrays", (ast): Encoder => {
    const elements = ast.elements.map(compileEncoder)
    const rest = Arr.head(ast.rest).pipe(Option.map(compileEncoder), Option.getOrElse(() => encodeGeneric))
    return (js) => (Array.isArray(js) ? vArr(js.map((x, i) => (elements[i] ?? rest)(x))) : encodeGeneric(js))
  }),
  Match.tag("Objects", encodeObject),
  Match.tag("Union", encodeUnion),
  Match.tag("Declaration", encodeDeclaration),
  Match.orElse((): Encoder => encodeGeneric),
)

function encodeObject(ast: SchemaAST.Objects): Encoder {
  const tag = Option.getOrUndefined(tagOf(ast))
  const positional = ast.annotations?.[POSITIONAL] === true
  const values = ast.annotations?.[VALUES] === true
  const props = ast.propertySignatures
    .filter((p) => p.name !== "_tag")
    .map((p) => ({ name: String(p.name), encode: compileEncoder(p.type) }))
  const declared = new Set(props.map((p) => p.name))
  const rest = Arr.head(ast.indexSignatures).pipe(Option.map((i) => compileEncoder(i.type)))
  return (js) => {
    if (typeof js !== "object" || js === null) return encodeGeneric(js)
    const obj = js as Record<string, unknown>
    // The raw value of an unknown variant is written back as it was received,
    // after the same checks as an `Any` (spec §9.8).
    if (tag === UNKNOWN_TAG) return encodeValue(obj["value"])
    if (values && tag !== undefined) {
      const items = props.find((p) => p.name === "values")?.encode(obj["values"])
      return vVariant(tag, items?.kind === "array" ? items.items : [])
    }
    const present: { name: string; encode: Encoder }[] = props.filter((p) => Object.hasOwn(obj, p.name) && obj[p.name] !== undefined)
    if (Option.isSome(rest)) {
      for (const key of Object.keys(obj)) {
        if (!declared.has(key) && key !== "_tag" && obj[key] !== undefined) present.push({ name: key, encode: rest.value })
      }
    }
    if (tag === undefined) return vRec(new Map(present.map((p) => [p.name, p.encode(obj[p.name])])))
    // A tag without fields takes no payload; one with fields always a record, `Tag {}` included (spec §15).
    if (props.length === 0 && Option.isNone(rest)) return vVariant(tag)
    if (positional) return vVariant(tag, present.map((p) => p.encode(obj[p.name])))
    return vVariant(tag, [vRec(new Map(present.map((p) => [p.name, p.encode(obj[p.name])])))])
  }
}

function encodeUnion(ast: SchemaAST.Union): Encoder {
  const types = members(ast)
  const byTag = new Map<string, Encoder>()
  for (const m of types) Option.match(tagOf(m), { onSome: (t) => byTag.set(t, compileEncoder(m)), onNone: () => undefined })
  const literals = types.filter((m): m is SchemaAST.Literal => m._tag === "Literal")
  const fits = (js: unknown, m: AST): boolean => {
    switch (m._tag) {
      case "String":
      case "TemplateLiteral":
        return typeof js === "string"
      case "Number":
        return typeof js === "number"
      case "BigInt":
        return typeof js === "bigint"
      case "Boolean":
        return typeof js === "boolean"
      case "Arrays":
        return Array.isArray(js)
      case "Objects":
        return typeof js === "object" && js !== null && !Array.isArray(js) && Option.isNone(tagOf(m))
      case "Declaration": {
        const id = Option.getOrUndefined(declarationId(m))
        return id === "effect/schema/Option" ? Option.isOption(js)
          : id === "effect/schema/BigDecimal" ? BigDecimal.isBigDecimal(js)
          : id === "effect/schema/DateTimeUtc" || id === "effect/schema/DateTimeZoned" ? DateTime.isDateTime(js)
          : id === "effect/schema/Redacted" ? Redacted.isRedacted(js)
          : false
      }
      default:
        return false
    }
  }
  return (js) => {
    const tag = typeof js === "object" && js !== null ? (js as { _tag?: unknown })._tag : undefined
    if (typeof tag === "string") {
      const byTagEncoder = byTag.get(tag)
      if (byTagEncoder) return byTagEncoder(js)
    }
    if (literals.some((l) => l.literal === js)) return literalValue(js)
    const member = types.find((m) => fits(js, m))
    return member ? compileEncoder(member)(js) : encodeGeneric(js)
  }
}

function encodeDeclaration(ast: SchemaAST.Declaration): Encoder {
  switch (Option.getOrUndefined(declarationId(ast))) {
    case "effect/schema/BigDecimal":
      return (js) => (BigDecimal.isBigDecimal(js) ? decimalValue(decimalText(js)) : encodeGeneric(js))
    case "effect/schema/DateTimeUtc":
    case "effect/schema/DateTimeZoned":
      return (js) => (DateTime.isDateTime(js) ? dateTimeValue(js) : encodeGeneric(js))
    case "effect/schema/Option": {
      const inner = Arr.head(ast.typeParameters).pipe(Option.map(compileEncoder), Option.getOrElse(() => encodeGeneric))
      return (js) =>
        Option.isOption(js) ? Option.match(js, { onNone: () => vVariant("None"), onSome: (x) => vVariant("Some", [inner(x)]) }) : encodeGeneric(js)
    }
    case "effect/schema/Redacted": {
      // Written in full (the receiver needs it), but never shown in an error.
      const inner = Arr.head(ast.typeParameters).pipe(Option.map(compileEncoder), Option.getOrElse(() => encodeGeneric))
      const message = secretMessage(ast)
      return (js) => {
        if (!Redacted.isRedacted(js)) throw new ConversionError("expected a Redacted (Redacted.make(…))")
        try {
          return inner(Redacted.value(js))
        } catch (e) {
          if (e instanceof ConversionError) throw new ConversionError(message)
          throw e
        }
      }
    }
    default:
      return encodeGeneric
  }
}

// ── schema checks ────────────────────────────────────────────

/** What a union member looks like in haus, for members that contain further values. */
const containerKind = (m: AST): string | undefined => {
  const tag = Option.getOrUndefined(tagOf(m))
  if (tag !== undefined) return `variant ${tag}`
  if (m._tag === "Objects") return "record"
  if (m._tag === "Arrays") return "array"
  if (m._tag === "Declaration" && m.typeParameters.length > 0) return `declaration ${String(Option.getOrUndefined(declarationId(m)))}`
  return undefined
}

/**
 * Reject recursive schemas with ambiguous unions. Effect decodes a union by
 * trying its members in turn; when two members can both start matching the
 * same nested value (two untagged structs, two array types), a recursive
 * schema makes that exponential in the nesting depth: a small hostile input
 * can keep a server busy for hours. Members told apart by a `_tag` are fine.
 */
export const checkSchema = (root: AST): void => {
  const seen = new Set<AST>()
  let recursive = false
  const ambiguous = new Set<string>()
  const visit = (ast: AST): void => {
    if (seen.has(ast)) return
    seen.add(ast)
    switch (ast._tag) {
      case "Suspend":
        recursive = true
        return visit(ast.thunk())
      case "Objects":
        ast.propertySignatures.forEach((p) => visit(p.type))
        ast.indexSignatures.forEach((i) => visit(i.type))
        return
      case "Arrays":
        ast.elements.forEach(visit)
        ast.rest.forEach(visit)
        return
      case "Declaration":
        ast.typeParameters.forEach(visit)
        return
      case "Union": {
        const kinds = new Map<string, number>()
        for (const m of members(ast)) {
          const kind = containerKind(m)
          if (kind !== undefined) kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
        }
        for (const [kind, n] of kinds) if (n > 1) ambiguous.add(`${n} members of kind ${kind}`)
        ast.types.forEach(visit)
        return
      }
      default:
        return
    }
  }
  visit(root)
  if (recursive && ambiguous.size > 0) {
    throw new Error(
      `Haus: a recursive schema contains a union whose members can't be told apart (${[...ambiguous].join("; ")}). ` +
        "Decoding it takes exponential time on nested input. Give the members a _tag (Schema.TaggedStruct).",
    )
  }
}
