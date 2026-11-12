/**
 * Decode haus data with Effect schemas.
 *
 *   const Event = Haus.OpenUnion([
 *     Schema.TaggedStruct("UserCreated", { id: Schema.Number, email: Schema.String }),
 *     Schema.TaggedStruct("Heartbeat", {}),
 *   ])
 *   const events = Haus.decodeStream(Event)(response.body!)   // Stream<Event, HausError>
 *
 * The schema is compiled once into a converter from haus values to the
 * schema's encoded shape; Effect's own decoder then validates and transforms
 * it, so filters, transformations, brands and classes all work as usual.
 *
 * haus → Effect mapping:
 *   Circle { radius: 5 }     → TaggedStruct("Circle", { radius })
 *   Point(1, 2)              → TaggedStruct("Point", { x, y })     positional args fill fields in order
 *   EUR                      → Literal "EUR"  or  TaggedStruct("EUR", {})
 *   True / False             → Boolean
 *   None / Some(x)           → Option(X), or an optional key
 *   19.90                    → BigDecimal (exact), Number, BigInt, or a string (e.g. BigDecimalFromString)
 *   Instant("…")             → DateTimeUtc, or any schema encoded as a string
 *   ZonedDateTime("…")       → DateTimeZoned
 *   unknown tag in OpenUnion → { _tag: "@unknown", tag, value }
 */
import { HausSyntaxError, parseAll, parseStream, stringify, type ChunkSource, type FormatOptions, type Value } from "@haus-fmt/haus"
import { checkStdTime, type StdTimeType } from "@haus-fmt/haus"
import { Effect, Schema, SchemaAST, Stream } from "effect"
import { entries, isCodec, setId, type AnyCodec, type Checked, type Decoded, type Named } from "./codec.js"
import { withCodecs } from "./schema-file.js"
import { checkSchema, compile, compileEncoder, ConversionError, decodeBudget, DEFAULT_ENCODE_STEPS, guarded, POSITIONAL, PRELUDE_TAG, UNKNOWN_TAG } from "./convert.js"

// ── errors ───────────────────────────────────────────────────

/** The text is not valid haus. */
export class HausParseError extends Schema.TaggedError<HausParseError>()("HausParseError", {
  message: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
}) {}

/** Valid haus, but it doesn't match the schema. `index` is set for stream elements. */
export class HausSchemaError extends Schema.TaggedError<HausSchemaError>()("HausSchemaError", {
  message: Schema.String,
  index: Schema.optionalKey(Schema.Number),
  /** Where in the decoded value the error is: field names and array indexes (see `locateIssue`). */
  path: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
}) {}

/** The path of the first issue: the keys of nested Pointer issues. */
const issuePath = (issue: unknown): Array<string | number> => {
  const path: Array<string | number> = []
  let node = issue as { path?: ReadonlyArray<PropertyKey>; issue?: unknown; issues?: ReadonlyArray<unknown> } | undefined
  for (let i = 0; node && i < 1000; i++) {
    for (const k of node.path ?? []) if (typeof k === "string" || typeof k === "number") path.push(k)
    node = (node.issue ?? node.issues?.[0]) as typeof node
  }
  return path
}

/**
 * Where a decode error is in the haus value: the innermost value the error's
 * path leads to (parse with `parseWithLocations` to get offsets).
 */
export const locateIssue = (value: Value, path: ReadonlyArray<string | number>): Value => {
  let v = value
  for (let i = 0; i < path.length; i++) {
    const key = path[i]!
    let next: Value | undefined
    if (v.kind === "array" && typeof key === "number") next = v.items[key]
    else if (v.kind === "record") next = v.fields.get(String(key))
    else if (v.kind === "variant") {
      const [first] = v.args
      if (key === "values" && typeof path[i + 1] === "number") next = v.args[path[++i] as number]
      else if (v.args.length === 1 && first!.kind === "record") next = first!.fields.get(String(key))
      else if (v.tag === "Some" && v.args.length === 1) (next = first), i--
      else if (typeof key === "number") next = v.args[key]
    }
    if (next === undefined) return v
    v = next
  }
  return v
}

export type HausError = HausParseError | HausSchemaError

/** Syntax errors become HausParseError; anything else is a bug (defect). */
const toParseError = (e: unknown): HausParseError => {
  if (e instanceof HausSyntaxError) return new HausParseError({ message: e.message, line: e.line, column: e.column })
  throw e
}

// ── open unions ──────────────────────────────────────────────

/** What an OpenUnion produces for a tag none of its members knows. */
export const Unknown = Schema.TaggedStruct(UNKNOWN_TAG, {
  tag: Schema.String,
  /** The raw haus value, for logging or forwarding. */
  value: Schema.Any as Schema.Codec<Value>,
})
export type Unknown = typeof Unknown.Type

