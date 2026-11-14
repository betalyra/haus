/**
 * Serializer and standard formatter (spec §11, "Standard format").
 *
 * Two official layouts, like gofmt there are no other style options:
 * - pretty (default): every non-empty record and array has one entry per
 *   line, each with a trailing comma; short positional payloads stay inline.
 * - compact: every top-level item on a single line, `{ a: 1, b: [1, 2] }`.
 *
 * Given the source text and comment positions (`parseDocument`), comments
 * and blank lines between entries are kept: a comment on its own line stays
 * above the entry that follows it, a comment after an entry on the same line
 * stays after that entry's comma.
 */
import { DEFAULT_LIMITS } from "./parser.js"
import type { HRecord, HVariant, Value } from "./value.js"

export interface FormatOptions {
  /**
   * `"pretty"` (default): one entry per line in every non-empty record and array.
   * `"compact"`: every top-level item on one line. Comments are dropped.
   */
  readonly style?: "pretty" | "compact"
  /** Spaces per indentation level (default 2). */
  readonly indent?: number
  /** Line width for positional payloads like `Money(7.90, EUR)` to stay inline (default 80). */
  readonly width?: number
  /**
   * The text the values were parsed from (with `parseWithLocations` or
   * `parseDocument`). Numbers and single-line strings then keep their
   * original spelling (`0xFF`, `1_000`, escapes), and blank lines between
   * entries are kept.
   */
  readonly source?: string
  /** Comment spans from `parseDocument`; they are kept in the output. Needs `source`. */
  readonly comments?: readonly (readonly [number, number])[]
  /**
   * The number limit of the reader (default 1000, spec §7): an integer whose
   * decimal literal is longer is written in hex, so that it parses again.
   * Pass the same limits as to the parser.
   */
  readonly maxNumberLength?: number
}

/** Format a whole file: one value, or a stream with a comma after each value. */
export function format(values: readonly Value[], options: FormatOptions = {}): string {
  if (options.style === "compact") {
    const f = new Formatter(options)
    if (values.length === 0) return ""
    if (values.length === 1) return f.line(values[0]!) + "\n"
    return values.map((v) => f.line(v) + ",\n").join("")
  }
  const f = new Formatter(options)
  const text = f.file(values)
  return text === "" ? "" : text + "\n"
}

/** Serialize one value (no trailing newline). */
export function stringify(value: Value, options: FormatOptions = {}): string {
  const f = new Formatter(options)
  return options.style === "compact" ? f.line(value) : f.value(value, "", 0)
}

/**
 * A number's literal; an integer longer than `maxNumberLength` (a hex literal
 * at the length limit has a longer decimal form) is written in hex.
 */
export function numberText(text: string, maxNumberLength: number = DEFAULT_LIMITS.maxNumberLength): string {
  if (text.length > maxNumberLength && /^-?\d+$/.test(text)) {
    const n = BigInt(text)
    return (n < 0n ? "-0x" : "0x") + (n < 0n ? -n : n).toString(16)
  }
  return text
}

const BARE_KEY = /^[a-z_][A-Za-z0-9_]*$/

/** One entry of a container: a record field, an array item, a payload argument, a top-level value. */
interface Entry {
  /** Source span of the whole entry (key included); undefined without locations. */
  readonly start: number | undefined
  readonly end: number | undefined
  /** Where the value starts (after `key:`); comments before it move above the entry. */
  readonly valueStart: number | undefined
  /** The entry's text at indentation `ind` (no separator). */
  readonly render: (ind: string) => string
}

class Formatter {
  private readonly step: string
  private readonly width: number
  private readonly source: string | undefined
  private readonly comments: readonly (readonly [number, number])[]
  private readonly maxNumberLength: number

  constructor(options: FormatOptions) {
    this.maxNumberLength = options.maxNumberLength ?? DEFAULT_LIMITS.maxNumberLength
    this.step = " ".repeat(options.indent ?? 2)
    this.width = options.width ?? 80
    this.source = options.source
    this.comments = options.source === undefined ? [] : [...(options.comments ?? [])].sort((a, b) => a[0] - b[0])
  }

  // ── entry points ───────────────────────────────────────────

