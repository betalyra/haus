/**
 * Check data against a schema file, for editors and `haus check`: every
 * problem with its position, in one linear pass over the data.
 *
 *   const file = parseSchemaFile(schemaText)
 *   const issues = checkData(file, "Root", parseWithLocations(dataText))
 *
 * Errors are values the schema doesn't allow. Hints are fields and tags an
 * open type doesn't list: allowed (a reader ignores them, or reads the tag as
 * unknown), but maybe a typo, so editors mark them gently.
 */
import type { Case, Field, Instance, RecordType, SchemaFile, StdType, Type, VariantType } from "./schema-file.js"
import { checkStdTime } from "./std-time.js"
import type { HRecord, HVariant, Value } from "./value.js"

export interface CheckIssue {
  readonly severity: "error" | "hint"
  readonly message: string
  /** UTF-16 offsets into the data text, `end` exclusive. */
  readonly start: number
  readonly end: number
}

export interface SchemaReference {
  /** The schema file, as written (relative to the data file). */
  readonly path: string
  /** The type that describes the file (default `Root`). */
  readonly type: string
  /** Where the reference is written, for diagnostics. */
  readonly start: number
  readonly end: number
}

/**
 * The `// schema: ./order.schema.haus` or `// schema: ./api.schema.haus#Order`
 * comment in the comment lines at the top of a data file, if any.
 */
export function schemaReference(text: string): SchemaReference | undefined {
  const pattern = /^[ \t]*\/\/[ \t]*schema:[ \t]*([^\s#]+)(?:#([A-Z][A-Za-z0-9_]*))?[ \t]*$/
  let offset = 0
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed !== "" && !trimmed.startsWith("//")) return undefined
    const m = pattern.exec(line.replace(/\r$/, ""))
    if (m) {
      const start = offset + line.indexOf(m[1]!)
      return { path: m[1]!, type: m[2] ?? "Root", start, end: start + m[1]!.length + (m[2] ? m[2].length + 1 : 0) }
    }
    offset += line.length + 1
  }
  return undefined
}

const MAX_ISSUES = 200


const RANGES: Record<string, readonly [bigint, bigint]> = {
  Int8: [-(2n ** 7n), 2n ** 7n - 1n],
  Int16: [-(2n ** 15n), 2n ** 15n - 1n],
  Int32: [-(2n ** 31n), 2n ** 31n - 1n],
  Int64: [-(2n ** 63n), 2n ** 63n - 1n],
  UInt8: [0n, 2n ** 8n - 1n],
  UInt16: [0n, 2n ** 16n - 1n],
  UInt32: [0n, 2n ** 32n - 1n],
  UInt64: [0n, 2n ** 64n - 1n],
}

/** The integer value of a number literal, if it is a whole number. */
function integer(text: string): bigint | undefined {
  const t = text.replaceAll("_", "")
  const negative = t.startsWith("-")
  const body = negative ? t.slice(1) : t
  if (!/^(0x[0-9a-fA-F]+|0b[01]+|\d+)$/.test(body)) return undefined
  const n = BigInt(body)
  return negative ? -n : n
}

/** Edit distance, for "did you mean". Short strings only. */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2 || a.length > 64 || b.length > 64) return 3
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]!
}

const suggest = (word: string, candidates: Iterable<string>): string => {
  let best: string | undefined
  let bestDistance = 3
  for (const c of candidates) {
    const d = distance(word.toLowerCase(), c.toLowerCase())
    if (d < bestDistance) (best = c), (bestDistance = d)
  }
  return best === undefined ? "" : ` Did you mean ${best}?`
}

const quoteKey = (k: string) => (/^[a-z_][A-Za-z0-9_]*$/.test(k) ? k : JSON.stringify(k))

/** A short description of a value, for messages. */
function found(v: Value): string {
  switch (v.kind) {
    case "string":
      return v.value.length > 20 ? "a string" : `the string ${JSON.stringify(v.value)}`
    case "number":
      return `the number ${v.text.length > 20 ? v.text.slice(0, 20) + "…" : v.text}`
    case "bytes":
      return "bytes"
    case "array":
      return "an array"
    case "record":
      return "a record"
    case "variant":
      return `the tag ${v.tag}`
  }
}

