/**
 * What to show when hovering a place in a data file: the value or record
 * key there, the type the schema expects (when the file has one) and the
 * type inferred from the file. Editors (the VS Code extension) and the
 * website use it.
 *
 *   const ctx = hoverContext(text, { file, type: "Root" })   // schema optional
 *   const info = hoverAt(ctx, offset)
 *   hoverMarkdown(info)   // for editors
 *   hoverText(info)       // plain text, for tooltips
 */
import { checkData, describeType } from "./check.js"
import { DEFAULT_LIMITS, Parser } from "./parser.js"
import { infer, printShape, type Inference } from "./infer.js"
import type { Definition, SchemaFile, Type } from "./schema-file.js"
import type { Value } from "./value.js"

export interface HoverContext {
  readonly values: readonly Value[]
  readonly inference: Inference
  /** The schema's type at each value, when the file has a schema. */
  readonly schemaTypes?: ReadonlyMap<Value, Type>
}

/** Parse a data file (with locations) for hovering; with a schema, also find the schema's type at every value. */
export function hoverContext(text: string, schema?: { readonly file: SchemaFile; readonly type: string }): HoverContext {
  const values = new Parser(text, undefined, DEFAULT_LIMITS, true).parseSequence()
  return contextOf(values, schema)
}

/** Like `hoverContext`, for values already parsed with locations. */
export function contextOf(values: readonly Value[], schema?: { readonly file: SchemaFile; readonly type: string }): HoverContext {
  const inference = infer(values)
  if (!schema) return { values, inference }
  const schemaTypes = new Map<Value, Type>()
  checkData(schema.file, schema.type, values, { onValue: (v, t) => schemaTypes.set(v, t) })
  return { values, inference, schemaTypes }
}

export interface HoverInfo {
  /** The hovered span: the record key, the variant's tag, or the whole value. UTF-16 offsets, `end` exclusive. */
  readonly start: number
  readonly end: number
  /** Set when a record key is hovered; `value` is then the field's value. */
  readonly key?: string
  readonly value: Value
  /** The type the schema expects here, and its definition when it is a named type. */
  readonly schema?: { readonly type: string; readonly definition?: Definition }
  /** The type inferred from every value at this position in the file. */
  readonly inferred?: { readonly type: string; readonly occurrences: number }
  /** A note on the value: the prelude or std/time type of a tag, or a number a float can't hold exactly. */
  readonly note?: string
}

/** The innermost value (or record key) at `offset`. */
function find(v: Value, offset: number): { value: Value; key?: string; span: readonly [number, number] } | undefined {
  if (v.start === undefined || v.end === undefined || offset < v.start || offset >= v.end) return undefined
  const inner = (items: Iterable<Value>) => {
    for (const x of items) {
      const hit = find(x, offset)
      if (hit) return hit
    }
    return undefined
  }
  switch (v.kind) {
    case "record":
      for (const [key, span] of v.keySpans ?? []) {
        if (offset >= span[0] && offset < span[1]) return { value: v.fields.get(key)!, key, span }
      }
      return inner(v.fields.values()) ?? { value: v, span: [v.start, v.end] }
    case "array":
      return inner(v.items) ?? { value: v, span: [v.start, v.end] }
    case "variant": {
      const tagEnd = v.start + v.tag.length
      if (offset < tagEnd) return { value: v, span: [v.start, tagEnd] }
      return inner(v.args) ?? { value: v, span: [v.start, v.end] }
    }
    default:
      return { value: v, span: [v.start, v.end] }
  }
}

/** Prelude and std/time tags. */
export const TAG_NOTES: Readonly<Record<string, string>> = {
  True: "Bool (prelude)",
  False: "Bool (prelude)",
  None: "Maybe a (prelude): no value",
  Some: "Maybe a (prelude): a value",
  Ok: "Result e a (prelude): success",
  Err: "Result e a (prelude): failure",
  Date: "Date (std/time): RFC 3339 full-date",
  Time: "Time (std/time): RFC 3339 partial-time",
  DateTime: "DateTime (std/time): date and time, no zone",
  Instant: "Instant (std/time): an exact point in time (RFC 3339)",
  ZonedDateTime: "ZonedDateTime (std/time): instant + IANA zone (RFC 9557)",
  Duration: "Duration (std/time): ISO 8601 duration",
  YearMonth: "YearMonth (std/time): 2026-11",
  TimeZone: "TimeZone (std/time): IANA zone, Europe/Lisbon",
  NaN: "Float64 (prelude): not a number",
  Infinity: "Float64 (prelude): +∞",
  NegInfinity: "Float64 (prelude): −∞",
}

