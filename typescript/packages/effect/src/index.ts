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
 *   None / Some(x)           → Option(X)   (a missing field is not None: `x?: T` is optionalKey(T))
 *   19.90                    → Haus.Decimal (the exact text, "19.90"), Number (Float64), Haus.Float32, BigInt
 *   Instant("…")             → Haus.Instant (the text as written)
 *   ZonedDateTime("…")       → Haus.ZonedDateTime (the text as written)
 *   unknown tag in OpenUnion → { _tag: "@unknown", tag, value }
 *   any value                → Haus.Any: the parsed haus Value, unchanged
 *   a secret (Secret a)      → Schema.Redacted(A): errors inside never show the value
 *
 * The defaults keep the value: encoding what they decoded writes an equal
 * haus value (spec §13.4). Host types that keep less are a choice:
 * `Haus.DecimalAsBigDecimal`, `Haus.InstantAsDateTime` and
 * `Haus.ZonedDateTimeAsDateTime` in hand-written schemas, and the codecs
 * `Haus.decimalAsBigDecimal`, `Haus.instantAsDateTime` and
 * `Haus.zonedDateTimeAsDateTime` for schema files (`Schema.BigDecimal`,
 * `Schema.DateTimeUtc` and `Schema.DateTimeZoned` work as well, with the same losses).
 */
import { HausSyntaxError, parseAll, parseStream, stringify, type ChunkSource, type FormatOptions, type Value } from "@haus-fmt/haus"
import { checkStdTime, normalizeNumber, type StdTimeType } from "@haus-fmt/haus"
import { BigDecimal, DateTime as EffectDateTime, Effect, Option, Schema, SchemaAST, SchemaIssue, SchemaTransformation, Stream } from "effect"
import { codec, entries, isCodec, setId, type AnyCodec, type Checked, type Decoded, type Named } from "./codec.js"
import { withCodecs } from "./schema-file.js"
import {
  checkSchema, compile, compileEncoder, ConversionError, dateTimeText, DECIMAL, decimalText, decodeBudget, DEFAULT_ENCODE_STEPS, guarded, isRedacted, NUMBER, POSITIONAL,
  PRELUDE_TAG, secretMessage, UNKNOWN_TAG, VALUE,
} from "./convert.js"

export type { Value }

// ── errors ───────────────────────────────────────────────────

/** The text is not valid haus. */
export class HausParseError extends Schema.TaggedError<HausParseError, { readonly brand: unique symbol }>()("HausParseError", {
  message: Schema.String,
  line: Schema.Int,
  column: Schema.Int,
}) {}

/** Valid haus, but it doesn't match the schema. `index` is set for stream elements. */
export class HausSchemaError extends Schema.TaggedError<HausSchemaError, { readonly brand: unique symbol }>()("HausSchemaError", {
  message: Schema.String,
  index: Schema.optionalKey(Schema.Int),
  /** Where in the decoded value the error is: field names and array indexes (see `locateIssue`). */
  path: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Schema.Int]))),
}) {}

type Path = ReadonlyArray<string | number>

/** The parts of an Effect schema issue read here. */
interface IssueNode {
  readonly path?: ReadonlyArray<PropertyKey>
  readonly issue?: unknown
  readonly issues?: ReadonlyArray<unknown>
  readonly ast?: SchemaAST.AST
}

/** An issue, its first nested issue, and so on: the way to the first error. */
function* firstIssues(issue: unknown): Generator<IssueNode> {
  let node = issue as IssueNode | undefined
  for (let i = 0; node && i < 1000; i++) {
    yield node
    node = (node.issue ?? node.issues?.[0]) as IssueNode | undefined
  }
}

const keysOf = (node: IssueNode): Path => (node.path ?? []).filter((k): k is string | number => typeof k === "string" || typeof k === "number")

/** The path of the first issue: the keys of nested Pointer issues. */
const issuePath = (issue: unknown): Path => [...firstIssues(issue)].flatMap(keysOf)