/** A short description of a type, for messages. */
function describe(t: Type): string {
  switch (t.kind) {
    case "builtin":
    case "std":
      return t.name
    case "array":
      return `Array ${atom(t.item)}`
    case "map":
      return `Map ${atom(t.value)}`
    case "maybe":
      return `Maybe ${atom(t.item)}`
    case "record":
      return "a record"
    case "variant":
      return tags(t)
    case "ref":
      return t.instance.args.length === 0 ? t.instance.name : `${t.instance.name} ${t.instance.args.map(atom).join(" ")}`
    case "param":
      return t.name
  }
}
/** A short description of a type, as in the schema: `Array Line`, `Maybe Int`, `one of A, B`. */
export const describeType = (t: Type): string => describe(t)

const atom = (t: Type) => {
  const d = describe(t)
  return d.includes(" ") && !d.startsWith("<") ? `(${d})` : d
}
const tags = (v: VariantType) => {
  const names = v.cases.map((c) => c.tag)
  return names.length === 0 ? "any tag" : `one of ${names.slice(0, 6).join(", ")}${names.length > 6 ? ", …" : ""}`
}

/**
 * Check parsed values (with locations, see `parseWithLocations`) against
 * type `typeName` of a schema file. A Stream type checks every value; any
 * other type expects exactly one.
 */
export interface CheckOptions {
  /** Called for every value with the type the schema expects there (as written: `Comment`, not its body). */
  readonly onValue?: (value: Value, type: Type) => void
}

