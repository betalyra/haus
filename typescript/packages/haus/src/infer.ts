/**
 * Shape inference: derive a schema from example data.
 *
 * Every position in the data (root, a record field, an array element, a
 * variant's payload field) gets one `Shape` that accumulates every value seen
 * there. `Person { type: Engineer }` and `Person { type: Designer }` both feed
 * the shape of `Person.type`, which then prints as `< Engineer | Designer >`.
 */
import type { HRecord, Value } from "./value.js"

export class Shape {
  /** How many values were seen at this position. */
  occurrences = 0
  strings = 0
  numbers = 0
  /** Some number had a fraction or exponent. */
  decimal = false
  arrays = 0
  element: Shape | undefined
  records: RecordShape | undefined
  readonly variants = new Map<string, VariantShape>()
}

export class RecordShape {
  count = 0
  readonly fields = new Map<string, { shape: Shape; count: number }>()
}

export class VariantShape {
  count = 0
  /** Record payload (`Tag { … }`), if any occurrence had one. */
  record: RecordShape | undefined
  /** Positional payload (`Tag(a, b)`), one shape per argument. */
  readonly positional: Shape[] = []
  /** Some occurrence had no payload. */
  bare = false
}

export interface Inference {
  /** The shape shared by all top-level values. */
  readonly root: Shape
  /** How many top-level values there were. */
  readonly documents: number
  /** The shape of the position each value sits at. */
  readonly shapeOf: WeakMap<Value, Shape>
}

export function infer(values: readonly Value[]): Inference {
  const shapeOf = new WeakMap<Value, Shape>()
  const root = new Shape()

  const addRecord = (rs: RecordShape, r: HRecord) => {
    rs.count++
    for (const [key, value] of r.fields) {
      let entry = rs.fields.get(key)
      if (!entry) rs.fields.set(key, (entry = { shape: new Shape(), count: 0 }))
      entry.count++
      add(entry.shape, value)
    }
  }

  const add = (shape: Shape, v: Value) => {
    shape.occurrences++
    shapeOf.set(v, shape)
    switch (v.kind) {
      case "string":
        shape.strings++
        return
      case "number":
        shape.numbers++
        if (!/^-?\d+$/.test(v.text)) shape.decimal = true
        return
      case "array":
        shape.arrays++
        shape.element ??= new Shape()
        for (const item of v.items) add(shape.element, item)
        return
      case "record":
        addRecord((shape.records ??= new RecordShape()), v)
        return
      case "variant": {
        let vs = shape.variants.get(v.tag)
        if (!vs) shape.variants.set(v.tag, (vs = new VariantShape()))
        vs.count++
        const [first] = v.args
        if (v.args.length === 0) vs.bare = true
        else if (v.args.length === 1 && first?.kind === "record") {
          shapeOf.set(first, shape)
          addRecord((vs.record ??= new RecordShape()), first)
        } else {
          v.args.forEach((arg, i) => add((vs.positional[i] ??= new Shape()), arg))
        }
      }
    }
  }

  for (const v of values) add(root, v)
  return { root, documents: values.length, shapeOf }
}

// ── printing in .schema.haus syntax ──────────────────────────

export interface PrintOptions {
  /** Preferred maximum line width before breaking records and variants. */
  readonly width?: number
}

/**
 * Print a shape as a schema type, e.g. `{ name: String, type: < Engineer | Designer > }`.
 * Fields missing from some records print as `Maybe T` (absent decodes as None).
 * A position holding different kinds (string here, number there) prints as
 * `String | Int` — not expressible in a schema; the data should use a variant.
 */
export function printShape(shape: Shape, options: PrintOptions = {}): string {
  return render(shape, "", options.width ?? 80)
}

const PRELUDE_BOOL = new Set(["True", "False"])
const PRELUDE_MAYBE = new Set(["None", "Some"])
/** Prelude scalars: a tag wrapping one string, printed by name (`Date`, not `< Date String >`). */
const PRELUDE_STRING_TAGS = new Set(["Date", "Time", "DateTime", "Instant", "ZonedDateTime", "Duration", "Bytes", "Uuid"])

/** A shape that only ever held strings. */
const onlyStrings = (s: Shape | undefined) =>
  s !== undefined && s.strings === s.occurrences && s.occurrences > 0