/**
 * An issue inside a `Schema.Redacted` (a `Secret`): its place, and a message
 * naming the type. Effect's own message there never shows the value, but
 * doesn't name the type either (spec §15 asks for both).
 */
const secretIssue = (issue: unknown): Option.Option<{ readonly path: Path; readonly message: string }> => {
  const path: Array<string | number> = []
  for (const node of firstIssues(issue)) {
    if (node.ast && isRedacted(node.ast)) return Option.some({ path, message: secretMessage(node.ast) })
    path.push(...keysOf(node))
  }
  return Option.none()
}

/** An Effect schema error as a HausSchemaError, with its path. */
const schemaError = (e: { readonly message: string; readonly issue: unknown }): HausSchemaError =>
  Option.match(secretIssue(e.issue), {
    onSome: conversionError,
    onNone: () => new HausSchemaError({ message: e.message, path: [...issuePath(e.issue)] }),
  })

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

// ── Any ──────────────────────────────────────────────────────

/**
 * `Any` (spec §15): any value, kept exactly as parsed, as the haus `Value`
 * tree. Encoding writes it back unchanged, after checking that it is a haus
 * value within the limits. Treat its content as untrusted data.
 */
export const Any = Schema.Any.annotate({ [VALUE]: true }) as unknown as Schema.Codec<Value>

/** A syntax error of the core parser as a HausParseError. */
const parseErrorOf = (e: unknown): Option.Option<HausParseError> =>
  e instanceof HausSyntaxError ? Option.some(new HausParseError({ message: e.message, line: e.line, column: e.column })) : Option.none()

/** A conversion error as a HausSchemaError. */
const conversionErrorOf = (e: unknown): Option.Option<HausSchemaError> =>
  e instanceof ConversionError ? Option.some(conversionError(e)) : Option.none()

/**
 * A synchronous step of the core or the converters (which report errors by
 * throwing), at the boundary to Effect: the exceptions `expected` recognizes
 * fail with its typed error; any other exception is a bug and stays a defect.
 */
const fromSync = <A, E>(f: () => A, expected: (e: unknown) => Option.Option<E>): Effect.Effect<A, E> =>
  Effect.sync(f).pipe(
    Effect.catchDefect((defect) => Option.match(expected(defect), { onNone: () => Effect.die(defect), onSome: Effect.fail })),
  )

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
  schema.annotate({ [POSITIONAL]: true })

// ── numbers ──────────────────────────────────────────────────

/**
 * haus `Float32` as a JS number: a number decodes to the nearest binary32
 * value, rounded directly from its exact decimal (spec §15), and is written
 * in the fewest digits that read back as that binary32 value. `Schema.Number`
 * is a `Float64`.
 */
// @effect-diagnostics-next-line schemaNumber:off -- Float32 includes NaN and the infinities (spec §15)
export const Float32 = Schema.Number.annotate({ [NUMBER]: "Float32" })

/** The id codecs use for the prelude's `Decimal`. */
export const DECIMAL_ID = "prelude#Decimal"

/**
 * haus `Decimal` (the default): any number, as its exact literal text,
 * normalized as the parser does (spec §2): `19.90` → "19.90", `1.5e3` →
 * "1.5e3", `-0` → "-0". Encoding writes the text back, so nothing is lost;
 * text that isn't one number literal is an error. Pass it to a decimal
 * library, or use `Haus.DecimalAsBigDecimal`.
 */
export const Decimal = setId(
  Schema.String.annotate({ [DECIMAL]: true }).check(
    Schema.makeFilter((s: string) => normalizeNumber(s) !== undefined || "a number literal, like \"19.90\""),
  ),
  DECIMAL_ID,
) as Named<Schema.String, typeof DECIMAL_ID>

