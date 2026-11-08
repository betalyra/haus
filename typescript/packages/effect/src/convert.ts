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
import { arr as vArr, bytes as vBytes, num as vNum, rec as vRec, str as vStr, variant as vVariant, type HVariant, type Value } from "@betalyra/haus-fmt"
import { Array as Arr, BigDecimal, DateTime, Match, Option, Predicate, SchemaAST } from "effect"

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

/** Thrown during conversion; `decodeValue` turns it into a HausSchemaError. */
export class ConversionError {
  constructor(readonly message: string) {}
}

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
    number: (v) => Number(v.text),
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

const isOptionDeclaration = (ast: AST) => {
  const a = resolve(ast)
  return a._tag === "Declaration" && Option.contains(declarationId(a), "effect/schema/Option")
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

const compileNode: (ast: AST) => Converter = Match.type<AST>().pipe(
  Match.tag("String", "TemplateLiteral", (ast): Converter => (v) =>
    v.kind === "string" ? v.value
    : ast.annotations?.[BARE_TAG] === true && v.kind === "variant" && v.args.length === 0 ? v.tag
    : v.kind === "number" ? v.text // exact, for BigDecimalFromString, NumberFromString, …
    : Option.getOrElse(scalarString(v), () => generic(v))),
  Match.tag("Number", (): Converter => (v) =>
    v.kind === "number" ? Number(v.text)
    : Option.isSome(variant(v, "NaN", 0)) ? NaN
    : Option.isSome(variant(v, "Infinity", 0)) ? Infinity
    : Option.isSome(variant(v, "NegInfinity", 0)) ? -Infinity
    : generic(v)),
  Match.tag("BigInt", (): Converter => (v) => (v.kind === "number" && /^-?\d+$/.test(v.text) ? BigInt(v.text) : generic(v))),
  Match.tag("Boolean", (): Converter => (v) =>
    Option.isSome(variant(v, "True", 0)) ? true : Option.isSome(variant(v, "False", 0)) ? false : generic(v)),
  Match.tag("Literal", "Enum", (): Converter => (v) =>
    Option.match(variant(v, undefined, 0), { onSome: (x) => x.tag, onNone: () => generic(v) })),
  Match.tag("Arrays", (ast): Converter => {
    const elements = ast.elements.map(compile)
    const rest = Arr.head(ast.rest).pipe(Option.map(compile), Option.getOrElse(() => generic))
    return (v) => (v.kind === "array" ? v.items.map((item, i) => (elements[i] ?? rest)(item)) : generic(v))
  }),
  Match.tag("Objects", compileObject),
  Match.tag("Union", compileUnion),
  Match.tag("Declaration", compileDeclaration),
  Match.orElse((): Converter => generic),
)

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

  /** Fields of the value: a record, or a variant payload for tagged structs. */
  const fieldsOf = (v: Value): Option.Option<ReadonlyArray<readonly [string, Value]>> => {
    if (v.kind === "record") return Option.some([...v.fields])
    if (Option.isNone(tag) || v.kind !== "variant") return Option.none()
    if (values) return Option.some([["values", vArr(v.args)]]) // Point(1, 2) → { values: [1, 2] }
    const [first] = v.args
    if (v.args.length === 0 || (v.args.length === 1 && first?.kind === "record")) {
      return Option.some(first?.kind === "record" ? [...first.fields] : []) // Heartbeat, Circle { radius: 5 }
    }
    // Point(1, 2) fills fields in declaration order, but only when the schema
    // opts in: otherwise reordering fields would silently swap values.
    if (!allowPositional) {
      throw new ConversionError(
        `'${v.tag}' has positional arguments; write ${v.tag} { ${positional.map((n) => `${n}: …`).join(", ")} } or wrap its schema in Haus.Positional`,
      )
    }
    return Option.some(v.args.map((arg, i) => [positional[i] ?? `#${i}`, arg] as const))
  }

  return (v) =>
    Option.match(fieldsOf(v), {
      onNone: () => generic(v),
      onSome: (fields) => {
        const out: Record<string, unknown> = Option.match(tag, { onNone: () => ({}), onSome: (t) => ({ _tag: t }) })
        for (const [key, field] of fields) {
          if (key === "_tag" && Option.isSome(tag)) throw new ConversionError(`'${tag.value}' has a field named _tag, which would replace its tag`)
          const prop = props.get(key)
          if (prop !== undefined) setOwn(out, key, prop.convert(field))
          else if (closed) throw new ConversionError(`unexpected field ${JSON.stringify(key)} in a closed record`)
          else setOwn(out, key, rest(field)) // excess property: ignored by the decoder (records are open), or a Map entry
        }
        return out
      },
    })
}

/** Members of nested unions, flattened: Union([Literals([…]), Unknown]). */
const members = (ast: SchemaAST.Union): ReadonlyArray<AST> =>
  ast.types.flatMap((m) => {
    const r = resolve(m)
    return r._tag === "Union" ? members(r) : [r]
  })