/** A shape that only ever held numbers. */
const onlyNumbers = (s: Shape | undefined) => s !== undefined && s.numbers === s.occurrences && s.occurrences > 0

function render(shape: Shape, ind: string, width: number): string {
  const parts: string[] = []
  if (shape.strings) parts.push("String")
  if (shape.numbers) parts.push(shape.decimal ? "Decimal" : "Int")
  if (shape.arrays) parts.push(`Array ${paren(shape.element ? render(shape.element, ind, width) : "_")}`)
  if (shape.records) parts.push(renderRecord(shape.records, ind, width))
  if (shape.variants.size) parts.push(renderVariants(shape.variants, ind, width))
  if (parts.length === 0) return "_"
  return parts.join(" | ")
}

function renderRecord(rs: RecordShape, ind: string, width: number): string {
  if (rs.fields.size === 0) return "{}"
  const inner = ind + "  "
  const field = (key: string, entry: { shape: Shape; count: number }, at: string) => {
    let type = render(entry.shape, at, width)
    if (entry.count < rs.count && !type.startsWith("Maybe ")) type = `Maybe ${paren(type)}`
    return `${/^[a-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key)}: ${type}`
  }
  const flat = `{ ${[...rs.fields].map(([k, e]) => field(k, e, ind)).join(", ")} }`
  if (!flat.includes("\n") && ind.length + flat.length <= width) return flat
  return `{\n${[...rs.fields].map(([k, e]) => `${inner}${field(k, e, inner)},\n`).join("")}${ind}}`
}

function renderVariants(variants: Map<string, VariantShape>, ind: string, width: number): string {
  const tags = [...variants.keys()]
  const allBare = [...variants.values()].every((v) => v.bare && !v.record && v.positional.length === 0)
  if (allBare && tags.every((t) => PRELUDE_BOOL.has(t))) return "Bool"
  if (tags.every((t) => PRELUDE_MAYBE.has(t))) {
    const some = variants.get("Some")?.positional[0]
    return `Maybe ${some ? paren(render(some, ind, width)) : "_"}`
  }
  if (tags.length === 1) {
    const [tag] = tags as [string]
    const v = variants.get(tag)!
    const positionalOnly = !v.bare && !v.record
    if (positionalOnly && PRELUDE_STRING_TAGS.has(tag) && v.positional.length === 1 && onlyStrings(v.positional[0])) return tag
    if (positionalOnly && tag === "Money" && v.positional.length === 2 && onlyNumbers(v.positional[0])) return "Money"
  }
  const renderCase = (tag: string, v: VariantShape, at: string) => {
    const payloads: string[] = []
    // The record follows the tag on the same line, so leave room for "< Tag ".
    if (v.record) payloads.push(`${tag} ${renderRecord(v.record, at, width - tag.length - 3)}`)
    if (v.positional.length) payloads.push(`${tag} ${v.positional.map((s) => paren(render(s, at, width))).join(" ")}`)
    if (v.bare || payloads.length === 0) payloads.unshift(tag)
    return payloads.join(" | ")
  }
  const flat = `< ${[...variants].map(([t, v]) => renderCase(t, v, ind)).join(" | ")} >`
  if (!flat.includes("\n") && ind.length + flat.length <= width) return flat
  // One case per line:
  //   <
  //     | Engineer {
  //         level: Senior,
  //       }
  //     | Designer { tools: Array String }
  //   >
  const at = ind + "    "
  return `<\n${[...variants].map(([t, v]) => `${ind}  | ${renderCase(t, v, at)}`).join("\n")}\n${ind}>`
}

/** Parenthesize a type that has spaces, unless it's already bracketed. */
const paren = (t: string) => (/^[\w]+$|^[<{].*[>}]$/s.test(t) ? t : `(${t})`)

/** A `.schema.haus` document describing the given values. */
export function inferSchema(values: readonly Value[], options: PrintOptions = {}): string {
  const { root, documents } = infer(values)
  const body = printShape(root, options)
  const header = `// Inferred from ${documents} value${documents === 1 ? "" : "s"}. Review before use:\n// optional fields, Int vs Decimal and open vs closed variants are guesses.\n\n`
  return documents > 1
    ? `${header}type Item =\n  ${body.replaceAll("\n", "\n  ")}\n\ntype Root = Stream Item\n`
    : `${header}type Root =\n  ${body.replaceAll("\n", "\n  ")}\n`
}
