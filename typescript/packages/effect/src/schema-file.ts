/**
 * Effect schemas from haus schema files (`.schema.haus`).
 *
 *   const { schemas } = Haus.compileSchemaFile(text)
 *   const order = yield* Haus.decode(schemas.Order)(data)
 *
 * and the matching TypeScript declarations, for typed imports of schema files
 * (`schemaDeclarations`). Both follow the same mapping:
 *
 *   String → string            Int, Int64, UInt64 → bigint     other Int*, Float* → number
 *   Decimal → BigDecimal       Bool → boolean                   Bytes → Uint8Array
 *   Maybe a → Option<A>        Array a → readonly A[]           Map v → { [key: string]: V }
 *   { a: T, b?: T }            → { readonly a: T; readonly b?: T }   ({| … |} rejects other fields)
 *   < Debug | Info >           → "Debug" | "Info"                     (only tags without payload)
 *   < Circle { r: Float64 } | Empty > → { _tag: "Circle"; r: number } | { _tag: "Empty" }
 *   < Point Float64 Float64 > → { _tag: "Point"; values: readonly [number, number] }
 *   < … | _ >                  → … | Unknown                          (other tags kept as raw values)
 *   std/time: Instant → DateTime.Utc, ZonedDateTime → DateTime.Zoned, the others → string
 *   std/money: Money → { _tag: "Money"; amount: BigDecimal; currency: string }, Currency → string
 */
import { parseSchemaFile, type Builtin, type Case, type Definition, type Field, type Instance, type SchemaFile, type StdType, type Type } from "@betalyra/haus-fmt"
import { Schema } from "effect"
import { CLOSED, UNKNOWN_TAG, VALUES } from "./convert.js"
// Circular import: only used when a schema file is compiled, after both modules have loaded.
import * as Haus from "./index.js"

export interface CompiledSchemaFile {
  readonly file: SchemaFile
  /** Effect schemas of the file's non-generic types, by name. */
  readonly schemas: Readonly<Record<string, Schema.Codec<unknown>>>
  /** Types that describe a whole file as a stream of values (`type Events = Stream Event`). */
  readonly streams: ReadonlySet<string>
}

/** Parse a schema file and build Effect schemas for its types. Throws HausSchemaFileError. */
export const compileSchemaFile = (text: string): CompiledSchemaFile => fromSchemaFile(parseSchemaFile(text))

const isEnum = (cases: readonly Case[]) => cases.length > 0 && cases.every((c) => c.payload.kind === "none")

const INTS: Partial<Record<Builtin, readonly [number, number]>> = {
  Int8: [-128, 127],
  Int16: [-32768, 32767],
  Int32: [-2147483648, 2147483647],
  UInt8: [0, 255],
  UInt16: [0, 65535],
  UInt32: [0, 4294967295],
}

const builtin = (name: Builtin): Schema.Top => {
  const range = INTS[name]
  if (range) return Schema.Int.check(Schema.isBetween({ minimum: range[0], maximum: range[1] }))
  switch (name) {
    case "String":
      return Schema.String
    case "Bytes":
      return Schema.Uint8Array
    case "Bool":
      return Schema.Boolean
    case "Decimal":
      return Schema.BigDecimal
    case "Int":
      return Schema.BigInt
    case "Int64":
      return Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: -(2n ** 63n), maximum: 2n ** 63n - 1n }))
    case "UInt64":
      return Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: 2n ** 64n - 1n }))
    default:
      return Schema.Number // Float32, Float64
  }
}

const std = (name: StdType): Schema.Top => {
  switch (name) {
    case "Instant":
      return Schema.DateTimeUtc
    case "ZonedDateTime":
      return Schema.DateTimeZoned
    case "Money":
      return Haus.Money
    default:
      return Haus[name]
  }
}

/** Build Effect schemas for an already checked schema file. */
export const fromSchemaFile = (file: SchemaFile): CompiledSchemaFile => {
  const built = new Map<Instance, Schema.Top>()
  const building = new Set<Instance>()

  const ref = (inst: Instance): Schema.Top => {
    const done = built.get(inst)
    if (done) return done
    // A back edge of a recursive type.
    if (building.has(inst)) return Schema.suspend(() => built.get(inst)!)
    building.add(inst)
    const schema = build(inst.body).annotate({ identifier: inst.key })
    building.delete(inst)
    built.set(inst, schema)
    return schema
  }

  const fields = (fs: readonly Field[]): Schema.Struct.Fields =>
    Object.fromEntries(fs.map((f) => [f.key, f.optional ? Schema.optionalKey(build(f.type)) : build(f.type)]))

  const build = (t: Type): Schema.Top => {
    switch (t.kind) {
      case "builtin":
        return builtin(t.name)
      case "std":
        return std(t.name)
      case "array":
        return Schema.Array(build(t.item))
      case "map":
        return Schema.Record(Schema.String, build(t.value))
      case "maybe":
        return Schema.Option(build(t.item))
      case "record": {
        const s = Schema.Struct(fields(t.fields))
        return t.closed ? s.annotate({ [CLOSED]: true } as never) : s
      }
      case "variant": {
        if (isEnum(t.cases)) {
          const literals = Schema.Literals(t.cases.map((c) => c.tag))
          return t.open ? Haus.OpenUnion([literals]) : literals
        }
        const members = t.cases.map((c): Schema.Top => {
          switch (c.payload.kind) {
            case "none":
              return Schema.TaggedStruct(c.tag, {})
            case "record": {
              if (c.payload.record.fields.some((f) => f.key === "_tag")) throw new Error(`${c.tag}: a field named _tag can't be used in a variant payload`)
              const s = Schema.TaggedStruct(c.tag, fields(c.payload.record.fields))
              return c.payload.record.closed ? s.annotate({ [CLOSED]: true } as never) : s
            }
            case "positional":
              return Schema.TaggedStruct(c.tag, { values: Schema.Tuple(c.payload.items.map(build)) }).annotate({ [VALUES]: true } as never)
          }
        })
        if (t.open) return Haus.OpenUnion(members)
        return members.length === 1 ? members[0]! : Schema.Union(members)
      }
      case "ref":
        return ref(t.instance)
      case "param":
        throw new Error(`type parameter ${t.name} in a concrete type`)
    }
  }

  const schemas: Record<string, Schema.Codec<unknown>> = {}
  const streams = new Set<string>()
  for (const d of file.definitions) {
    if (d.params.length > 0) continue // generic types have no schema of their own
    Object.defineProperty(schemas, d.name, { value: ref(d.template) as Schema.Codec<unknown>, enumerable: true })
    if (d.template.stream) streams.add(d.name)
  }
  return { file, schemas, streams }
}