/**
 * `< A | B | _ >`: a union of tagged structs (or literals) that accepts any
 * other tag as `Unknown` instead of failing.
 */
export const OpenUnion = <const Members extends ReadonlyArray<Schema.Top>>(members: Members) =>
  Schema.Union([...members, Unknown])

/**
 * Allow positional arguments for a tagged struct: `Money(19.99, EUR)` fills
 * `{ amount, currency }` in declaration order. Opt-in, because reordering the
 * fields later would silently swap values of the same type.
 */
export const Positional = <S extends Schema.Top>(schema: S): S["Rebuild"] =>
  schema.annotate({ [POSITIONAL]: true } as never)

// ── std/time ─────────────────────────────────────────────────

const stdTime = <S extends Schema.Top>(name: StdTimeType, schema: S) => setId(schema, `std/time#${name}`)

/** A std/time type written as `Tag("…")`, kept as its validated string (the std/time profile, spec/std/time.md). */
const timeString = <const Name extends StdTimeType>(name: Name) =>
  stdTime(
    name,
    Schema.String.annotate({ [PRELUDE_TAG]: name } as never).check(Schema.makeFilter((s: string) => checkStdTime(name, s) ?? true)),
  ) as Named<Schema.String, `std/time#${Name}`>

/** `Date("2026-11-07")` as the ISO date string; encodes back to `Date("…")`. */
export const Date = timeString("Date")
/** `Time("14:30:00")` as the ISO time string. */
export const Time = timeString("Time")
/** `DateTime("2026-11-07T14:30:00")` (no zone) as the ISO string. */
export const DateTime = timeString("DateTime")
/** `Duration("PT30S")` as the ISO 8601 duration string. */
export const Duration = timeString("Duration")
/** `YearMonth("2026-11")` as the ISO string. */
export const YearMonth = timeString("YearMonth")
/** `TimeZone("Europe/Lisbon")` as the IANA name (not looked up). */
export const TimeZone = timeString("TimeZone")
/** `Instant("2026-11-07T10:00:00Z")` as an Effect `DateTime.Utc`. */
export const Instant = stdTime("Instant", Schema.DateTimeUtc.annotate({})) as Named<Schema.DateTimeUtc, "std/time#Instant">
/** `ZonedDateTime("2026-11-07T10:00:00+01:00[Europe/Lisbon]")` as an Effect `DateTime.Zoned`. */
export const ZonedDateTime = stdTime("ZonedDateTime", Schema.DateTimeZoned.annotate({})) as Named<Schema.DateTimeZoned, "std/time#ZonedDateTime">

// ── decoding ─────────────────────────────────────────────────

const decodeOptions = { onExcessProperty: "ignore", errors: "first" } as const

/** The schema with codecs applied (cached); the schema itself without codecs. */
const target = <S extends Schema.Top>(schema: S, codecs: ReadonlyArray<AnyCodec>): S => {
  if (codecs.length === 0) return schema
  entries(codecs) // two codecs for one type fail here, before anything is built
  return withCodecs(schema, codecs) as S
}

/**
 * Decode an already-parsed haus value. With codecs, their types replace the
 * named types they target (`Haus.decodeValue(Root, cents)`).
 */
export const decodeValue = <S extends Schema.Top, const C extends ReadonlyArray<AnyCodec> = []>(schema: S, ...codecs: C & Checked<S, C>) => {
  const s = target(schema, codecs)
  const ast = SchemaAST.toEncoded(s.ast)
  checkSchema(ast)
  const convert = compile(ast)
  const decode = Schema.decodeUnknownEffect(s)
  return (value: Value): Effect.Effect<Decoded<S, C>, HausSchemaError, S["DecodingServices"]> =>
    Effect.try({
      // Conversion work is bounded by the size of the input (see convert.ts).
      try: () => guarded(decodeBudget(value), () => convert(value)),
      catch: (e) => {
        if (e instanceof ConversionError) return new HausSchemaError({ message: e.message })
        throw e
      },
    }).pipe(
      Effect.flatMap((encoded) => decode(encoded, decodeOptions)),
      Effect.mapError((e) => (e instanceof HausSchemaError ? e : new HausSchemaError({ message: e.message, path: issuePath(e.issue) }))),
    ) as Effect.Effect<Decoded<S, C>, HausSchemaError, S["DecodingServices"]>
}

/**
 * Parse a text holding exactly one value and decode it:
 *
 *   Haus.decode(Root)(text)                  // the types of the schema
 *   Haus.decode(Root, cents, geojson)(text)  // with the codecs' types for Money and LatLng
 */