  file(values: readonly Value[]): string {
    const stream = values.length > 1
    const entries = values.map((v) => this.entryOf(v))
    const end = this.source?.length ?? 0
    const body = this.entries(0, end, entries, "", stream ? "," : "", stream)
    return body.replace(/\n$/, "")
  }

  /**
   * Compact: the value on one line with normal spacing. Multi-line strings use
   * `\n` escapes, so a compact stream has exactly one item per line (like NDJSON).
   */
  line(v: Value): string {
    switch (v.kind) {
      case "number":
        return this.number(v)
      case "string":
        return this.basicString(v)
      case "bytes":
        return this.bytes(v)
      case "array":
        return `[${v.items.map((x) => this.line(x)).join(", ")}]`
      case "record":
        return this.lineRecord(v)
      case "variant": {
        const [first] = v.args
        if (v.args.length === 0) return v.tag
        if (v.args.length === 1 && first?.kind === "record") return `${v.tag} ${this.lineRecord(first)}`
        return `${v.tag}(${v.args.map((x) => this.line(x)).join(", ")})`
      }
    }
  }

  private lineRecord(r: HRecord): string {
    return r.fields.size === 0 ? "{}" : `{ ${[...r.fields].map(([k, v]) => `${key(k)}: ${this.line(v)}`).join(", ")} }`
  }

  /** Render `v` at indentation `ind`, with `used` columns already taken on the current line. */
  value(v: Value, ind: string, used: number): string {
    if (!this.hasComments(v.start, v.end)) {
      const flat = this.flat(v)
      if (flat !== undefined && used + flat.length <= this.width) return flat
    }
    return this.broken(v, ind)
  }

  // ── single line ────────────────────────────────────────────

  /** Single-line form, or undefined if the value can't be written on one line (block strings). */
  private flat(v: Value): string | undefined {
    switch (v.kind) {
      case "number":
        return this.number(v)
      case "string":
        return v.value.includes("\n") ? undefined : this.basicString(v)
      case "bytes":
        return this.bytes(v)
      case "array": {
        if (v.items.length > 0) return undefined // pretty: one item per line
        const items = this.all(v.items)
        return items && `[${items.join(", ")}]`
      }
      case "record":
        return this.flatRecord(v)
      case "variant": {
        const [first] = v.args
        if (v.args.length === 0) return v.tag
        if (v.args.length === 1 && first?.kind === "record") {
          const r = this.flatRecord(first)
          return r && `${v.tag} ${r}`
        }
        const args = this.all(v.args)
        return args && `${v.tag}(${args.join(", ")})`
      }
    }
  }

  private all(values: readonly Value[]): string[] | undefined {
    const out: string[] = []
    let length = 0
    for (const v of values) {
      const f = this.flat(v)
      if (f === undefined) return undefined
      // Too wide to stay inline anyway: stop early, so nested payloads aren't
      // rendered in full at every level (that would be quadratic in the depth).
      if ((length += f.length + 2) > this.width) return undefined
      out.push(f)
    }
    return out
  }

  private flatRecord(r: HRecord): string | undefined {
    if (r.fields.size === 0) return "{}"
    return undefined // pretty: one field per line
    const fields: string[] = []
    for (const [k, v] of r.fields) {
      const f = this.flat(v)
      if (f === undefined) return undefined
      fields.push(`${key(k)}: ${f}`)
    }
    return `{ ${fields.join(", ")} }`
  }

  // ── multi-line ─────────────────────────────────────────────

  private broken(v: Value, ind: string): string {
    switch (v.kind) {
      case "number":
        return this.number(v)
      case "string":
        return v.value.includes("\n") ? blockString(v.value, ind + this.step) : this.basicString(v)
      case "bytes":
        return this.bytes(v)
      case "array":
        return this.container("[", "]", inside(v), v.items.map((x) => this.entryOf(x)), ind)
      case "record":
        return this.brokenRecord(v, ind)
      case "variant": {
        const [first] = v.args
        if (v.args.length === 0) return v.tag
        if (v.args.length === 1 && first?.kind === "record") return `${v.tag} ${this.brokenRecord(first, ind)}`
        return v.tag + this.container("(", ")", this.argsSpan(v), v.args.map((x) => this.entryOf(x)), ind)
      }
    }
  }