function compileUnion(ast: SchemaAST.Union): Converter {
  const types = members(ast)
  // Variants are routed by tag: tagged-struct members and string literals.
  const byTag = new Map<string, Converter>()
  for (const m of types) {
    Option.match(tagOf(m), {
      onSome: (t) => byTag.set(t, compile(m)),
      onNone: () => {
        if (m._tag === "Literal" && Predicate.isString(m.literal)) byTag.set(m.literal, () => m.literal)
      },
    })
  }
  const open = byTag.has(UNKNOWN_TAG)
  // Other members (Option, Boolean, string-encoded scalars, …), by value kind.
  const others = types.filter((m) => Option.isNone(tagOf(m)) && m._tag !== "Literal")
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
  return (v) => {
    if (v.kind === "variant") {
      const exact = byTag.get(v.tag)
      if (exact) return exact(v)
      if (Option.isSome(byKind.variant)) return byKind.variant.value(v)
      return open ? { _tag: UNKNOWN_TAG, tag: v.tag, value: v } : generic(v)
    }
    return Option.match(byKind[v.kind], { onSome: (convert) => convert(v), onNone: () => generic(v) })
  }
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
          onSome: (s) => Option.getOrElse(DateTime.make(s), () => s),
        })
    case "effect/schema/DateTimeZoned":
      return (v) =>
        Option.match(scalarString(v, "ZonedDateTime"), {
          onNone: () => generic(v),
          onSome: (s) => Option.getOrElse(DateTime.makeZonedFromString(s), () => s),
        })
    case "effect/schema/Option": {
      const inner = Arr.head(ast.typeParameters).pipe(Option.map(compile), Option.getOrElse(() => generic))
      return (v) =>
        Option.isSome(variant(v, "None", 0)) ? Option.none()
        : Option.match(variant(v, "Some", 1), { onSome: (s) => Option.some(inner(s.args[0]!)), onNone: () => generic(v) })
    }
    default:
      return generic
  }
}

// ── encoding: JS (Effect's encoded form) → haus Value ────────

export type Encoder = (js: unknown) => Value

const TAG_NAME = /^[A-Z][A-Za-z0-9_]*$/

const numberValue = (n: number): Value =>
  Number.isNaN(n) ? vVariant("NaN")
  : n === Infinity ? vVariant("Infinity")
  : n === -Infinity ? vVariant("NegInfinity")
  : vNum(String(n))

/** A literal: tag-like strings become tags (`"EUR"` → `EUR`), others stay strings. */
const literalValue = (js: unknown): Value =>
  typeof js === "string" ? (TAG_NAME.test(js) ? vVariant(js) : vStr(js))
  : typeof js === "number" ? numberValue(js)
  : typeof js === "boolean" ? vVariant(js ? "True" : "False")
  : encodeGeneric(js)

/** Exact text of a BigDecimal, keeping its scale (7.90 stays "7.90"). */
const decimalText = ({ value, scale }: BigDecimal.BigDecimal): string => {
  if (scale <= 0) return (value * 10n ** BigInt(-scale)).toString()
  const digits = (value < 0n ? -value : value).toString().padStart(scale + 1, "0")
  return `${value < 0n ? "-" : ""}${digits.slice(0, -scale)}.${digits.slice(-scale)}`
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
  if (BigDecimal.isBigDecimal(js)) return vNum(decimalText(js))
  if (DateTime.isDateTime(js)) return dateTimeValue(js)
  const entries = Object.entries(js as Record<string, unknown>).filter(([, v]) => v !== undefined)
  const tag = (js as { _tag?: unknown })._tag
  if (typeof tag === "string" && TAG_NAME.test(tag)) {
    const fields = entries.filter(([k]) => k !== "_tag")
    return fields.length === 0 ? vVariant(tag) : vVariant(tag, [vRec(new Map(fields.map(([k, v]) => [k, encodeGeneric(v)])))])
  }
  return vRec(new Map(entries.map(([k, v]) => [k, encodeGeneric(v)])))
}

const dateTimeValue = (d: DateTime.DateTime): Value =>
  DateTime.isZoned(d) ? vVariant("ZonedDateTime", [vStr(DateTime.formatIsoZoned(d))]) : vVariant("Instant", [vStr(DateTime.formatIso(d))])

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

const encodeNode: (ast: AST) => Encoder = Match.type<AST>().pipe(
  Match.tag("String", "TemplateLiteral", (ast): Encoder => {
    const tag = ast.annotations?.[PRELUDE_TAG]
    const bare = ast.annotations?.[BARE_TAG] === true
    return (js) =>
      typeof js !== "string" ? encodeGeneric(js)
      : bare && TAG_NAME.test(js) ? vVariant(js)
      : typeof tag === "string" ? vVariant(tag, [vStr(js)])
      : vStr(js)
  }),
  Match.tag("Number", (): Encoder => (js) => (typeof js === "number" ? numberValue(js) : encodeGeneric(js))),
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
    // The raw value of an unknown variant is written back as it was received.
    if (tag === UNKNOWN_TAG) return obj["value"] as Value
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
    if (present.length === 0) return vVariant(tag)
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
      return (js) => (BigDecimal.isBigDecimal(js) ? vNum(decimalText(js)) : encodeGeneric(js))
    case "effect/schema/DateTimeUtc":
    case "effect/schema/DateTimeZoned":
      return (js) => (DateTime.isDateTime(js) ? dateTimeValue(js) : encodeGeneric(js))
    case "effect/schema/Option": {
      const inner = Arr.head(ast.typeParameters).pipe(Option.map(compileEncoder), Option.getOrElse(() => encodeGeneric))
      return (js) =>
        Option.isOption(js) ? Option.match(js, { onNone: () => vVariant("None"), onSome: (x) => vVariant("Some", [inner(x)]) }) : encodeGeneric(js)
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