export const decode = <S extends Schema.Top, const C extends ReadonlyArray<AnyCodec> = []>(schema: S, ...codecs: C & Checked<S, C>) => {
  const fromValue = (decodeValue as (s: S, ...c: ReadonlyArray<AnyCodec>) => (v: Value) => Effect.Effect<Decoded<S, C>, HausSchemaError, S["DecodingServices"]>)(schema, ...codecs)
  return Effect.fn("Haus.decode")(function* (text: string) {
    const values = yield* Effect.try({ try: () => parseAll(text), catch: toParseError })
    if (values.length !== 1) {
      return yield* new HausSchemaError({ message: `expected exactly one value, found ${values.length}` })
    }
    return yield* fromValue(values[0]!)
  })
}

/**
 * Apply codecs to a value already decoded without them, e.g. a typed data
 * import (`import order from "./order.haus"`): `Haus.convert(Root, cents)(order)`.
 */
export const convert = <S extends Schema.Top, const C extends ReadonlyArray<AnyCodec> = []>(schema: S, ...codecs: C & Checked<S, C>) => {
  const encode = Schema.encodeEffect(schema as unknown as Schema.Codec<S["Type"], S["Encoded"]>)
  const decode = Schema.decodeUnknownEffect(target(schema, codecs))
  return (value: S["Type"]): Effect.Effect<Decoded<S, C>, HausSchemaError> =>
    encode(value).pipe(
      Effect.flatMap((encoded) => decode(encoded, decodeOptions)),
      Effect.mapError((e) => new HausSchemaError({ message: e.message, path: issuePath(e.issue) })),
    ) as Effect.Effect<Decoded<S, C>, HausSchemaError>
}

/** An error of the source stream, carried through the parser unchanged. */
class SourceFailure<E> {
  constructor(readonly error: E) {}
}

/**
 * Parse and decode a stream of values as they arrive. The source is an Effect
 * Stream of text or bytes (e.g. `FileSystem.stream(path)`; its errors pass
 * through), an async iterable or a web ReadableStream. Parsing stays in the
 * optimized core reader; each completed value is decoded as it is emitted.
 */
export const decodeStream = <S extends Schema.Top, const C extends ReadonlyArray<AnyCodec> = []>(schema: S, ...codecs: C & Checked<S, C>) => {
  type A = Decoded<S, C>
  const fromValue = (decodeValue as (s: S, ...c: ReadonlyArray<AnyCodec>) => (v: Value) => Effect.Effect<A, HausSchemaError, S["DecodingServices"]>)(schema, ...codecs)
  const decodeChunks = <E>(chunks: ChunkSource): Stream.Stream<A, HausError | E, S["DecodingServices"]> =>
    Stream.fromAsyncIterable(parseStream(chunks), (e): HausParseError | E =>
      e instanceof SourceFailure ? (e.error as E) : toParseError(e)).pipe(
      Stream.zipWithIndex,
      Stream.mapEffect(([value, index]) =>
        fromValue(value).pipe(Effect.mapError(({ message, path }) => new HausSchemaError({ message, index, ...(path ? { path } : {}) })))),
    )
  function decode(source: ChunkSource): Stream.Stream<A, HausError, S["DecodingServices"]>
  function decode<E, R>(source: Stream.Stream<string | Uint8Array, E, R>): Stream.Stream<A, HausError | E, S["DecodingServices"] | R>
  function decode<E, R>(source: ChunkSource | Stream.Stream<string | Uint8Array, E, R>): Stream.Stream<A, HausError | E, S["DecodingServices"] | R> {
    const decoded = Stream.isStream(source)
      ? Stream.unwrap(
        Stream.toAsyncIterableEffect(
          (source as Stream.Stream<string | Uint8Array, E, R>).pipe(Stream.mapError((e) => new SourceFailure(e))),
        ).pipe(Effect.map((chunks) => decodeChunks<E>(chunks))),
      )
      : decodeChunks<never>(source as ChunkSource)
    return decoded.pipe(Stream.withSpan("Haus.decodeStream"))
  }
  return decode
}

// ── encoding ─────────────────────────────────────────────────

