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
  /**
   * Set once this shape has been merged into another one (union-find): the
   * shape that now holds its information. Read shapes through `resolve`.
   */
  link: Shape | undefined
  /** How many values were seen at this position. */
  occurrences = 0
  strings = 0
  bytes = 0
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

/** The shape that currently holds `shape`'s information (after merges). */
export const resolve = (shape: Shape): Shape => {
  let root = shape
  while (root.link) root = root.link
  // Path compression: later lookups take one step.
  for (let s = shape; s.link && s.link !== root; ) {
    const next: Shape = s.link
    s.link = root
    s = next
  }
  return root
}

/**
 * Merge two shapes into one, e.g. the shape of a `Comment` and of the
 * `Comment`s in its replies. Shapes can form cycles, so this is union-find:
 * `b` is linked to `a` before their contents are merged, and a pair whose
 * shapes are already one is skipped. Every shape is merged away at most once
 * and its contents are moved once, so all merges together are linear in the
 * number of shapes (no blowup however the data nests). A work list instead of
 * recursion keeps deep shapes off the call stack.
 */
const union = (x: Shape, y: Shape): Shape => {
  const pending: [Shape, Shape][] = [[x, y]]
  while (pending.length > 0) {
    const [p, q] = pending.pop()!
    const a = resolve(p)
    const b = resolve(q)
    if (a === b) continue
    b.link = a
    a.occurrences += b.occurrences
    a.strings += b.strings
    a.bytes += b.bytes
    a.numbers += b.numbers
    a.decimal ||= b.decimal
    a.arrays += b.arrays
    if (b.element) {
      if (a.element) pending.push([a.element, b.element])
      else a.element = b.element
    }
    if (b.records) {
      if (a.records) mergeRecords(a.records, b.records, pending)
      else a.records = b.records
    }
    for (const [tag, vb] of b.variants) {
      const va = a.variants.get(tag)
      if (!va) {
        a.variants.set(tag, vb)
        continue
      }
      va.count += vb.count
      va.bare ||= vb.bare
      if (vb.record) {
        if (va.record) mergeRecords(va.record, vb.record, pending)
        else va.record = vb.record
      }
      vb.positional.forEach((shape, i) => {
        const existing = va.positional[i]
        if (existing) pending.push([existing, shape])
        else va.positional[i] = shape
      })
    }
  }
  return resolve(x)
}

const mergeRecords = (a: RecordShape, b: RecordShape, pending: [Shape, Shape][]) => {
  a.count += b.count
  for (const [key, eb] of b.fields) {
    const ea = a.fields.get(key)
    if (!ea) {
      a.fields.set(key, eb)
      continue
    }
    ea.count += eb.count
    pending.push([ea.shape, eb.shape])
  }
}

export interface Inference {
  /** The shape shared by all top-level values. */
  readonly root: Shape
  /** How many top-level values there were. */
  readonly documents: number
  /** The shape of the position each value sits at (read it through `resolve`). */
  readonly shapeOf: WeakMap<Value, Shape>
}

/** Tags that nest in themselves without making a type recursive (`Some(Some(1))`). */
const NOT_RECURSIVE = new Set(["None", "Some", "True", "False"])