  private brokenRecord(r: HRecord, ind: string): string {
    const entries = [...r.fields].map(([k, v]): Entry => {
      const span = r.keySpans?.get(k)
      return {
        start: span?.[0] ?? v.start,
        end: v.end,
        valueStart: v.start,
        render: (at) => {
          const prefix = `${key(k)}: `
          return prefix + this.value(v, at, at.length + prefix.length)
        },
      }
    })
    return this.container("{", "}", inside(r), entries, ind)
  }

  private entryOf(v: Value): Entry {
    return { start: v.start, end: v.end, valueStart: v.start, render: (at) => this.value(v, at, at.length) }
  }

  /** `open` + one entry per line (comments and blank lines kept) + `close`. */
  private container(open: string, close: string, span: readonly [number, number] | undefined, entries: Entry[], ind: string): string {
    const [from, to] = span ?? [undefined, undefined]
    if (entries.length === 0 && !this.hasComments(from, to)) return open + close
    const inner = ind + this.step
    return `${open}\n${this.entries(from, to, entries, inner, ",", false)}${ind}${close}`
  }

  /**
   * Entries at indentation `ind`, each on its own line(s) ending in "\n", with
   * the comments in [from, to) placed next to them and blank lines kept.
   */
  private entries(from: number | undefined, to: number | undefined, entries: Entry[], ind: string, sep: string, blankAfterMultiline: boolean): string {
    type Span = readonly [number, number]
    const leading: Span[][] = entries.map(() => [])
    const trailing: Span[][] = entries.map(() => [])
    const dangling: Span[] = []
    const src = this.source

    if (src !== undefined && from !== undefined && to !== undefined) {
      // Comments and entries are sorted by position, so binary search keeps
      // this linear in the comments of this container (not all comments).
      const starts = entries.map((e) => e.start ?? -1)
      const ends = entries.map((e) => e.end ?? -1)
      for (let k = firstAtOrAfter(this.comments, from); k < this.comments.length; k++) {
        const c = this.comments[k]!
        const [cs, ce] = c
        if (cs >= to) break
        if (ce > to) continue
        const last = countBelow(starts, cs + 1) - 1 // last entry starting at or before cs
        const owner = last >= 0 && cs < ends[last]! ? last : -1
        if (owner >= 0) {
          // Inside an entry: between key and value it moves above the entry;
          // deeper inside, the nested container places it.
          const e = entries[owner]!
          if (e.valueStart !== undefined && cs < e.valueStart) leading[owner]!.push(c)
          continue
        }
        const prev = countBelow(ends, cs + 1) - 1 // last entry ending at or before cs
        const n = countBelow(starts, ce) // first entry starting at or after ce
        const next = n < entries.length ? n : -1
        if (prev >= 0 && !src.slice(entries[prev]!.end, cs).includes("\n")) trailing[prev]!.push(c)
        else if (next >= 0) leading[next]!.push(c)
        else dangling.push(c)
      }
    }

    // A blank line in the source between `cursor` and `start` is kept (at most one).
    const blank = (cursor: number | undefined, start: number | undefined) =>
      src !== undefined && cursor !== undefined && start !== undefined && start > cursor && /\n[ \t]*\r?\n/.test(src.slice(cursor, start))
    const text = (c: Span) => src!.slice(c[0], c[1])

    let out = ""
    let cursor = from
    let first = true
    let prevMultiline = false
    const emit = (start: number | undefined, line: string) => {
      if (!first && (blank(cursor, start) || prevMultiline)) out += "\n"
      out += line
      first = false
      prevMultiline = false
    }
    entries.forEach((e, i) => {
      for (const c of leading[i]!) {
        emit(c[0], `${ind}${text(c)}\n`)
        cursor = c[1]
      }
      const rendered = e.render(ind)
      const after = trailing[i]!.map(text)
      emit(e.start, `${ind}${rendered}${sep}${after.length ? " " + after.join(" ") : ""}\n`)
      cursor = trailing[i]!.at(-1)?.[1] ?? e.end
      prevMultiline = blankAfterMultiline && rendered.includes("\n")
    })
    prevMultiline = false
    for (const c of dangling) {
      emit(c[0], `${ind}${text(c)}\n`)
      cursor = c[1]
    }
    return out
  }

