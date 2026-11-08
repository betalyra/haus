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
import { HausSyntaxError, parseAll, parseStream, stringify, type ChunkSource, type FormatOptions, type Value } from "@betalyra/haus-fmt"
import { Effect, Schema, SchemaAST, Stream } from "effect"
import { BARE_TAG, checkSchema, compile, compileEncoder, ConversionError, decodeBudget, DEFAULT_ENCODE_STEPS, guarded, POSITIONAL, PRELUDE_TAG, UNKNOWN_TAG } from "./convert.js"

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

// ── prelude scalars ──────────────────────────────────────────

const preludeString = (tag: string, pattern: RegExp) =>
  Schema.String.annotate({ [PRELUDE_TAG]: tag } as never).check(Schema.isPattern(pattern))

/** `Date("2026-11-07")` as the ISO date string; encodes back to `Date("…")`. */
export const Date = preludeString("Date", /^\d{4}-\d{2}-\d{2}$/)
/** `Time("14:30:00")` as the ISO time string. */
export const Time = preludeString("Time", /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/)
/** `Duration("PT30S")` as the ISO 8601 duration string. */
export const Duration = preludeString("Duration", /^-?P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/)
/** `DateTime("2026-11-07T14:30:00")` (no zone) as the ISO string. */
export const DateTime = preludeString("DateTime", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/)
/** `YearMonth("2026-11")` as the ISO string. */
export const YearMonth = preludeString("YearMonth", /^\d{4}-\d{2}$/)
/** `TimeZone("Europe/Lisbon")` as the IANA name. */
export const TimeZone = preludeString("TimeZone", /^[A-Za-z][A-Za-z0-9_+\-/]*$/)
/** A currency, written as a bare tag of three capital letters: `EUR` ↔ "EUR" (std/money). */
export const Currency = Schema.String.annotate({ [BARE_TAG]: true } as never).check(Schema.isPattern(/^[A-Z]{3}$/))
/** `Money(19.99, EUR)` ↔ `{ _tag: "Money", amount: BigDecimal, currency: "EUR" }` (std/money). */
export const Money = Positional(Schema.TaggedStruct("Money", { amount: Schema.BigDecimal, currency: Currency }))
/** `Uuid("…")` as the UUID string. */
export const Uuid = preludeString("Uuid", /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)

// ── decoding ─────────────────────────────────────────────────

const decodeOptions = { onExcessProperty: "ignore", errors: "first" } as const

/** Decode an already-parsed haus value. */
export const decodeValue = <S extends Schema.Top>(schema: S) => {
  const ast = SchemaAST.toEncoded(schema.ast)
  checkSchema(ast)
  const convert = compile(ast)
  const decode = Schema.decodeUnknownEffect(schema)
  return (value: Value): Effect.Effect<S["Type"], HausSchemaError, S["DecodingServices"]> =>
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
    )
}

/** Parse a text holding exactly one value and decode it. */
export const decode = <S extends Schema.Top>(schema: S) => {
  const fromValue = decodeValue(schema)
  return Effect.fn("Haus.decode")(function* (text: string) {
    const values = yield* Effect.try({ try: () => parseAll(text), catch: toParseError })
    if (values.length !== 1) {
      return yield* new HausSchemaError({ message: `expected exactly one value, found ${values.length}` })
    }
    return yield* fromValue(values[0]!)
  })
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
export const decodeStream = <S extends Schema.Top>(schema: S) => {
  const fromValue = decodeValue(schema)
  const decodeChunks = <E>(chunks: ChunkSource): Stream.Stream<S["Type"], HausError | E, S["DecodingServices"]> =>
    Stream.fromAsyncIterable(parseStream(chunks), (e): HausParseError | E =>
      e instanceof SourceFailure ? (e.error as E) : toParseError(e)).pipe(
      Stream.zipWithIndex,
      Stream.mapEffect(([value, index]) =>
        fromValue(value).pipe(Effect.mapError(({ message, path }) => new HausSchemaError({ message, index, ...(path ? { path } : {}) })))),
    )
  function decode(source: ChunkSource): Stream.Stream<S["Type"], HausError, S["DecodingServices"]>
  function decode<E, R>(source: Stream.Stream<string | Uint8Array, E, R>): Stream.Stream<S["Type"], HausError | E, S["DecodingServices"] | R>
  function decode<E, R>(source: ChunkSource | Stream.Stream<string | Uint8Array, E, R>): Stream.Stream<S["Type"], HausError | E, S["DecodingServices"] | R> {
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
export const encodeValue = <S extends Schema.Top>(schema: S) => {
  const ast = SchemaAST.toEncoded(schema.ast)
  checkSchema(ast)
  const toValue = compileEncoder(ast)
  const encode = Schema.encodeUnknownEffect(schema)
  return (value: S["Type"]): Effect.Effect<Value, HausSchemaError, S["EncodingServices"]> =>
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
    )
}

/** Encode a typed value as haus text in the standard format (no trailing newline). */
export const encode = <S extends Schema.Top>(schema: S, options: FormatOptions = {}) => {
  const toValue = encodeValue(schema)
  return Effect.fn("Haus.encode")(function* (value: S["Type"]) {
    return stringify(yield* toValue(value), options)
  })
}

/**
 * Encode a stream of values as haus stream chunks, each ending in ",\n".
 * Compact by default (one item per line); pass `{ style: "pretty" }` for multi-line items.
 */
export const encodeStream = <S extends Schema.Top>(schema: S, options: FormatOptions = {}) => {
  const toValue = encodeValue(schema)
  return <E, R>(values: Stream.Stream<S["Type"], E, R>): Stream.Stream<string, E | HausSchemaError, R | S["EncodingServices"]> =>
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

// ── schema files ─────────────────────────────────────────────

export { compileSchemaFile, definitionDoc, fromSchemaFile, schemaDeclarations, type CompiledSchemaFile, type DeclarationOptions } from "./schema-file.js"