// ── TypeScript declarations ──────────────────────────────────

export interface DeclarationOptions {
  /** Module specifier to import Effect's types from (default "effect"). */
  readonly effect?: string
}

const KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const prop = (k: string) => (KEY.test(k) ? k : JSON.stringify(k))
const comment = (body: string) => `/**\n * ${body.replaceAll("*/", "*\\/").split("\n").join("\n * ")}\n */\n`

/** JSDoc for a definition: its comment and its haus source. */
export const definitionDoc = (d: Definition, extra = ""): string =>
  comment(`${extra}${"```haus-schema\n"}${d.source}\n${"```"}`)

/**
 * A TypeScript module declaring the file's types (`export type Order = …`)
 * and their Effect schemas (`export declare const Order: Schema.Codec<Order>`).
 * Generic types are declared as generic type aliases; types with rows are
 * expanded where they are used.
 */
export const schemaDeclarations = (file: SchemaFile, options: DeclarationOptions = {}): string => {
  const used = new Set<string>()
  const names = new Set(file.definitions.map((d) => d.name))
  const paramName = (p: string) => {
    const n = p[0]!.toUpperCase() + p.slice(1)
    return names.has(n) ? `${n}_` : n
  }

  const print = (t: Type): string => {
    switch (t.kind) {
      case "builtin":
        switch (t.name) {
          case "String":
            return "string"
          case "Bytes":
            return "globalThis.Uint8Array"
          case "Bool":
            return "boolean"
          case "Decimal":
            return used.add("BigDecimal"), "BigDecimal$.BigDecimal"
          case "Int":
          case "Int64":
          case "UInt64":
            return "bigint"
          default:
            return "number"
        }
      case "std":
        switch (t.name) {
          case "Instant":
            return used.add("DateTime"), "DateTime$.Utc"
          case "ZonedDateTime":
            return used.add("DateTime"), "DateTime$.Zoned"
          case "Money":
            return used.add("BigDecimal"), `{ readonly _tag: "Money"; readonly amount: BigDecimal$.BigDecimal; readonly currency: string }`
          default:
            return "string"
        }
      case "array":
        return `ReadonlyArray<${print(t.item)}>`
      case "map":
        return `{ readonly [key: string]: ${print(t.value)} }`
      case "maybe":
        return used.add("Option"), `Option$.Option<${print(t.item)}>`
      case "record":
        return record(t.fields)
      case "variant": {
        const unknown = `{ readonly _tag: ${JSON.stringify(UNKNOWN_TAG)}; readonly tag: string; readonly value: unknown }`
        const cases = isEnum(t.cases)
          ? t.cases.map((c) => JSON.stringify(c.tag))
          : t.cases.map((c) => {
            const tag = `readonly _tag: ${JSON.stringify(c.tag)}`
            switch (c.payload.kind) {
              case "none":
                return `{ ${tag} }`
              case "record":
                return `{ ${[tag, ...fieldList(c.payload.record.fields)].join("; ")} }`
              case "positional":
                return `{ ${tag}; readonly values: readonly [${c.payload.items.map(print).join(", ")}] }`
            }
          })
        return [...cases, ...(t.open ? [unknown] : [])].join(" | ") || "never"
      }
      case "ref": {
        const d = t.instance.definition
        return d.params.length === 0 ? d.name : `${d.name}<${t.instance.args.map(print).join(", ")}>`
      }
      case "param":
        return paramName(t.name)
    }
  }
  const fieldList = (fs: readonly Field[]) => fs.map((f) => `readonly ${prop(f.key)}${f.optional ? "?" : ""}: ${print(f.type)}`)
  const record = (fs: readonly Field[]) => (fs.length === 0 ? "{}" : `{ ${fieldList(fs).join("; ")} }`)

  const out: string[] = []
  for (const d of file.definitions) {
    if (d.rowParams.size > 0) {
      out.push(`// ${d.name} has row parameters; it is expanded where it is used.\n`)
      continue
    }
    const stream = d.template.stream ? "A stream: a file of values of this type.\n\n" : ""
    const params = d.params.length ? `<${d.params.map(paramName).join(", ")}>` : ""
    out.push(`${definitionDoc(d, stream)}export type ${d.name}${params} = ${print(d.template.body)};\n`)
    if (d.params.length === 0) {
      used.add("Schema")
      out.push(`${definitionDoc(d, `The Effect schema of ${d.name}.\n\n`)}export declare const ${d.name}: Schema$.Codec<${d.name}>;\n`)
    }
  }
  const imports = [...used].sort().map((n) => `${n} as ${n}$`)
  const head = imports.length ? `import type { ${imports.join(", ")} } from ${JSON.stringify(options.effect ?? "effect")};\n` : ""
  return head + out.join("") + (out.length === 0 ? "export {};\n" : "")
}