/** A `Haus.Decimal` read as a BigDecimal: the text → BigDecimal, and back with its scale. */
const asBigDecimal = <S extends Schema.Codec<string, string>>(base: S) =>
  base.pipe(
    Schema.decodeTo(
      Schema.BigDecimal,
      SchemaTransformation.transform({ decode: (text: string) => BigDecimal.fromStringUnsafe(text), encode: decimalText }),
    ),
  )

/**
 * haus `Decimal` as an Effect `BigDecimal`: an explicit, lossy choice (spec
 * §13.4). It keeps the amount and the scale (`19.90` stays `19.90`), but
 * drops exponent notation and the sign of zero: `-0` is written `0`, `15e2`
 * as `1.5e3`, `1.5e-3` as `0.0015`. A different haus value, with another
 * canonical form and hash. For schema files, the codec `Haus.decimalAsBigDecimal`.
 */
export const DecimalAsBigDecimal = asBigDecimal(Decimal)

/** Codec for schema files: their `Decimal`s as BigDecimals, with the losses of `Haus.DecimalAsBigDecimal`. */
export const decimalAsBigDecimal = codec(Decimal, asBigDecimal)

// ── std/time ─────────────────────────────────────────────────

const stdTime = <S extends Schema.Top>(name: StdTimeType, schema: S) => setId(schema, `std/time#${name}`)