function note(v: Value): string | undefined {
  if (v.kind === "variant") return TAG_NOTES[v.tag]
  if (v.kind === "number") {
    const text = v.text.replaceAll("_", "")
    if (!/^-?\d+(\.\d+)?$/.test(text)) return undefined // hex, binary and exponents: no note
    const asFloat = Number(text)
    // Trailing zeros don't count: 30.30 is the float 30.3 exactly.
    const canonical = (t: string) => (t.includes(".") ? t.replace(/\.?0+$/, "") : t)
    const exact = text.includes(".") ? canonical(text) === canonical(String(asFloat)) : Number.isSafeInteger(asFloat)
    return exact ? undefined : `As a Float64 this would be ${asFloat} (not exact; use Decimal or BigInt).`
  }
  return undefined
}

/** What to show for `offset`, if there is a value there. */
export function hoverAt(ctx: HoverContext, offset: number, options: { readonly width?: number } = {}): HoverInfo | undefined {
  for (const top of ctx.values) {
    const hit = find(top, offset)
    if (!hit) continue
    const shape = ctx.inference.shapeOf.get(hit.value)
    const type = ctx.schemaTypes?.get(hit.value)
    const n = note(hit.value)
    return {
      start: hit.span[0],
      end: hit.span[1],
      ...(hit.key === undefined ? {} : { key: hit.key }),
      value: hit.value,
      ...(type ? { schema: { type: describeType(type), ...(type.kind === "ref" ? { definition: type.instance.definition } : {}) } } : {}),
      ...(shape ? { inferred: { type: printShape(shape, { width: options.width ?? 80, context: ctx.inference.root }), occurrences: shape.occurrences } } : {}),
      ...(n ? { note: n } : {}),
    }
  }
  return undefined
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** What the value itself is: `record, 3 fields: a, b, c`. */
export function describeValue(v: Value): string {
  switch (v.kind) {
    case "number": return `number ${v.text}, an exact decimal`
    case "string": return `string, ${plural([...v.value].length, "character")}`
    case "bytes": return `bytes, ${plural(v.bytes.length, "byte")}`
    case "array": return `array, ${plural(v.items.length, "item")}`
    case "record": return `record, ${plural(v.fields.size, "field")}: ${[...v.fields.keys()].join(", ")}`
    case "variant": {
      const [first] = v.args
      const payload = v.args.length === 0 ? "no payload"
        : v.args.length === 1 && first?.kind === "record" ? `record payload (${plural(first.fields.size, "field")})`
        : plural(v.args.length, "positional argument")
      return `variant ${v.tag}, ${payload}`
    }
  }
}

/** Markdown for an editor hover: the types first (long hovers scroll), then the value. */
export function hoverMarkdown(info: HoverInfo): string {
  const block = (s: string) => "```haus-schema\n" + s + "\n```\n\n"
  const parts: string[] = []
  if (info.schema) {
    parts.push(info.schema.definition ? block(info.schema.definition.source) : block(info.schema.type))
    parts.push("_From the schema._\n\n---\n\n")
  } else if (info.inferred) {
    const seen = info.inferred.occurrences === 1 ? "1 value" : `${info.inferred.occurrences} values`
    parts.push(block(info.inferred.type), `_Inferred from this file (${seen} at this position)._\n\n---\n\n`)
  }
  const head = info.key === undefined ? "" : `**field** \`${info.key}\`\n\n`
  const [kind, ...rest] = describeValue(info.value).split(" ")
  parts.push(`${head}**${kind}** ${rest.join(" ")}`)
  if (info.note) parts.push(`\n\n${info.note}`)
  return parts.join("")
}

/** Plain text for a tooltip: `status: Status` and a line of detail. */
export function hoverText(info: HoverInfo): string {
  const type = info.schema?.type ?? info.inferred?.type ?? describeValue(info.value)
  const lines = [info.key === undefined ? type : `${info.key}: ${type}`]
  const doc = info.schema?.definition?.doc.trim()
  if (doc) lines.push(doc.split("\n")[0]!)
  // "Instant (std/time): an exact point…" → "std/time: an exact point…": the type is on the first line already.
  else if (info.note) lines.push(info.note.replace(/^[^(]+\((prelude|std\/time)\)/, "$1"))
  return lines.join("\n")
}