  /** Is there a comment inside [start, end)? */
  private hasComments(start: number | undefined, end: number | undefined): boolean {
    if (start === undefined || end === undefined || this.comments.length === 0) return false
    const k = firstAtOrAfter(this.comments, start)
    return k < this.comments.length && this.comments[k]![0] < end
  }

  /** The source span between `(` and `)` of a positional payload. */
  private argsSpan(v: HVariant): [number, number] | undefined {
    if (this.source === undefined || v.start === undefined || v.end === undefined) return undefined
    const open = this.source.indexOf("(", v.start + v.tag.length)
    return [open + 1, v.end - 1]
  }

  // ── leaves ─────────────────────────────────────────────────

  private number(v: Extract<Value, { kind: "number" }>): string {
    return numberText(this.original(v) ?? v.text, this.maxNumberLength)
  }

  /** `x"…"`: the source spelling when reformatting (spaces kept), else lowercase hex. */
  private bytes(v: Extract<Value, { kind: "bytes" }>): string {
    return this.original(v) ?? `x"${toHex(v.bytes)}"`
  }

  private basicString(v: Extract<Value, { kind: "string" }>): string {
    // The original spelling, unless it was a block string (those span lines).
    const original = this.original(v)
    return original !== undefined && original.startsWith('"') && !original.startsWith('"""') ? original : quote(v.value)
  }

  /** The value's source text, when formatting a parsed document. */
  private original(v: Value): string | undefined {
    return this.source !== undefined && v.start !== undefined && v.end !== undefined ? this.source.slice(v.start, v.end) : undefined
  }
}

/** The source span between a container's brackets. */
const inside = (v: Value): [number, number] | undefined =>
  v.start !== undefined && v.end !== undefined ? [v.start + 1, v.end - 1] : undefined

/** How many of the ascending numbers `xs` are below `x`. */
const countBelow = (xs: readonly number[], x: number): number => {
  let lo = 0
  let hi = xs.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (xs[mid]! < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Index of the first comment starting at or after `offset`. */
const firstAtOrAfter = (comments: readonly (readonly [number, number])[], offset: number): number => {
  let lo = 0
  let hi = comments.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (comments[mid]![0] < offset) lo = mid + 1
    else hi = mid
  }
  return lo
}

const key = (k: string) => (BARE_KEY.test(k) ? k : quote(k))

const isBidi = (c: number) => (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)
/** C0, DEL and C1 control characters: written as escapes (spec §4). */
const isControl = (c: number) => c < 0x20 || (c >= 0x7f && c <= 0x9f)
const hexEscape = (c: number) => `\\u{${c.toString(16).toUpperCase()}}`

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"))

/** Lowercase hex, two digits per byte. */
export function toHex(data: Uint8Array): string {
  let out = ""
  for (const b of data) out += HEX[b]
  return out
}

/** A `"…"` string with the minimal escapes. */
export function quote(s: string): string {
  let out = '"'
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (ch === '"') out += '\\"'
    else if (ch === "\\") out += "\\\\"
    else if (ch === "\n") out += "\\n"
    else if (ch === "\r") out += "\\r"
    else if (ch === "\t") out += "\\t"
    else if (isControl(c) || isBidi(c)) out += hexEscape(c)
    else out += ch
  }
  return out + '"'
}

/** A `"""` block string whose content and closing quotes sit at `ind`. */
function blockString(s: string, ind: string): string {
  const lines = s.split("\n").map((line) => {
    let out = ""
    for (const ch of line) {
      const c = ch.codePointAt(0)!
      if (ch === "\\") out += "\\\\"
      else if (ch === "\r") out += "\\r"
      else if ((isControl(c) && ch !== "\t") || isBidi(c)) out += hexEscape(c)
      else out += ch
    }
    // A run of three quotes would close the string early: escape every quote
    // that has two more after it, so at most two raw quotes remain in a row.
    return out.replace(/"(?="")/g, '\\"')
  })
  return `"""\n${lines.map((l) => (l === "" ? "" : ind + l)).join("\n")}\n${ind}"""`
}