export function checkData(file: SchemaFile, typeName: string, values: readonly Value[], options: CheckOptions = {}): CheckIssue[] {
  const definition = file.definition(typeName)
  if (!definition) return [{ severity: "error", message: `the schema has no type ${typeName}`, start: 0, end: 1 }]
  if (definition.params.length > 0) {
    return [{ severity: "error", message: `${typeName} needs arguments, so it can't describe a whole file`, start: 0, end: 1 }]
  }
  const root: Instance = definition.template
  const issues: CheckIssue[] = []

  const report = (severity: CheckIssue["severity"], message: string, start = 0, end = start + 1) => {
    if (issues.length < MAX_ISSUES) issues.push({ severity, message, start, end: Math.max(end, start + 1) })
  }
  const at = (v: Value) => [v.start ?? 0, v.end ?? (v.start ?? 0) + 1] as const
  const mismatch = (v: Value, t: Type) => report("error", `expected ${describe(t)}, found ${found(v)}`, ...at(v))
  const tagSpan = (v: HVariant) => [v.start ?? 0, (v.start ?? 0) + v.tag.length] as const

  const resolve = (t: Type): Type => {
    for (let i = 0; t.kind === "ref" && i < 10_000; i++) t = t.instance.body
    return t
  }

  const check = (v: Value, type: Type): void => {
    options.onValue?.(v, type)
    if (issues.length >= MAX_ISSUES) return
    const t = resolve(type)
    switch (t.kind) {
      case "builtin":
        return builtin(v, t.name, type)
      case "std":
        return std(v, t.name, type)
      case "array":
        if (v.kind !== "array") return mismatch(v, type)
        for (const item of v.items) check(item, t.item)
        return
      case "map":
        if (v.kind !== "record") return mismatch(v, type)
        for (const x of v.fields.values()) check(x, t.value)
        return
      case "maybe":
        if (v.kind === "variant" && v.tag === "None" && v.args.length === 0) return
        if (v.kind === "variant" && v.tag === "Some" && v.args.length === 1) return check(v.args[0]!, t.item)
        return report("error", `expected None or Some(…) (${describe(type)}), found ${found(v)}`, ...at(v))
      case "record":
        if (v.kind !== "record") return mismatch(v, type)
        return record(v, t)
      case "variant":
        return variant(v, t, type)
      case "ref":
      case "param":
        return
    }
  }

  const builtin = (v: Value, name: string, type: Type): void => {
    switch (name) {
      case "String":
        if (v.kind !== "string") mismatch(v, type)
        return
      case "Bytes":
        if (v.kind !== "bytes") mismatch(v, type)
        return
      case "Bool":
        if (v.kind !== "variant" || (v.tag !== "True" && v.tag !== "False") || v.args.length > 0) mismatch(v, type)
        return
      case "Float32":
      case "Float64":
        if (v.kind === "variant" && ["NaN", "Infinity", "NegInfinity"].includes(v.tag) && v.args.length === 0) return
        if (v.kind !== "number") mismatch(v, type)
        return
      case "Decimal":
        if (v.kind !== "number") return mismatch(v, type)
        if (/^-?0[xb]/.test(v.text)) report("error", "a Decimal is written in decimal digits, not hex or binary", ...at(v))
        return
      default: {
        if (v.kind !== "number") return mismatch(v, type)
        const n = integer(v.text)
        if (n === undefined) return report("error", `expected a whole number (${name}), found ${v.text}`, ...at(v))
        const range = RANGES[name]
        if (range && (n < range[0] || n > range[1])) report("error", `${v.text} is out of range for ${name} (${range[0]} to ${range[1]})`, ...at(v))
      }
    }
  }

  const std = (v: Value, name: StdType, type: Type): void => {
    if (v.kind !== "variant" || v.tag !== name) return mismatch(v, type)
    const [arg] = v.args
    if (v.args.length !== 1 || arg!.kind !== "string") return report("error", `write ${name}("…") with one string`, ...at(v))
    // The std/time profile (spec/std/time.md): built-in rules, like the ranges of Int8.
    const reason = checkStdTime(name, arg!.value)
    if (reason !== undefined) report("error", reason, ...at(arg!))
  }

  const record = (v: HRecord, t: RecordType): void => {
    const known = new Map<string, Field>(t.fields.map((f) => [f.key, f]))
    const missing = t.fields.filter((f) => !f.optional && !v.fields.has(f.key)).map((f) => quoteKey(f.key))
    if (missing.length > 0) {
      const start = v.start ?? 0
      report("error", `missing field${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`, start, start + 1)
    }
    for (const [key, x] of v.fields) {
      const f = known.get(key)
      if (f) {
        check(x, f.type)
        continue
      }
      const [start, end] = v.keySpans?.get(key) ?? at(x)
      const hint = suggest(key, [...known.keys()].filter((k) => !v.fields.has(k)))
      if (t.closed) report("error", `${quoteKey(key)} is not a field of this closed record.${hint}`, start, end)
      else report("hint", `${quoteKey(key)} is not in the schema; a reader ignores it.${hint}`, start, end)
    }
  }

  const variant = (v: Value, t: VariantType, type: Type): void => {
    if (v.kind !== "variant") return mismatch(v, type)
    const c: Case | undefined = t.cases.find((x) => x.tag === v.tag)
    if (!c) {
      const hint = suggest(v.tag, t.cases.map((x) => x.tag))
      if (t.open) report("hint", `${v.tag} is not in the schema; a reader keeps it as an unknown value.${hint}`, ...tagSpan(v))
      else report("error", `${v.tag} is not allowed here: expected ${tags(t)}.${hint}`, ...tagSpan(v))
      return
    }
    const [first] = v.args
    switch (c.payload.kind) {
      case "none":
        if (v.args.length > 0) report("error", `${v.tag} takes no payload`, ...at(v))
        return
      case "record":
        if (v.args.length !== 1 || first!.kind !== "record") return report("error", `write ${v.tag} { … } with a record`, ...at(v))
        return record(first!, c.payload.record)
      case "positional": {
        const items = c.payload.items
        if (v.args.length !== items.length) {
          return report("error", `${v.tag} takes ${items.length} argument${items.length === 1 ? "" : "s"} (${items.map(describe).join(", ")}), found ${v.args.length}`, ...at(v))
        }
        v.args.forEach((arg, i) => check(arg, items[i]!))
      }
    }
  }

  if (root.stream) for (const v of values) check(v, root.body)
  else if (values.length !== 1) {
    const extra = values[1]
    report("error", `expected one value (${typeName} is not a Stream), found ${values.length}`, ...(extra ? at(extra) : [0, 1] as const))
  } else check(values[0]!, root.body)
  return issues
}
