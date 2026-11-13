/**
 * Schemas from schema files: the types of a `.schema.haus` file as haus
 * schemas (schema.ts), which are also Standard Schemas.
 *
 *   const { schemas } = compileSchemaFile(text, schemaOptions(path))
 *   const order = h.parse(schemas.Order, data)
 *
 * and the matching TypeScript declarations (`schemaDeclarations`), for typed
 * imports of schema files. Both follow the same mapping, close to the plain
 * view of data without a schema:
 *
 *   String → string             Int, Int64, UInt64 → bigint                    Int8 … UInt32 → number
 *   Decimal → string ("19.90")  Float32, Float64 → number                     Bool → boolean
 *   Bytes → Uint8Array          Maybe a → A | null                            Array a → readonly A[]
 *   Map v → ReadonlyMap<string, V>                                            Instant → Date, other std/time types → string
 *   { a: T, b?: T } → { readonly a: T; readonly b?: T }                       (closed { … } rejects other fields)
 *   < Debug | Info > → "Debug" | "Info"                                       (closed, only tags without payload)
 *   < Circle { r: Float64 } | Empty > → { _tag: "Circle"; r: number } | { _tag: "Empty" }
 *   < Point Float64 Float64 > → { _tag: "Point"; values: readonly [number, number] }
 *   open variants → … | Unknown                                               (other tags kept as raw values)
 */
import * as h from "./schema.js"
import { parseSchemaFile, type Builtin, type Case, type Definition, type Field, type Instance, type ParseSchemaOptions, type SchemaFile, type Type } from "./schema-file.js"

export interface CompiledSchemaFile {
  readonly file: SchemaFile
  /** Schemas of the file's non-generic types, by name. */
  readonly schemas: Readonly<Record<string, h.Schema<unknown>>>
  /** Types that describe a whole file as a stream of values (`type Events = Stream Event`). */
  readonly streams: ReadonlySet<string>
}

/** Parse a schema file and build haus schemas for its types. Throws HausSchemaFileError. */
export const compileSchemaFile = (text: string, options: ParseSchemaOptions = {}): CompiledSchemaFile =>
  fromSchemaFile(parseSchemaFile(text, options))

const isEnum = (cases: readonly Case[]) => cases.length > 0 && cases.every((c) => c.payload.kind === "none")

const builtin = (name: Builtin): h.AnySchema => {
  switch (name) {
    case "String": return h.String
    case "Bytes": return h.Bytes
    case "Bool": return h.Bool
    case "Decimal": return h.Decimal
    case "Int": return h.Int
    case "Int8": return h.Int8
    case "Int16": return h.Int16
    case "Int32": return h.Int32
    case "Int64": return h.Int64
    case "UInt8": return h.UInt8
    case "UInt16": return h.UInt16
    case "UInt32": return h.UInt32
    case "UInt64": return h.UInt64
    default: return h.Float64 // Float32, Float64
  }
}

/** Build haus schemas for an already checked schema file. */
export const fromSchemaFile = (file: SchemaFile): CompiledSchemaFile => {
  const built = new Map<Instance, h.AnySchema>()
  const building = new Set<Instance>()

  const ref = (inst: Instance): h.AnySchema => {
    const done = built.get(inst)
    if (done) return done
    // A back edge of a recursive type (the checker made sure it is guarded).
    if (building.has(inst)) return h.Recursive(inst.key, () => built.get(inst)!, { maxDepth: 256 })
    building.add(inst)
    const schema = build(inst.body)
    building.delete(inst)
    built.set(inst, schema)
    return schema
  }

  const fields = (fs: readonly Field[]): h.Fields =>
    Object.fromEntries(fs.map((f) => [f.key, f.optional ? h.Optional(build(f.type)) : build(f.type)]))

  const build = (t: Type): h.AnySchema => {
    switch (t.kind) {
      case "builtin":
        return builtin(t.name)
      case "std":
        return t.name === "Instant" ? h.Instant : t.name === "Date" ? h.Date : h.StdTime(t.name)
      case "array":
        return h.Array(build(t.item))
      case "map":
        return h.Map(build(t.value))
      case "maybe":
        return h.Maybe(build(t.item))
      case "record":
        return h.Record(fields(t.fields), { closed: t.closed })
      case "variant": {
        if (isEnum(t.cases) && !t.open) return h.Enum(...t.cases.map((c) => c.tag))
        const cases = Object.fromEntries(t.cases.map((c) => {
          switch (c.payload.kind) {
            case "none":
              return [c.tag, h.Unit]
            case "record":
              if (c.payload.record.fields.some((f) => f.key === "_tag")) throw new Error(`${c.tag}: a field named _tag can't be used in a variant payload`)
              return [c.tag, h.Record(fields(c.payload.record.fields), { closed: c.payload.record.closed })]
            case "positional":
              return [c.tag, h.Tuple(...c.payload.items.map(build))]
          }
        }))
        return (t.open ? h.OpenVariant(cases) : h.Variant(cases))
      }
      case "ref":
        return ref(t.instance)
      case "param":
        throw new Error(`type parameter ${t.name} in a concrete type`)
    }
  }

  const schemas: Record<string, h.Schema<unknown>> = {}
  const streams = new Set<string>()
  for (const d of file.definitions) {
    if (d.params.length > 0) continue // generic types have no schema of their own
    Object.defineProperty(schemas, d.name, { value: ref(d.template), enumerable: true })
    if (d.template.stream) streams.add(d.name)
  }
  return { file, schemas, streams }
}

// ── TypeScript declarations ──────────────────────────────────

const KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const prop = (k: string) => (KEY.test(k) ? k : JSON.stringify(k))
const comment = (body: string) => `/**\n * ${body.replaceAll("*/", "*\\/").split("\n").join("\n * ")}\n */\n`

/** JSDoc for a definition: its comment and its haus source. */
export const definitionDoc = (d: Definition, extra = ""): string =>
  comment(`${extra}${"```haus-schema\n"}${d.source}\n${"```"}`)

/** The definitions a type refers to. */
const referenced = (t: Type, onRef: (d: Definition) => void): void => {
  switch (t.kind) {
    case "array":
    case "maybe":
      return referenced(t.item, onRef)
    case "map":
      return referenced(t.value, onRef)
    case "record":
      return t.fields.forEach((f) => referenced(f.type, onRef))
    case "variant":
      return t.cases.forEach((c) =>
        c.payload.kind === "record" ? referenced(c.payload.record, onRef)
        : c.payload.kind === "positional" ? c.payload.items.forEach((x) => referenced(x, onRef))
        : undefined)
    case "ref":
      t.instance.args.forEach((a) => referenced(a, onRef))
      return onRef(t.instance.definition)
    default:
      return
  }
}

export interface DeclarationOptions {
  /** Module specifier to import this package's types from (default "@haus-fmt/haus/schema"). */
  readonly haus?: string
}

/**
 * A TypeScript module declaring the file's types (`export type Order = …`)
 * and their schemas (`export declare const Order: Schema<Order>`). Imported
 * types are declared too (not exported), so the module needs no other
 * schema module. Generic types are declared as generic type aliases.
 */
export const schemaDeclarations = (file: SchemaFile, options: DeclarationOptions = {}): string => {
  const defs: Definition[] = []
  const seen = new Set<Definition>()
  const visit = (d: Definition) => {
    if (seen.has(d)) return
    seen.add(d)
    defs.push(d)
    referenced(d.template.body, visit)
  }
  file.definitions.forEach(visit)

  // The file's own and imported types keep their names; other files' types get a suffix if needed.
  const names = new Map<Definition, string>()
  const taken = new Set<string>()
  for (const d of file.definitions) names.set(d, d.name), taken.add(d.name)
  for (const [name, d] of file.imported) names.set(d, name), taken.add(name)
  for (const d of defs) {
    if (names.has(d)) continue
    let n = d.name
    for (let i = 1; taken.has(n); i++) n = `${d.name}$${i}`
    names.set(d, n)
    taken.add(n)
  }
  const paramName = (p: string) => {
    const n = p[0]!.toUpperCase() + p.slice(1)
    return taken.has(n) ? `${n}_` : n
  }

  const print = (t: Type): string => {
    switch (t.kind) {
      case "builtin":
        switch (t.name) {
          case "String": case "Decimal": return "string"
          case "Bytes": return "Uint8Array"
          case "Bool": return "boolean"
          case "Int": case "Int64": case "UInt64": return "bigint"
          default: return "number"
        }
      case "std":
        return t.name === "Instant" ? "Date" : "string"
      case "array":
        return `ReadonlyArray<${print(t.item)}>`
      case "map":
        return `ReadonlyMap<string, ${print(t.value)}>`
      case "maybe":
        return `${print(t.item)} | null`
      case "record":
        return record(t.fields)
      case "variant": {
        if (isEnum(t.cases) && !t.open) return t.cases.map((c) => JSON.stringify(c.tag)).join(" | ")
        const cases = t.cases.map((c) => {
          const tag = `readonly _tag: ${JSON.stringify(c.tag)}`
          switch (c.payload.kind) {
            case "none": return `{ ${tag} }`
            case "record": return `{ ${[tag, ...fieldList(c.payload.record.fields)].join("; ")} }`
            case "positional": return `{ ${tag}; readonly values: readonly [${c.payload.items.map(print).join(", ")}] }`
          }
        })
        return [...cases, ...(t.open ? ["h$.Unknown"] : [])].join(" | ") || "never"
      }
      case "ref": {
        const d = t.instance.definition
        const name = names.get(d) ?? d.name
        return t.instance.args.length ? `${name}<${t.instance.args.map(print).join(", ")}>` : name
      }
      case "param":
        return paramName(t.name)
    }
  }
  const fieldList = (fs: readonly Field[]) => fs.map((f) => `readonly ${prop(f.key)}${f.optional ? "?" : ""}: ${print(f.type)}`)
  const record = (fs: readonly Field[]) => (fs.length === 0 ? "{}" : `{ ${fieldList(fs).join("; ")} }`)

  const own = new Set(file.definitions)
  const out: string[] = [`import type * as h$ from ${JSON.stringify(options.haus ?? "@haus-fmt/haus/schema")};\n`]
  for (const d of defs) {
    const name = names.get(d)!
    const exported = own.has(d) ? "export " : ""
    const stream = d.template.stream ? "A stream: a file of values of this type.\n\n" : ""
    const from = own.has(d) ? "" : `From ${d.module ?? "another file"} (${d.id}).\n\n`
    const params = d.params.length ? `<${d.params.map(paramName).join(", ")}>` : ""
    out.push(`${definitionDoc(d, from + stream)}${exported}type ${name}${params} = ${print(d.template.body)};\n`)
    if (own.has(d) && d.params.length === 0) {
      out.push(`${definitionDoc(d, `The schema of ${d.name}.\n\n`)}export declare const ${name}: h$.Schema<${name}>;\n`)
    }
  }
  return out.join("")
}
