/**
 * The "plain" TypeScript view of a .haus file whose type is inferred from its
 * data: one function prints the TypeScript type, the other converts the
 * values. Both follow the same rules, so the runtime value always has the
 * type the content mapper reported.
 *
 *   String            → string            Bytes          → Uint8Array
 *   whole numbers     → number            decimals       → string (exact: "19.90")
 *   True / False      → boolean           None / Some(x) → T | null
 *   bare tags only    → "A" | "B"         Date("…") etc. → string
 *   other variants    → { _tag: "Circle"; radius: number } | { _tag: "Point"; values: [number, number] }
 *   fields missing from some records → key?: T
 *   types nested in themselves       → named type aliases (type Comment = …)
 */
import { infer, parseAll, printShape, recursiveNames, resolve, type RecordShape, type Shape, type Value, type VariantShape } from "@betalyra/haus-fmt"

const TIME_TAGS = new Set(["Date", "Time", "DateTime", "Instant", "ZonedDateTime", "Duration", "YearMonth", "TimeZone"])
const BOOL = new Set(["True", "False"])
const MAYBE = new Set(["None", "Some"])

type VariantMode =
  | { readonly kind: "bool" }
  | { readonly kind: "maybe"; readonly some: Shape | undefined }
  | { readonly kind: "string-tag" }
  | { readonly kind: "enum" }
  | { readonly kind: "tagged" }

const isBare = (v: VariantShape) => v.bare && !v.record && v.positional.length === 0
const onlyKind = (s: Shape | undefined, kind: "strings" | "numbers") => {
  const r = s && resolve(s)
  return r !== undefined && r[kind] === r.occurrences && r.occurrences > 0
}

/** How the variants seen at one position are represented in TypeScript. */
function variantMode(shape: Shape): VariantMode {
  const tags = [...shape.variants.keys()]
  const cases = [...shape.variants.values()]
  if (tags.every((t) => BOOL.has(t)) && cases.every(isBare)) return { kind: "bool" }
  if (tags.every((t) => MAYBE.has(t))) return { kind: "maybe", some: shape.variants.get("Some")?.positional[0] }
  if (tags.length === 1) {
    const [tag] = tags as [string]
    const v = shape.variants.get(tag)!
    const positionalOnly = !v.bare && !v.record
    if (positionalOnly && TIME_TAGS.has(tag) && v.positional.length === 1 && onlyKind(v.positional[0], "strings")) return { kind: "string-tag" }
  }
  if (cases.every(isBare)) return { kind: "enum" }
  return { kind: "tagged" }
}

// ── types ────────────────────────────────────────────────────

const KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const prop = (k: string) => (KEY.test(k) ? k : JSON.stringify(k))

class TypePrinter {
  private readonly names: ReadonlyMap<Shape, string>

  constructor(names: ReadonlyMap<Shape, string>) {
    this.names = names
  }

  type(shape: Shape, top = false): string {
    const s = resolve(shape)
    const name = this.names.get(s)
    if (name !== undefined && !top) return name
    const parts: string[] = []
    if (s.strings) parts.push("string")
    if (s.bytes) parts.push("Uint8Array")
    if (s.numbers) parts.push(s.decimal ? "string" : "number")
    if (s.arrays) parts.push(`ReadonlyArray<${s.element ? this.type(s.element) : "never"}>`)
    if (s.records) parts.push(this.record(s.records))
    if (s.variants.size) parts.push(this.variants(s))
    return parts.length === 0 ? "unknown" : [...new Set(parts)].join(" | ")
  }

  private fields(rs: RecordShape): string[] {
    return [...rs.fields].map(([k, e]) => `readonly ${prop(k)}${e.count < rs.count ? "?" : ""}: ${this.type(e.shape)}`)
  }

