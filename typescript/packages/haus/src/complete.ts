/**
 * Completion in data files, from their schema: field names inside records,
 * tags and values where a value goes.
 *
 * While you type, the text is rarely valid haus (`{ id: 1, qua|`), so this
 * doesn't parse it. A forgiving scan up to the cursor tracks which records,
 * arrays and variant payloads the cursor is in (and the key in each), and
 * that path is followed through the schema's types. Linear in the text
 * before the cursor.
 */
import { describeType } from "./check.js"
import type { Field, RecordType, SchemaFile, Type } from "./schema-file.js"

export interface Completion {
  readonly label: string
  readonly kind: "field" | "tag" | "value"
  /** Text to insert, as a snippet ($1, $0 for the cursor). */
  readonly insertText: string
  /** The type, for the completion list. */
  readonly detail: string
  /** Sorts required fields before optional ones. */
  readonly sortText: string
}

type Frame =
  | { kind: "record"; tag: string | undefined; keys: Set<string>; key: string | undefined; afterColon: boolean }
  | { kind: "array"; index: number }
  | { kind: "args"; tag: string; index: number }

/** Where the cursor is: the open records, arrays and argument lists around it. */
function scan(text: string, end: number): Frame[] | undefined {
  const stack: Frame[] = []
  let lastTag: string | undefined
  let pendingKey: string | undefined
  let i = 0
  const top = () => stack[stack.length - 1]
  const MAX = 10_000
  while (i < end) {
    const c = text[i]!
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++
      continue
    }
    if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i)
      if (nl < 0 || nl >= end) return undefined // the cursor is in a comment
      i = nl + 1
      continue
    }
    if (text.startsWith("/*", i)) {
      let depth = 0
      do {
        if (i >= end) return undefined
        if (text.startsWith("/*", i)) depth++, (i += 2)
        else if (text.startsWith("*/", i)) depth--, (i += 2)
        else i++
      } while (depth > 0)
      continue
    }
    if (c === '"' || (c === "x" && text[i + 1] === '"')) {
      // A string or bytes: skip to its end (or give up if the cursor is inside).
      const triple = text.startsWith('"""', i)
      i += c === "x" ? 2 : triple ? 3 : 1
      for (;;) {
        if (i >= end) return undefined
        if (triple ? text.startsWith('"""', i) : text[i] === '"') {
          i += triple ? 3 : 1
          break
        }
        if (text[i] === "\\") i++
        i++
      }
      lastTag = undefined
      continue
    }
    const word = /[A-Za-z_][A-Za-z0-9_]*/y
    word.lastIndex = i
    const m = word.exec(text)
    if (m && m.index === i) {
      i += m[0].length
      const f = top()
      if (/^[A-Z]/.test(m[0])) lastTag = m[0]
      else if (f?.kind === "record" && !f.afterColon) (pendingKey = m[0]), (lastTag = undefined)
      continue
    }
    if (/[-0-9.]/.test(c)) {
      while (i < end && /[0-9A-Za-z_.+-]/.test(text[i]!)) i++
      lastTag = undefined
      continue
    }
    i++
    const f = top()
    switch (c) {
      case "{":
        if (stack.length >= MAX) return undefined
        stack.push({ kind: "record", tag: lastTag, keys: new Set(), key: undefined, afterColon: false })
        break
      case "[":
        if (stack.length >= MAX) return undefined
        stack.push({ kind: "array", index: 0 })
        break
      case "(":
        if (lastTag === undefined || stack.length >= MAX) return undefined
        stack.push({ kind: "args", tag: lastTag, index: 0 })
        break
      case "}":
      case "]":
      case ")":
        stack.pop()
        break
      case ":":
        if (f?.kind === "record") (f.key = pendingKey), (f.afterColon = true)
        break
      case ",":
        if (f?.kind === "record") {
          if (f.key !== undefined) f.keys.add(f.key)
          f.key = undefined
          f.afterColon = false
        } else if (f) f.index++
        break
    }
    lastTag = undefined // a tag only names the { or ( right after it
    if (c === "," || c === "{") pendingKey = undefined
  }
  return stack
}

const resolve = (t: Type): Type => {
  for (let i = 0; t.kind === "ref" && i < 10_000; i++) t = t.instance.body
  return t
}

/** The record type inside a frame: a record, or the record payload of tag `tag`. */
function recordIn(type: Type, tag: string | undefined): RecordType | { kind: "map"; value: Type } | undefined {
  const t = resolve(type)
  if (tag === undefined) return t.kind === "record" ? t : t.kind === "map" ? t : undefined
  if (t.kind !== "variant") return undefined
  const c = t.cases.find((x) => x.tag === tag)
  return c?.payload.kind === "record" ? c.payload.record : undefined
}