/** A std/time type written as `Tag("…")`, kept as its validated string (the std/time profile, spec/std/time.md). */
const timeString = <const Name extends StdTimeType>(name: Name) =>
  stdTime(
    name,
    Schema.String.annotate({ [PRELUDE_TAG]: name }).check(Schema.makeFilter((s: string) => checkStdTime(name, s) ?? true)),
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
/** `Instant("2026-11-07T10:00:00.250+01:00")` as its validated text, exactly as written (offset and fraction included). */
export const Instant = timeString("Instant")
/** `ZonedDateTime("2026-11-07T10:00:00+01:00[Europe/Lisbon]")` as its validated text, exactly as written. */
export const ZonedDateTime = timeString("ZonedDateTime")

/** An Effect DateTime as std/time text; a DateTime that std/time can't write (a year beyond 9999) is an encoding error. */
const writeDateTime = (d: EffectDateTime.DateTime) =>
  Effect.try({
    try: () => dateTimeText(d).text,
    catch: (e) => new SchemaIssue.InvalidValue({ message: e instanceof ConversionError ? e.message : String(e) }),
  })

const asDateTimeUtc = <S extends Schema.Codec<string, string>>(base: S) =>
  base.pipe(
    Schema.decodeTo(
      Schema.DateTimeUtc,
      SchemaTransformation.transformEffect({
        decode: (s: string) =>
          Option.match(EffectDateTime.make(s), {
            onNone: () => Effect.fail(new SchemaIssue.InvalidValue({ message: `${s} is not a DateTime.Utc` })),
            onSome: (d) => Effect.succeed(EffectDateTime.toUtc(d)),
          }),
        encode: writeDateTime,
      }),
    ),
  )

const asDateTimeZoned = <S extends Schema.Codec<string, string>>(base: S) =>
  base.pipe(
    Schema.decodeTo(
      Schema.DateTimeZoned,
      SchemaTransformation.transformEffect({
        decode: (s: string) =>
          Option.match(EffectDateTime.makeZonedFromString(s), {
            onNone: () => Effect.fail(new SchemaIssue.InvalidValue({ message: `${s}: a zone that Intl doesn't know` })),
            onSome: Effect.succeed,
          }),
        encode: writeDateTime,
      }),
    ),
  )

/**
 * std/time `Instant` as an Effect `DateTime.Utc`: an explicit, lossy choice
 * (spec §13.4). It keeps the instant to the millisecond, and drops digits
 * below the millisecond, the offset and the fraction as written:
 * `…10:00:00.250+01:00` is written `…09:00:00.250Z`, `…10:00:00.000Z` is
 * written `…10:00:00Z`. A different haus value, with another canonical form
 * and hash. A DateTime outside the years 0000–9999 can't be written (an
 * encoding error). For schema files, the codec `Haus.instantAsDateTime`.
 */
export const InstantAsDateTime = asDateTimeUtc(Instant)

/**
 * std/time `ZonedDateTime` as an Effect `DateTime.Zoned`: an explicit, lossy
 * choice (spec §13.4). It keeps the instant to the millisecond and the zone,
 * and drops digits below the millisecond, the offset and the fraction as
 * written (the offset is written as the zone has it at that instant). Zone
 * names are looked up with Intl: an unknown zone is an error (std/time
 * accepts any well-formed name), and a name Intl canonicalises is written
 * that way (`Etc/UTC` → `UTC`). A zone that is an offset is written in
 * brackets, `…+01:00[+01:00]`. For schema files, the codec `Haus.zonedDateTimeAsDateTime`.
 */
export const ZonedDateTimeAsDateTime = asDateTimeZoned(ZonedDateTime)

/** Codec for schema files: their `Instant`s as `DateTime.Utc`, with the losses of `Haus.InstantAsDateTime`. */
export const instantAsDateTime = codec(Instant, asDateTimeUtc)

/** Codec for schema files: their `ZonedDateTime`s as `DateTime.Zoned`, with the losses of `Haus.ZonedDateTimeAsDateTime`. */
export const zonedDateTimeAsDateTime = codec(ZonedDateTime, asDateTimeZoned)

// ── decoding ─────────────────────────────────────────────────

const decodeOptions = { onExcessProperty: "ignore", errors: "first" } as const

/** The schema with codecs applied (cached); the schema itself without codecs. */
const target = <S extends Schema.Top>(schema: S, codecs: ReadonlyArray<AnyCodec>): S => {
  if (codecs.length === 0) return schema
  entries(codecs) // two codecs for one type fail here, before anything is built
  return withCodecs(schema, codecs) as S
}

/** A conversion error, with its path written as Effect writes it (`at ["items"][2]`). */
const conversionError = ({ message, path }: { readonly message: string; readonly path: Path }): HausSchemaError =>
  path.length === 0 ? new HausSchemaError({ message })
  : new HausSchemaError({ message: `${message}\n  at ${path.map((k) => `[${JSON.stringify(k)}]`).join("")}`, path: [...path] })

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
    // Conversion work is bounded by the size of the input (see convert.ts).
    fromSync(() => guarded(decodeBudget(value), () => convert(value)), conversionErrorOf).pipe(
      Effect.flatMap((encoded) => decode(encoded, decodeOptions)),
      Effect.mapError((e) => (e instanceof HausSchemaError ? e : schemaError(e))),
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
    const values = yield* fromSync(() => parseAll(text), parseErrorOf)
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
      Effect.mapError(schemaError),
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
    Stream.fromAsyncIterable(parseStream(chunks), (e) => e).pipe(
      // The source's own errors pass through; syntax errors are HausParseErrors; anything else is a bug.
      Stream.catch((e): Stream.Stream<never, HausParseError | E> =>
        e instanceof SourceFailure ? Stream.fail(e.error as E)
        : Option.match(parseErrorOf(e), { onNone: () => Stream.die(e), onSome: Stream.fail })),
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
      Effect.mapError(schemaError),
      Effect.flatMap((encoded) => fromSync(() => guarded(DEFAULT_ENCODE_STEPS, () => toValue(encoded)), conversionErrorOf)),
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

// ── equality and order ───────────────────────────────────────

export { HausKey, key, ValueEquivalence, ValueOrder } from "./equal.js"

// ── schema files ─────────────────────────────────────────────

export { compileSchemaFile, definitionDoc, fromSchemaFile, schemaDeclarations, withCodecs, type CompiledSchemaFile, type DeclarationOptions, type FromSchemaFileOptions } from "./schema-file.js"