  private record(rs: RecordShape): string {
    const fields = this.fields(rs)
    return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`
  }

  private variants(s: Shape): string {
    const mode = variantMode(s)
    switch (mode.kind) {
      case "bool": return "boolean"
      case "maybe": return `${mode.some ? this.type(mode.some) : "never"} | null`
      case "string-tag": return "string"
      case "enum": return [...s.variants.keys()].map((t) => JSON.stringify(t)).join(" | ")
      case "tagged": {
        const cases: string[] = []
        for (const [tag, v] of s.variants) {
          const t = `readonly _tag: ${JSON.stringify(tag)}`
          if (v.bare) cases.push(`{ ${t} }`)
          if (v.record) cases.push(`{ ${[t, ...this.fields(v.record)].join("; ")} }`)
          if (v.positional.length) cases.push(`{ ${t}; readonly values: readonly [${v.positional.map((p) => this.type(p)).join(", ")}] }`)
        }
        return cases.join(" | ")
      }
    }
  }
}

/** A TypeScript module declaring the file's default export. */
export function declarations(text: string, fileName = "value.haus"): string {
  const values = parseAll(text)
  const { root } = infer(values)
  const names = recursiveNames(resolve(root))
  const printer = new TypePrinter(names)
  const doc = (body: string) => `/**\n * ${body.replaceAll("*/", "*\\/").split("\n").join("\n * ")}\n */\n`
  const schema = (s: Shape) => "```haus-schema\n" + printShape(s, { context: root }) + "\n```"
  const aliases = [...names]
    .map(([shape, name]) => `${doc(`Inferred from the data:\n\n${schema(shape)}`)}type ${name} = ${printer.type(shape, true)};\n`)
    .join("")
  const item = printer.type(root)
  const stream = values.length !== 1
  const type = stream ? `ReadonlyArray<${values.length === 0 ? "never" : item}>` : item
  const what = stream ? `${values.length} values, each` : "1 value"
  const name = identifier(fileName)
  return `${aliases}${doc(`${basename(fileName)}: ${what} of this type, inferred from the data:\n\n${schema(root)}`)}` +
    `declare const ${name}: ${type};\nexport default ${name};\n`
}

const basename = (path: string) => path.split(/[\\/]/).pop() ?? path

/** `user-update.haus` → `userUpdate`, a name for hovers. */
function identifier(fileName: string): string {
  const stem = basename(fileName).replace(/\.haus$/, "")
  const camel = stem.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))
  const name = /^[A-Za-z_$]/.test(camel) ? camel : `_${camel}`
  return RESERVED.has(name) || name === "" ? `${name}Value` : name
}

const RESERVED = new Set(["default", "class", "function", "var", "let", "const", "new", "delete", "enum", "export", "import", "in", "this", "void", "with", "yield", "await"])

// ── values ───────────────────────────────────────────────────

function plain(v: Value, shape: Shape): unknown {
  const s = resolve(shape)
  switch (v.kind) {
    case "string": return v.value
    case "bytes": return v.bytes
    case "number": {
      if (s.decimal) return v.text
      const n = Number(v.text)
      if (!Number.isSafeInteger(n)) throw new Error(`integer ${v.text} does not fit a JS number exactly`)
      return n
    }
    case "array": return v.items.map((x) => plain(x, s.element!))
    case "record": return fields(v, s.records!)
    case "variant": {
      const mode = variantMode(s)
      const vs = s.variants.get(v.tag)!
      switch (mode.kind) {
        case "bool": return v.tag === "True"
        case "maybe": return v.tag === "None" ? null : plain(v.args[0]!, vs.positional[0]!)
        case "string-tag": return (v.args[0] as Extract<Value, { kind: "string" }>).value
        case "enum": return v.tag
        case "tagged": {
          const [first] = v.args
          if (v.args.length === 0) return { _tag: v.tag }
          if (v.args.length === 1 && first!.kind === "record" && v.tag !== "Some") return { _tag: v.tag, ...fields(first!, vs.record!) }
          return { _tag: v.tag, values: v.args.map((a, i) => plain(a, vs.positional[i]!)) }
        }
      }
    }
  }
}

function fields(r: Extract<Value, { kind: "record" }>, rs: RecordShape): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, x] of r.fields) {
    // defineProperty: a "__proto__" key is data, not the object's prototype.
    Object.defineProperty(out, k, { value: plain(x, rs.fields.get(k)!.shape), enumerable: true, writable: true, configurable: true })
  }
  return out
}

/** The file's values in the plain TypeScript view (one value, or an array for a stream). */
export function load(text: string): unknown {
  const values = parseAll(text)
  const { root } = infer(values)
  const out = values.map((v) => plain(v, root))
  return values.length === 1 ? out[0] : out
}

/** JavaScript source for `load(text)`, as an ES module. */
export function moduleSource(text: string): string {
  return `export default ${js(load(text))};\n`
}

function js(x: unknown): string {
  if (x === null) return "null"
  if (x instanceof Uint8Array) return `new Uint8Array([${x.join(",")}])`
  if (Array.isArray(x)) return `[${x.map(js).join(",")}]`
  if (typeof x === "object") {
    return `{${Object.entries(x as Record<string, unknown>).map(([k, v]) => `${k === "__proto__" ? '["__proto__"]' : JSON.stringify(k)}:${js(v)}`).join(",")}}`
  }
  return JSON.stringify(x)
}