/** The type of positional argument `index` of `tag`. */
function argIn(type: Type, tag: string, index: number): Type | undefined {
  const t = resolve(type)
  if (t.kind === "maybe") return tag === "Some" && index === 0 ? t.item : undefined
  if (t.kind === "std" && t.name === tag) return index === 0 ? { kind: "builtin", name: "String" } : undefined
  if (t.kind !== "variant") return undefined
  const c = t.cases.find((x) => x.tag === tag)
  return c?.payload.kind === "positional" ? c.payload.items[index] : undefined
}

const fieldType = (r: RecordType | { kind: "map"; value: Type }, key: string | undefined): Type | undefined =>
  r.kind === "map" ? r.value : r.fields.find((f) => f.key === key)?.type

const quoteKey = (k: string) => (/^[a-z_][A-Za-z0-9_]*$/.test(k) ? k : JSON.stringify(k))

const STD_SNIPPETS: Record<string, string> = {
  Date: 'Date("${1:2026-01-31}")',
  Time: 'Time("${1:09:00:00}")',
  DateTime: 'DateTime("${1:2026-01-31T09:00:00}")',
  Instant: 'Instant("${1:2026-01-31T09:00:00Z}")',
  ZonedDateTime: 'ZonedDateTime("${1:2026-01-31T09:00:00+01:00[Europe/Lisbon]}")',
  Duration: 'Duration("${1:PT30M}")',
  YearMonth: 'YearMonth("${1:2026-01}")',
  TimeZone: 'TimeZone("${1:Europe/Lisbon}")',
}

/** A snippet for a record with its required fields. */
const recordSnippet = (fields: readonly Field[]): string => {
  const required = fields.filter((f) => !f.optional)
  return required.length === 0 ? "{ $0 }" : `{ ${required.map((f, i) => `${quoteKey(f.key)}: $${i + 1}`).join(", ")} }`
}

/** What can be written where a value of `type` goes. */
function values(type: Type): Completion[] {
  const t = resolve(type)
  const detail = describeType(type)
  const value = (label: string, insertText: string, kind: Completion["kind"] = "value"): Completion => ({ label, kind, insertText, detail, sortText: `0${label}` })
  switch (t.kind) {
    case "builtin":
      switch (t.name) {
        case "Bool":
          return [value("True", "True", "tag"), value("False", "False", "tag")]
        case "String":
          return [value('"…"', '"$1"')]
        case "Bytes":
          return [value('x"…"', 'x"$1"')]
        default:
          return []
      }
    case "std": {
      const snippet = STD_SNIPPETS[t.name]
      return snippet ? [value(`${t.name}(…)`, snippet, "tag")] : []
    }
    case "maybe":
      return [value("None", "None", "tag"), value("Some(…)", "Some($1)", "tag")]
    case "array":
      return [value("[…]", "[$0]")]
    case "record":
      return [value("{…}", recordSnippet(t.fields))]
    case "map":
      return [value("{…}", "{ $0 }")]
    case "variant":
      return t.cases.map((c, i): Completion => {
        const insertText =
          c.payload.kind === "none" ? c.tag
          : c.payload.kind === "record" ? `${c.tag} ${recordSnippet(c.payload.record.fields)}`
          : `${c.tag}(${c.payload.items.map((_, j) => `$${j + 1}`).join(", ")})`
        const label = c.payload.kind === "none" ? c.tag : c.payload.kind === "record" ? `${c.tag} {…}` : `${c.tag}(…)`
        return { label, kind: "tag", insertText, detail, sortText: `0${String(i).padStart(4, "0")}` }
      })
    default:
      return []
  }
}

/**
 * Completions at `offset` in a data file described by type `typeName` of a
 * schema file. Empty where the schema has nothing to offer.
 */
export function completeAt(file: SchemaFile, typeName: string, text: string, offset: number): Completion[] {
  const definition = file.definition(typeName)
  if (!definition || definition.params.length > 0) return []
  // The word being typed is replaced by the completion; scan up to its start.
  let start = offset
  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1]!)) start--
  const stack = scan(text, start)
  if (!stack) return []

  let type: Type | undefined = definition.template.body // a Stream's elements, or the whole file's value
  for (let i = 0; i < stack.length; i++) {
    if (type === undefined) return []
    const f = stack[i]!
    const last = i === stack.length - 1
    switch (f.kind) {
      case "record": {
        const r = recordIn(type, f.tag)
        if (!r) return []
        if (last && !f.afterColon) {
          if (r.kind === "map") return []
          return r.fields
            .filter((x) => !f.keys.has(x.key))
            .map((x) => ({
              label: x.optional ? `${x.key}?` : x.key,
              kind: "field" as const,
              insertText: `${quoteKey(x.key)}: `,
              detail: describeType(x.type),
              sortText: `${x.optional ? 1 : 0}${x.key}`,
            }))
        }
        type = fieldType(r, f.key)
        break
      }
      case "array": {
        const t = resolve(type)
        type = t.kind === "array" ? t.item : undefined
        break
      }
      case "args":
        type = argIn(type, f.tag, f.index)
        break
    }
  }
  return type === undefined ? [] : values(type)
}