export function infer(values: readonly Value[]): Inference {
  const shapeOf = new WeakMap<Value, Shape>()
  const root = new Shape()
  // The shapes of the variants and records we are inside, by tag and by key
  // set. A value nested in another one like it (a Comment in a Comment's
  // replies) means the type is recursive: both positions share one shape.
  const openTags = new Map<string, Shape[]>()
  const openRecords = new Map<string, Shape[]>()
  const enclosing = (open: Map<string, Shape[]>, key: string) => open.get(key)?.at(-1)
  const push = (open: Map<string, Shape[]>, key: string, shape: Shape) => {
    let stack = open.get(key)
    if (!stack) open.set(key, (stack = []))
    stack.push(shape)
  }

  const addRecord = (rs: RecordShape, r: HRecord) => {
    rs.count++
    for (const [key, value] of r.fields) {
      let entry = rs.fields.get(key)
      if (!entry) rs.fields.set(key, (entry = { shape: new Shape(), count: 0 }))
      entry.count++
      add(entry.shape, value)
    }
  }

  const add = (position: Shape, v: Value) => {
    let shape = resolve(position)
    const signature = v.kind === "record" && v.fields.size > 0 ? [...v.fields.keys()].sort().join(",") : undefined
    const outer =
      v.kind === "variant" && !NOT_RECURSIVE.has(v.tag) ? enclosing(openTags, v.tag)
      : signature !== undefined ? enclosing(openRecords, signature)
      : undefined
    if (outer) shape = union(outer, shape)
    shape.occurrences++
    shapeOf.set(v, shape)
    switch (v.kind) {
      case "string":
        shape.strings++
        return
      case "bytes":
        shape.bytes++
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
        if (signature !== undefined) push(openRecords, signature, shape)
        addRecord((shape.records ??= new RecordShape()), v)
        if (signature !== undefined) openRecords.get(signature)!.pop()
        return
      case "variant": {
        let vs = shape.variants.get(v.tag)
        if (!vs) shape.variants.set(v.tag, (vs = new VariantShape()))
        vs.count++
        push(openTags, v.tag, shape)
        const [first] = v.args
        if (v.args.length === 0) vs.bare = true
        // `Some({ … })` wraps a value (a record here), it has no fields of its own.
        else if (v.args.length === 1 && first?.kind === "record" && v.tag !== "Some") {
          shapeOf.set(first, shape)
          addRecord((vs.record ??= new RecordShape()), first)
        } else {
          const variantShape = vs
          v.args.forEach((arg, i) => add((variantShape.positional[i] ??= new Shape()), arg))
        }
        openTags.get(v.tag)!.pop()
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
  /**
   * The shape of the whole file (`Inference.root`) when printing part of it,
   * so recursive types get the same names everywhere (`Comment`, not a name
   * derived from the part being printed).
   */
  readonly context?: Shape
}

/**
 * Print a shape as a schema type, e.g. `{ name: String, type: < Engineer | Designer > }`.
 * Fields missing from some records print as optional fields, `key?: T`.
 * A position holding different kinds (string here, number there) prints as
 * `String | Int` — not expressible in a schema; the data should use a variant.
 */
export function printShape(shape: Shape, options: PrintOptions = {}): string {
  const { body, definitions } = printWithDefinitions(shape, options)
  return [body, ...definitions.map(([name, text]) => `type ${name} = ${text}`)].join("\n\n")
}

/** The type of `shape`, plus one definition per recursive type it uses (`type Comment = …`). */
function printWithDefinitions(shape: Shape, options: PrintOptions) {
  const width = options.width ?? 80
  const s = resolve(shape)
  const names = recursiveNames(resolve(options.context ?? s))
  const printer = new ShapePrinter(width, names)
  const body = printer.shape(s, "")
  // Definitions of the recursive types `s` uses, in the order they are reached.
  const used = [...reachable(s)].filter((x) => names.has(x))
  const definitions = used.map((def) => [names.get(def)!, printer.definition(def, "")] as const)
  return { body, definitions }
}


/** The shapes nested in a shape (fields, elements, payloads), resolved. */
const childrenOf = (s: Shape): [Shape, string | undefined][] => {
  const out: [Shape, string | undefined][] = []
  const fields = (rs: RecordShape | undefined) => {
    if (rs) for (const [k, e] of rs.fields) out.push([resolve(e.shape), k])
  }
  if (s.element) out.push([resolve(s.element), undefined])
  fields(s.records)
  for (const v of s.variants.values()) {
    fields(v.record)
    for (const p of v.positional) out.push([resolve(p), undefined])
  }
  return out
}

/** Every shape reachable from `root` (including itself), in depth-first order. */
const reachable = (root: Shape): Set<Shape> => {
  const seen = new Set<Shape>()
  const stack = [root]
  while (stack.length > 0) {
    const s = stack.pop()!
    if (seen.has(s)) continue
    seen.add(s)
    for (const [child] of childrenOf(s).reverse()) if (!seen.has(child)) stack.push(child)
  }
  return seen
}

/**
 * Find the shapes that contain themselves and name them: after their tag
 * (`Comment`), or `Node` when they have several tags or none.
 * Depth-first with an explicit stack; each shape is visited once.
 */
export function recursiveNames(root: Shape): Map<Shape, string> {
  const state = new Map<Shape, "open" | "done">()
  // The targets of back edges: every cycle contains one, so printing these
  // by name breaks every cycle.
  const recursive = new Set<Shape>()
  const children = (s: Shape) => childrenOf(s).reverse()
  const stack: { shape: Shape; next: [Shape, string | undefined][] }[] = [{ shape: root, next: children(root) }]
  state.set(root, "open")
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!
    const item = top.next.pop()
    if (!item) {
      state.set(top.shape, "done")
      stack.pop()
      continue
    }
    const [child] = item
    const seen = state.get(child)
    if (seen === "open") {
      recursive.add(child)
    } else if (seen === undefined) {
      state.set(child, "open")
      stack.push({ shape: child, next: children(child) })
    }
  }
  const names = new Map<Shape, string>()
  const used = reserved()
  for (const s of recursive) {
    const tags = [...s.variants.keys()]
    const onlyVariants = !s.strings && !s.bytes && !s.numbers && !s.arrays && !s.records
    // A single tag names itself (`Comment`); anything else is a generic `Node`
    // (a field name like `root` or `children` says where it is, not what it is).
    let base = onlyVariants && tags.length === 1 ? tags[0]! : "Node"
    if (used.has(base)) base += "Type"
    let name = base
    for (let i = 2; used.has(name); i++) name = `${base}${i}`
    used.add(name)
    names.set(s, name)
  }
  return names
}

const PRELUDE_BOOL = new Set(["True", "False"])
const PRELUDE_MAYBE = new Set(["None", "Some"])
/** Names a recursive type must not take: built-in types and the names `inferSchema` uses. */
const reserved = () => new Set(["String", "Int", "Decimal", "Array", "Maybe", "Bool", "Stream", "Root", "Item", ...PRELUDE_STRING_TAGS])

/** Prelude scalars: a tag wrapping one string, printed by name (`Date`, not `< Date String >`). */
const PRELUDE_STRING_TAGS = new Set(["Date", "Time", "DateTime", "Instant", "ZonedDateTime", "Duration"])

/** A shape that only ever held strings. */
const onlyStrings = (shape: Shape | undefined) => {
  const s = shape && resolve(shape)
  return s !== undefined && s.strings === s.occurrences && s.occurrences > 0
}

/**
 * Prints shapes, breaking records and variants over several lines when they
 * don't fit. Each shape's one-line form is computed once and given up as soon
 * as it gets wider than the line, and the multi-line form is built once per
 * shape, so printing is linear in the size of the shape. (Trying the one-line
 * form at every level and re-rendering on failure would be exponential in the
 * nesting depth: a small hostile file could hang the editor.)
 *
 * `ind` is the indentation for the multi-line form; `null` asks for the
 * one-line form, or `null` back if there is none within the width.
 */
class ShapePrinter {
  private readonly flatCache = new Map<object, string | null>()

  constructor(
    private readonly width: number,
    /** Recursive shapes, printed by name; their definitions are printed separately. */
    private readonly names: ReadonlyMap<Shape, string> = new Map(),
  ) {}

  /** The body of a recursive type's definition (where `shape` itself would print its name). */
  definition(shape: Shape, ind: string): string {
    const flat = this.parts(shape, null)
    if (flat !== null && ind.length + flat.length <= this.width) return flat
    return this.parts(shape, ind)!
  }

  private flat(key: object, build: () => string | null): string | null {
    let out = this.flatCache.get(key)
    if (out === undefined) {
      out = build()
      if (out !== null && out.length > this.width) out = null
      this.flatCache.set(key, out)
    }
    return out
  }

  shape(s: Shape, ind: string): string
  shape(s: Shape, ind: string | null): string | null
  shape(shape: Shape, ind: string | null): string | null {
    const s = resolve(shape)
    const name = this.names.get(s)
    if (name !== undefined) return name
    if (ind === null) return this.flat(s, () => this.parts(s, null))
    return this.parts(s, ind)!
  }

  private parts(s: Shape, ind: string | null): string | null {
    const parts: string[] = []
    if (s.strings) parts.push("String")
    if (s.bytes) parts.push("Bytes")
    if (s.numbers) parts.push(s.decimal ? "Decimal" : "Int")
    if (s.arrays) {
      const element = s.element ? this.shape(s.element, ind) : "_"
      if (element === null) return null
      parts.push(`Array ${paren(element)}`)
    }
    if (s.records) {
      const r = this.record(s.records, ind, 0)
      if (r === null) return null
      parts.push(r)
    }
    if (s.variants.size) {
      const v = this.variants(s, ind)
      if (v === null) return null
      parts.push(v)
    }
    return parts.length === 0 ? "_" : parts.join(" | ")
  }

  /** `used`: columns already taken on the first line (e.g. by a tag before the `{`). */
  private record(rs: RecordShape, ind: string | null, used: number): string | null {
    if (rs.fields.size === 0) return "{}"
    const field = (key: string, entry: { shape: Shape; count: number }, at: string | null) => {
      const type = this.shape(entry.shape, at)
      if (type === null) return null
      // Missing from some records: an optional field (`key?: T`), never a Maybe.
      const optional = entry.count < rs.count ? "?" : ""
      return `${/^[a-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key)}${optional}: ${type}`
    }
    const flat = this.flat(rs, () => {
      const fields: string[] = []
      let length = 0
      for (const [k, e] of rs.fields) {
        const f = field(k, e, null)
        if (f === null || (length += f.length + 2) > this.width) return null
        fields.push(f)
      }
      return `{ ${fields.join(", ")} }`
    })
    if (ind === null || (flat !== null && ind.length + used + flat.length <= this.width)) return flat
    const inner = ind + "  "
    return `{\n${[...rs.fields].map(([k, e]) => `${inner}${field(k, e, inner)},\n`).join("")}${ind}}`
  }

  private variants(s: Shape, ind: string | null): string | null {
    const variants = s.variants
    const tags = [...variants.keys()]
    const allBare = [...variants.values()].every((v) => v.bare && !v.record && v.positional.length === 0)
    if (allBare && tags.every((t) => PRELUDE_BOOL.has(t))) return "Bool"
    if (tags.every((t) => PRELUDE_MAYBE.has(t))) {
      const some = variants.get("Some")?.positional[0]
      if (!some) return "Maybe _"
      const inner = this.shape(some, ind)
      return inner === null ? null : `Maybe ${paren(inner)}`
    }
    if (tags.length === 1) {
      const [tag] = tags as [string]
      const v = variants.get(tag)!
      const positionalOnly = !v.bare && !v.record
      if (positionalOnly && PRELUDE_STRING_TAGS.has(tag) && v.positional.length === 1 && onlyStrings(v.positional[0])) return tag
    }
    const renderCase = (tag: string, v: VariantShape, at: string | null): string | null => {
      const payloads: string[] = []
      if (v.record) {
        // The record follows the tag on the same line: leave room for "| Tag ".
        const r = this.record(v.record, at, tag.length + 3)
        if (r === null) return null
        payloads.push(`${tag} ${r}`)
      }
      if (v.positional.length) {
        const args: string[] = []
        for (const p of v.positional) {
          const a = this.shape(p, at)
          if (a === null) return null
          args.push(paren(a))
        }
        payloads.push(`${tag} ${args.join(" ")}`)
      }
      if (v.bare || payloads.length === 0) payloads.unshift(tag)
      return payloads.join(" | ")
    }
    const flat = this.flat(variants, () => {
      const cases: string[] = []
      let length = 0
      for (const [t, v] of variants) {
        const c = renderCase(t, v, null)
        if (c === null || (length += c.length + 3) > this.width) return null
        cases.push(c)
      }
      return `< ${cases.join(" | ")} >`
    })
    if (ind === null || (flat !== null && ind.length + flat.length <= this.width)) return flat
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
}

/** Parenthesize a type that has spaces, unless it's already bracketed. */
const paren = (t: string) => {
  const first = t[0]
  const last = t[t.length - 1]
  if ((first === "<" && last === ">") || (first === "{" && last === "}")) return t
  return /^\w+$/.test(t) ? t : `(${t})`
}

/** A `.schema.haus` document describing the given values. */
export function inferSchema(values: readonly Value[], options: PrintOptions = {}): string {
  const { root, documents } = infer(values)
  const { body, definitions } = printWithDefinitions(root, options)
  const header = `// Inferred from ${documents} value${documents === 1 ? "" : "s"}. Review before use:\n// optional fields, Int vs Decimal and open vs closed variants are guesses.\n\n`
  const type = (name: string, text: string) => `type ${name} =\n  ${text.replaceAll("\n", "\n  ")}\n`
  const defs = definitions.map(([name, text]) => "\n" + type(name, text)).join("")
  return documents > 1
    ? `${header}${type("Item", body)}${defs}\ntype Root = Stream Item\n`
    : `${header}${type("Root", body)}${defs}`
}