/** Encode a typed value into a haus `Value` (Effect's encoder runs first: transformations, filters…). */
export const encodeValue = <S extends Schema.Top, const C extends ReadonlyArray<AnyCodec> = []>(schema: S, ...codecs: C & Checked<S, C>) => {
  const s = target(schema, codecs)
  const ast = SchemaAST.toEncoded(s.ast)
  checkSchema(ast)
  const toValue = compileEncoder(ast)
  const encode = Schema.encodeUnknownEffect(s)
  return (value: Decoded<S, C>): Effect.Effect<Value, HausSchemaError, S["EncodingServices"]> =>
    encode(value, { errors: "first" }).pipe(
      Effect.mapError((e) => new HausSchemaError({ message: e.message })),
      Effect.flatMap((encoded) =>
        Effect.try({
          try: () => guarded(DEFAULT_ENCODE_STEPS, () => toValue(encoded)),
          catch: (e) => {
            if (e instanceof ConversionError) return new HausSchemaError({ message: e.message })
            throw e
          },
        })),
    ) as Effect.Effect<Value, HausSchemaError, S["EncodingServices"]>
}

/** Codecs, or format options (the older form `encode(schema, options)`). */
const splitArgs = (args: ReadonlyArray<AnyCodec | FormatOptions | undefined>): [ReadonlyArray<AnyCodec>, FormatOptions] => {
  const codecs = args.filter(isCodec)
  const options = args.find((a): a is FormatOptions => a !== undefined && !isCodec(a)) ?? {}
  return [codecs, options]
}

/**
 * Encode a typed value as haus text in the standard format (no trailing
 * newline). Pass the same codecs as for decoding; format options go with the
 * value: `Haus.encode(Root, cents)(order, { style: "compact" })`.
 */
export function encode<S extends Schema.Top>(schema: S, options?: FormatOptions): (value: S["Type"], options?: FormatOptions) => Effect.Effect<string, HausSchemaError, S["EncodingServices"]>
export function encode<S extends Schema.Top, const C extends ReadonlyArray<AnyCodec>>(schema: S, ...codecs: C & Checked<S, C>): (value: Decoded<S, C>, options?: FormatOptions) => Effect.Effect<string, HausSchemaError, S["EncodingServices"]>
export function encode<S extends Schema.Top>(schema: S, ...args: ReadonlyArray<AnyCodec | FormatOptions | undefined>) {
  const [codecs, defaults] = splitArgs(args)
  const toValue = (encodeValue as (s: S, ...c: ReadonlyArray<AnyCodec>) => (v: unknown) => Effect.Effect<Value, HausSchemaError, S["EncodingServices"]>)(schema, ...codecs)
  return Effect.fn("Haus.encode")(function* (value: unknown, options?: FormatOptions) {
    return stringify(yield* toValue(value), { ...defaults, ...options })
  })
}

/**
 * Encode a stream of values as haus stream chunks, each ending in ",\n".
 * Compact by default (one item per line); pass `{ style: "pretty" }` for multi-line items.
 */
export function encodeStream<S extends Schema.Top>(schema: S, options?: FormatOptions): <E, R>(values: Stream.Stream<S["Type"], E, R>) => Stream.Stream<string, E | HausSchemaError, R | S["EncodingServices"]>
export function encodeStream<S extends Schema.Top, const C extends ReadonlyArray<AnyCodec>>(schema: S, ...codecs: C & Checked<S, C>): <E, R>(values: Stream.Stream<Decoded<S, C>, E, R>) => Stream.Stream<string, E | HausSchemaError, R | S["EncodingServices"]>
export function encodeStream<S extends Schema.Top>(schema: S, ...args: ReadonlyArray<AnyCodec | FormatOptions | undefined>) {
  const [codecs, options] = splitArgs(args)
  const toValue = (encodeValue as (s: S, ...c: ReadonlyArray<AnyCodec>) => (v: unknown) => Effect.Effect<Value, HausSchemaError, S["EncodingServices"]>)(schema, ...codecs)
  return <E, R>(values: Stream.Stream<unknown, E, R>): Stream.Stream<string, E | HausSchemaError, R | S["EncodingServices"]> =>
    values.pipe(
      Stream.zipWithIndex,
      Stream.mapEffect(([value, index]) =>
        toValue(value).pipe(
          Effect.map((v) => stringify(v, { style: "compact", ...options }) + ",\n"),
          Effect.mapError(({ message }) => new HausSchemaError({ message, index })),
        )),
      Stream.withSpan("Haus.encodeStream"),
    )
}

// ── codecs ───────────────────────────────────────────────────

export {
  codec, codecs, CodecTypeId, idOf, isCodec, type AnyCodec, type Codec, type CodecMap, type Checked, type Decoded, type Kind, type Lookup,
  type Named, type NamedInfo, type NotInSchema, type TypeLambda,
} from "./codec.js"

// ── schema files ─────────────────────────────────────────────

export { compileSchemaFile, definitionDoc, fromSchemaFile, schemaDeclarations, withCodecs, type CompiledSchemaFile, type DeclarationOptions, type FromSchemaFileOptions } from "./schema-file.js"
