/**
 * Schema files (`.schema.haus`): parse, resolve and check them.
 *
 *   import std/time (Instant)
 *   type Comment = < Comment { author: String, at: Instant, replies: Array Comment } >
 *   type Root = Comment
 *
 * The result is a set of resolved types that bindings turn into their own
 * schemas (the Effect adapter builds Effect schemas from it). The checker
 * enforces what keeps checking data linear (spec §9.9, §9.10):
 *
 * - recursion must pass through a record field, array element or variant
 *   payload (`type A = B`, `type B = A` is rejected);
 * - a generic type refers to itself only with its own parameters
 *   (`type List a = < Nil | Cons a (List a) >`, not `T (Pair a a)`);
 * - records and variants are open (other fields are ignored, other tags kept
 *   as unknown) unless marked `closed`;
 * - rows (`< A | ...r >`, `{ x: T, ...r }`) are filled with a variant or a
 *   record, and a type with rows can't be recursive.
 *
 * Errors are HausSchemaFileError, with the position in the schema file.
 */
import { HausSyntaxError, locate } from "./errors.js"

export class HausSchemaFileError extends HausSyntaxError {}

// ── resolved types ───────────────────────────────────────────

export const BUILTINS = [
  "String", "Bytes", "Bool", "Decimal", "Int",
  "Int8", "Int16", "Int32", "Int64", "UInt8", "UInt16", "UInt32", "UInt64",
  "Float32", "Float64",
] as const
export type Builtin = (typeof BUILTINS)[number]

/** Types of the standard modules (spec §13), by module. */
export const STD_MODULES = {
  "std/time": ["Date", "Time", "DateTime", "Instant", "ZonedDateTime", "Duration", "YearMonth", "TimeZone"],
  "std/money": ["Money", "Currency"],
} as const
export type StdType = (typeof STD_MODULES)[keyof typeof STD_MODULES][number]

export type Type =
  | { readonly kind: "builtin"; readonly name: Builtin }
  | { readonly kind: "std"; readonly name: StdType }
  | { readonly kind: "array"; readonly item: Type }
  | { readonly kind: "map"; readonly value: Type }
  | { readonly kind: "maybe"; readonly item: Type }
  | RecordType
  | VariantType
  | { readonly kind: "ref"; readonly instance: Instance }
  /** A type parameter, only in the template of a generic type. */
  | { readonly kind: "param"; readonly name: string }

export interface Field {
  readonly key: string
  readonly optional: boolean
  readonly type: Type
}

export interface RecordType {
  readonly kind: "record"
  readonly fields: readonly Field[]
  /** `closed { … }`: other fields are an error. Records are open otherwise (other fields are ignored). */
  readonly closed: boolean
  /** An unfilled row parameter (only in templates). */
  readonly row?: string
}

export type Payload =
  | { readonly kind: "none" }
  | { readonly kind: "record"; readonly record: RecordType }
  | { readonly kind: "positional"; readonly items: readonly Type[] }

export interface Case {
  readonly tag: string
  readonly payload: Payload
}

export interface VariantType {
  readonly kind: "variant"
  readonly cases: readonly Case[]
  /** Not `closed`: other tags are accepted as unknown values. */
  readonly open: boolean
  /** An unfilled row parameter (only in templates). */
  readonly row?: string
}

/**
 * A named type applied to its arguments: `Comment`, `List Int`. Type
 * references point here, which is how recursive types are represented.
 */
export class Instance {
  body: Type = { kind: "variant", cases: [], open: false }
  /** `type Events = Stream Event`: the file is a stream of `body`. */
  stream = false
  /** @internal */
  state: "new" | "evaluating" | "done" = "new"

  constructor(
    readonly definition: Definition,
    readonly args: readonly Type[],
    readonly key: string,
  ) {}

  get name(): string {
    return this.definition.name
  }
}

export interface Definition {
  readonly name: string
  readonly params: readonly string[]
  /** Parameters used as rows (`| r`); the others are type parameters. */
  readonly rowParams: ReadonlySet<string>
  /** The `//` comment lines just above the definition. */
  readonly doc: string
  /** The definition's source text, with its comment. */
  readonly source: string
  readonly offset: number
  /**
   * The type for non-generic definitions; for generic ones the template,
   * with `param` types for the parameters (rows stay unfilled).
   */
  readonly template: Instance
}

export interface SchemaFile {
  /** Definitions in source order. */
  readonly definitions: readonly Definition[]
  readonly imports: ReadonlyMap<string, StdType>
  /** The definition named `name`, if any. */
  definition(name: string): Definition | undefined
}

// ── lexer ────────────────────────────────────────────────────

type Token =
  | { readonly t: "upper" | "lower" | "string"; readonly value: string; readonly pos: number }
  | { readonly t: "punct"; readonly value: string; readonly pos: number }
  | { readonly t: "eof"; readonly value: ""; readonly pos: number }

const PUNCT = ["...", "{", "}", "<", ">", "(", ")", "|", ":", "?", ",", "=", "/"]

class Lexer {
  pos = 0
  constructor(readonly text: string, readonly fail: (reason: string, pos: number) => never) {}

  private skip(): void {
    const s = this.text
    while (this.pos < s.length) {
      const c = s[this.pos]!
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.pos++
      else if (s.startsWith("//", this.pos)) {
        const end = s.indexOf("\n", this.pos)
        this.pos = end < 0 ? s.length : end
      } else if (s.startsWith("/*", this.pos)) {
        const start = this.pos
        let depth = 0
        do {
          if (this.pos >= s.length) this.fail("unterminated block comment", start)
          if (s.startsWith("/*", this.pos)) depth++, (this.pos += 2)
          else if (s.startsWith("*/", this.pos)) depth--, (this.pos += 2)
          else this.pos++
        } while (depth > 0)
      } else return
    }
  }

  next(): Token {
    this.skip()
    const s = this.text
    const pos = this.pos
    if (pos >= s.length) return { t: "eof", value: "", pos }
    const ident = /[A-Za-z_][A-Za-z0-9_]*/y
    ident.lastIndex = pos
    const m = ident.exec(s)
    if (m) {
      this.pos += m[0].length
      return { t: /^[A-Z]/.test(m[0]) ? "upper" : "lower", value: m[0], pos }
    }
    if (s[pos] === '"') {
      const str = /"(?:[^"\\\n]|\\.)*"/y
      str.lastIndex = pos
      const sm = str.exec(s)
      if (!sm) this.fail("unterminated string", pos)
      this.pos += sm[0].length
      try {
        return { t: "string", value: JSON.parse(sm[0]) as string, pos }
      } catch {
        return this.fail("invalid escape in string", pos)
      }
    }
    for (const p of PUNCT) {
      if (s.startsWith(p, pos)) {
        this.pos += p.length
        return { t: "punct", value: p, pos }
      }
    }
    return this.fail(`unexpected character ${JSON.stringify(s[pos])}`, pos)
  }
}

// ── syntax tree ──────────────────────────────────────────────

type Node =
  | { readonly t: "name"; readonly name: string; readonly pos: number }
  | { readonly t: "var"; readonly name: string; readonly pos: number }
  | { readonly t: "app"; readonly head: string; readonly args: readonly Node[]; readonly pos: number }
  | RecordNode
  | VariantNode

/** `...r`: the rest of the fields or tags comes from row parameter r. */
type RowNode = { readonly t: "var"; readonly name: string; readonly pos: number }

interface FieldNode {
  readonly key: string
  readonly optional: boolean
  readonly type: Node
  readonly pos: number
}

interface RecordNode {
  readonly t: "record"
  readonly fields: readonly FieldNode[]
  readonly row: RowNode | undefined
  readonly closed: boolean
  readonly pos: number
}

interface CaseNode {
  readonly tag: string
  readonly args: readonly Node[]
  readonly pos: number
}

interface VariantNode {
  readonly t: "variant"
  readonly cases: readonly CaseNode[]
  readonly row: RowNode | undefined
  readonly closed: boolean
  readonly pos: number
}

interface TypeDecl {
  readonly name: string
  readonly params: readonly { readonly name: string; readonly pos: number }[]
  readonly body: Node
  readonly pos: number
  readonly end: number
  readonly docStart: number
  readonly doc: string
}

interface ImportDecl {
  readonly module: string
  readonly names: readonly { readonly name: string; readonly pos: number }[]
  readonly pos: number
}

const MAX_NESTING = 128

class SchemaParser {
  private tok: Token
  private readonly lexer: Lexer
  private depth = 0
  private lastEnd = 0

  constructor(readonly text: string, readonly fail: (reason: string, pos: number) => never) {
    this.lexer = new Lexer(text, fail)
    this.tok = this.lexer.next()
  }

  private advance(): Token {
    const t = this.tok
    this.lastEnd = this.lexer.pos
    this.tok = this.lexer.next()
    return t
  }

  /** The current token (a method, so TypeScript doesn't keep narrowing it across advance()). */
  private cur(): Token {
    return this.tok
  }

  private is(value: string): boolean {
    return this.tok.t === "punct" && this.tok.value === value
  }

  private expect(value: string): Token {
    if (!this.is(value)) this.unexpected(`'${value}'`)
    return this.advance()
  }

  private unexpected(what: string): never {
    const found = this.tok.t === "eof" ? "end of file" : `'${this.tok.value}'`
    return this.fail(`expected ${what}, found ${found}`, this.tok.pos)
  }

  private keyword(): string | undefined {
    const t = this.tok
    return t.t === "lower" && (t.value === "type" || t.value === "import" || t.value === "closed") ? t.value : undefined
  }

  parseFile(): { imports: ImportDecl[]; types: TypeDecl[] } {
    const imports: ImportDecl[] = []
    const types: TypeDecl[] = []
    while (this.tok.t !== "eof") {
      const kw = this.keyword()
      if (kw === "import") imports.push(this.parseImport())
      else if (kw === "type") types.push(this.parseType())
      else this.unexpected("'type' or 'import'")
    }
    return { imports, types }
  }

  private parseImport(): ImportDecl {
    const pos = this.advance().pos
    const parts: string[] = []
    do {
      if (this.tok.t !== "lower") this.unexpected("a module name like std/time")
      parts.push(this.advance().value)
    } while (this.is("/") && this.advance())
    this.expect("(")
    const names: { name: string; pos: number }[] = []
    while (!this.is(")")) {
      if (this.cur().t !== "upper") this.unexpected("a type name")
      const t = this.advance()
      names.push({ name: t.value, pos: t.pos })
      if (!this.is(")")) this.expect(",")
    }
    this.advance()
    return { module: parts.join("/"), names, pos }
  }

  private parseType(): TypeDecl {
    const pos = this.advance().pos
    if (this.tok.t !== "upper") this.unexpected("a type name (starting with a capital letter)")
    const name = this.advance().value
    const params: { name: string; pos: number }[] = []
    while (this.cur().t === "lower" && !this.keyword()) {
      const t = this.advance()
      params.push({ name: t.value, pos: t.pos })
    }
    this.expect("=")
    const body = this.parseApp()
    const { start, doc } = docComment(this.text, pos)
    return { name, params, body, pos, end: this.lastEnd, docStart: start, doc }
  }

  private nested<T>(pos: number, f: () => T): T {
    if (++this.depth > MAX_NESTING) this.fail(`types nested deeper than ${MAX_NESTING} levels`, pos)
    try {
      return f()
    } finally {
      this.depth--
    }
  }

  /** `Name atom*`, or a single atom. */
  private parseApp(): Node {
    if (this.tok.t === "upper") {
      const head = this.advance()
      const args: Node[] = []
      while (this.startsAtom()) args.push(this.parseAtom())
      return args.length === 0 ? { t: "name", name: head.value, pos: head.pos } : { t: "app", head: head.value, args, pos: head.pos }
    }
    return this.parseAtom()
  }

  private startsAtom(): boolean {
    const t = this.tok
    if (t.t === "upper") return true
    if (t.t === "lower") return this.keyword() === undefined || t.value === "closed"
    return t.t === "punct" && (t.value === "(" || t.value === "{" || t.value === "<")
  }

  private parseAtom(): Node {
    const t = this.tok
    if (t.t === "upper") {
      this.advance()
      return { t: "name", name: t.value, pos: t.pos }
    }
    if (t.t === "lower" && t.value === "closed") {
      this.advance()
      if (this.is("{")) return this.nested(t.pos, () => this.parseRecord(true))
      if (this.is("<")) return this.nested(t.pos, () => this.parseVariant(true))
      return this.unexpected("a record { … } or a variant < … > after 'closed'")
    }
    if (t.t === "lower" && !this.keyword()) {
      if (t.value === "_") this.fail("types are open by default, so there is no _: write < > for any tag, or use a type parameter", t.pos)
      this.advance()
      return { t: "var", name: t.value, pos: t.pos }
    }
    if (this.is("(")) {
      this.advance()
      const inner = this.nested(t.pos, () => this.parseApp())
      this.expect(")")
      return inner
    }
    if (this.is("{")) return this.nested(t.pos, () => this.parseRecord(false))
    if (this.is("<")) return this.nested(t.pos, () => this.parseVariant(false))
    return this.unexpected("a type")
  }

  /** `...r`, after the `...`. */
  private parseRow(what: string): RowNode {
    const t = this.tok
    if (t.t !== "lower" || this.keyword() || t.value === "_") {
      return this.fail(`${what} are open by default; '...' is only for a row parameter: ...r`, t.pos)
    }
    this.advance()
    return { t: "var", name: t.value, pos: t.pos }
  }

  private parseRecord(closed: boolean): RecordNode {
    const pos = this.advance().pos
    if (this.is("|")) this.fail("{| … |} is gone: write closed { … } for a closed record", this.tok.pos)
    const fields: FieldNode[] = []
    let row: RowNode | undefined
    while (!this.is("}")) {
      if (this.is("...")) {
        this.advance()
        row = this.parseRow("records")
        if (this.is(",")) this.advance()
        if (!this.is("}")) this.unexpected("'}' after the row (it comes last)")
        break
      }
      const k = this.tok
      if (k.t !== "lower" && k.t !== "string") this.unexpected("a field name or '}'")
      this.advance()
      const optional = this.is("?")
      if (optional) this.advance()
      this.expect(":")
      const type = this.parseApp()
      fields.push({ key: k.value, optional, type, pos: k.pos })
      if (this.is(",")) this.advance()
      else if (!this.is("}")) this.unexpected("',' or '}'")
    }
    this.expect("}")
    return { t: "record", fields, row, closed, pos }
  }

  private parseVariant(closed: boolean): VariantNode {
    const pos = this.advance().pos
    const cases: CaseNode[] = []
    let row: RowNode | undefined
    if (this.is("|")) this.advance()
    while (!this.is(">")) {
      if (this.cur().t === "upper") {
        const tag = this.advance()
        const args: Node[] = []
        while (this.startsAtom()) args.push(this.parseAtom())
        cases.push({ tag: tag.value, args, pos: tag.pos })
      } else if (this.is("...")) {
        this.advance()
        row = this.parseRow("variants")
        if (!this.is(">")) this.unexpected("'>' after the row (it comes last)")
        break
      } else this.unexpected("a tag, a row ...r or '>'")
      if (this.is(">")) break
      this.expect("|")
    }
    this.advance()
    if (closed && cases.length === 0 && !row) this.fail("a closed variant needs at least one tag", pos)
    return { t: "variant", cases, row, closed, pos }
  }
}

/** The `//` lines directly above `pos` (no blank line in between). */
function docComment(text: string, pos: number): { start: number; doc: string } {
  const lines: string[] = []
  let start = text.lastIndexOf("\n", pos - 1) + 1
  while (start > 0) {
    const prevStart = text.lastIndexOf("\n", start - 2) + 1
    const line = text.slice(prevStart, start - 1).trim()
    if (!line.startsWith("//")) break
    lines.unshift(line.replace(/^\/\/ ?/, ""))
    start = prevStart
  }
  return { start, doc: lines.join("\n") }
}

// ── resolution ───────────────────────────────────────────────

const PRELUDE_GENERIC: Record<string, number> = { Array: 1, Map: 1, Maybe: 1, Result: 2, Stream: 1 }
const MAX_INSTANCES = 10_000

type RowValue =
  | { readonly kind: "cases"; readonly cases: readonly Case[]; readonly open: boolean; readonly row?: string }
  | { readonly kind: "fields"; readonly fields: readonly Field[]; readonly closed: boolean; readonly row?: string }
  | { readonly kind: "unfilled"; readonly name: string }

type Binding = { readonly kind: "type"; readonly type: Type } | { readonly kind: "row"; readonly row: RowValue }

interface Def {
  readonly decl: TypeDecl
  readonly params: readonly string[]
  readonly rowParams: Set<string>
  definition?: Definition
}

/** Parse and check a schema file. Throws HausSchemaFileError. */
export function parseSchemaFile(text: string): SchemaFile {
  const fail = (reason: string, pos: number): never => {
    const at = locate(text, pos, { offset: 0, line: 1, column: 1 })
    throw new HausSchemaFileError(reason, at.offset, at.line, at.column)
  }
  const { imports, types } = new SchemaParser(text, fail).parseFile()

  // ── scope ──
  const imported = new Map<string, StdType>()
  for (const imp of imports) {
    const names = (STD_MODULES as Record<string, readonly StdType[]>)[imp.module]
    if (!names) {
      fail(imp.module.startsWith("std/")
        ? `unknown standard module ${imp.module} (there are ${Object.keys(STD_MODULES).join(", ")})`
        : `only standard modules (std/…) can be imported so far`, imp.pos)
    }
    for (const n of imp.names) {
      if (!names!.includes(n.name as StdType)) fail(`${imp.module} has no type ${n.name} (it has ${names!.join(", ")})`, n.pos)
      if (imported.has(n.name)) fail(`${n.name} is imported twice`, n.pos)
      imported.set(n.name, n.name as StdType)
    }
  }
  const defs = new Map<string, Def>()
  for (const decl of types) {
    if (defs.has(decl.name)) fail(`type ${decl.name} is defined twice`, decl.pos)
    if (imported.has(decl.name)) fail(`type ${decl.name} is already imported`, decl.pos)
    if ((BUILTINS as readonly string[]).includes(decl.name) || decl.name in PRELUDE_GENERIC) {
      fail(`${decl.name} is a prelude type and can't be redefined`, decl.pos)
    }
    const seen = new Set<string>()
    for (const p of decl.params) {
      if (p.name === "_") fail("_ can't be a parameter name", p.pos)
      if (seen.has(p.name)) fail(`parameter ${p.name} appears twice`, p.pos)
      seen.add(p.name)
    }
    defs.set(decl.name, { decl, params: decl.params.map((p) => p.name), rowParams: new Set() })
  }

  // ── parameter kinds: a parameter used as a row (directly or passed to a row parameter) is a row parameter ──
  const kindUses = (def: Def): { rows: Set<string>; types: Set<string> } => {
    const rows = new Set<string>()
    const typesUsed = new Set<string>()
    const params = new Set(def.params)
    const visit = (n: Node, asRow: boolean): void => {
      switch (n.t) {
        case "var":
          if (!params.has(n.name)) fail(`unknown type parameter ${n.name}`, n.pos)
          ;(asRow ? rows : typesUsed).add(n.name)
          return
        case "app": {
          const target = defs.get(n.head)
          n.args.forEach((a, i) => visit(a, target !== undefined && target.rowParams.has(target.params[i] ?? "")))
          return
        }
        case "record":
          n.fields.forEach((f) => visit(f.type, false))
          if (n.row) visit(n.row, true)
          return
        case "variant":
          n.cases.forEach((c) => c.args.forEach((a) => visit(a, false)))
          if (n.row) visit(n.row, true)
          return
        default:
          return
      }
    }
    visit(def.decl.body, false)
    return { rows, types: typesUsed }
  }
  for (let changed = true, rounds = 0; changed; rounds++) {
    changed = false
    if (rounds > defs.size + 1) break
    for (const def of defs.values()) {
      for (const r of kindUses(def).rows) {
        if (!def.rowParams.has(r)) def.rowParams.add(r), (changed = true)
      }
    }
  }
  for (const def of defs.values()) {
    const { types: used } = kindUses(def)
    for (const p of def.decl.params) {
      if (def.rowParams.has(p.name) && used.has(p.name)) fail(`${p.name} is used both as a row and as a type`, p.pos)
    }
    // §9.10: a generic type refers to itself only with its own parameters.
    const check = (n: Node): void => {
      if (n.t === "app") {
        if (n.head === def.decl.name && !(n.args.length === def.params.length && n.args.every((a, i) => a.t === "var" && a.name === def.params[i]))) {
          fail(`${def.decl.name} must refer to itself with its own parameters (${[def.decl.name, ...def.params].join(" ")}); other arguments could grow without bound`, n.pos)
        }
        n.args.forEach(check)
      } else if (n.t === "record") n.fields.forEach((f) => check(f.type))
      else if (n.t === "variant") n.cases.forEach((c) => c.args.forEach(check))
    }
    check(def.decl.body)
  }

  // ── evaluation ──
  const instances = new Map<string, Instance>()
  const expanding: string[] = []

  const keyOf = (t: Type): string => {
    switch (t.kind) {
      case "builtin":
      case "std":
        return t.name
      case "param":
        return `'${t.name}`
      case "array":
        return `Array(${keyOf(t.item)})`
      case "map":
        return `Map(${keyOf(t.value)})`
      case "maybe":
        return `Maybe(${keyOf(t.item)})`
      case "ref":
        return t.instance.key
      case "record":
        return `{${t.closed ? "|" : ""}${t.fields.map((f) => `${JSON.stringify(f.key)}${f.optional ? "?" : ""}:${keyOf(f.type)}`).join(",")}${t.row ? `|${t.row}` : ""}}`
      case "variant":
        return `<${t.cases.map((c) => c.tag + payloadKey(c.payload)).join("|")}${t.open ? "|_" : ""}${t.row ? `|${t.row}` : ""}>`
    }
  }
  const payloadKey = (p: Payload): string =>
    p.kind === "none" ? "" : p.kind === "record" ? keyOf(p.record) : `(${p.items.map(keyOf).join(",")})`

  const instance = (def: Def, args: readonly Type[], pos: number): Instance => {
    const key = args.length === 0 ? def.decl.name : `${def.decl.name}(${args.map(keyOf).join(",")})`
    let inst = instances.get(key)
    if (inst) return inst
    if (instances.size >= MAX_INSTANCES) fail(`more than ${MAX_INSTANCES} type instances: a generic type grows without bound`, pos)
    inst = new Instance(definitionOf(def), args, key)
    instances.set(key, inst)
    queue.push([inst, def])
    return inst
  }
  const queue: [Instance, Def][] = []

  const evaluateInstance = (inst: Instance, def: Def): void => {
    if (inst.state === "done") return
    if (inst.state === "evaluating") fail(`type ${def.decl.name} is used as a row of itself`, def.decl.pos)
    inst.state = "evaluating"
    const env = new Map<string, Binding>()
    def.params.forEach((p, i) => {
      const arg = inst.args[i]!
      env.set(p, def.rowParams.has(p) ? { kind: "row", row: { kind: "unfilled", name: p } } : { kind: "type", type: arg })
    })
    const body = def.decl.body
    if ((body.t === "app" && body.head === "Stream") || (body.t === "name" && body.name === "Stream")) {
      if (body.t !== "app" || body.args.length !== 1) return fail("Stream needs 1 argument", body.pos)
      inst.stream = true
      inst.body = evaluate(body.args[0]!, env)
    } else inst.body = evaluate(body, env)
    inst.state = "done"
  }

  /** The body of a type, evaluating it now if necessary. */
  const bodyOf = (inst: Instance): Type => {
    const def = defs.get(inst.name)!
    evaluateInstance(inst, def)
    return inst.body
  }

  const resolveRef = (t: Type, pos: number): Type => {
    const seen = new Set<Instance>()
    while (t.kind === "ref") {
      if (seen.has(t.instance)) fail(`type ${t.instance.name} refers to itself without a record, array or variant in between`, pos)
      seen.add(t.instance)
      t = bodyOf(t.instance)
    }
    return t
  }

  const lookupName = (name: string, pos: number): Type => {
    const def = defs.get(name)
    if (def) {
      if (def.params.length > 0) fail(`${name} needs ${def.params.length} argument${def.params.length > 1 ? "s" : ""} (${[name, ...def.params].join(" ")})`, pos)
      return refTo(instance(def, [], pos), pos)
    }
    const std = imported.get(name)
    if (std) return { kind: "std", name: std }
    if ((BUILTINS as readonly string[]).includes(name)) return { kind: "builtin", name: name as Builtin }
    if (name in PRELUDE_GENERIC) fail(`${name} needs ${PRELUDE_GENERIC[name]} argument${PRELUDE_GENERIC[name]! > 1 ? "s" : ""}`, pos)
    const module = Object.entries(STD_MODULES).find(([, names]) => (names as readonly string[]).includes(name))?.[0]
    return fail(module ? `unknown type ${name}; import it with: import ${module} (${name})` : `unknown type ${name}`, pos)
  }

  const refTo = (inst: Instance, pos: number): Type => {
    if (inst.state === "done" && inst.stream) fail(`${inst.name} is a Stream; a stream can only be the whole file, not part of a type`, pos)
    pendingStreamChecks.push([inst, pos])
    return { kind: "ref", instance: inst }
  }
  const pendingStreamChecks: [Instance, number][] = []

  const evaluate = (n: Node, env: ReadonlyMap<string, Binding>): Type => {
    switch (n.t) {
      case "name":
        if (n.name === "Stream") return fail("Stream needs 1 argument", n.pos)
        return lookupName(n.name, n.pos)
      case "var": {
        const b = env.get(n.name)!
        if (b.kind === "row") return fail(`${n.name} is a row parameter; use it as '...${n.name}' inside < > or { }`, n.pos)
        return b.type
      }
      case "app":
        return apply(n, env)
      case "record":
        return evaluateRecord(n, env)
      case "variant":
        return evaluateVariant(n, env)
    }
  }

  const apply = (n: Extract<Node, { t: "app" }>, env: ReadonlyMap<string, Binding>): Type => {
    const arity = PRELUDE_GENERIC[n.head]
    if (arity !== undefined) {
      if (n.args.length !== arity) fail(`${n.head} needs ${arity} argument${arity > 1 ? "s" : ""}`, n.pos)
      const [a, b] = n.args.map((x) => evaluate(x, env)) as [Type, Type]
      switch (n.head) {
        case "Array":
          return { kind: "array", item: a }
        case "Map":
          return { kind: "map", value: a }
        case "Maybe":
          return { kind: "maybe", item: a }
        case "Result":
          return {
            kind: "variant",
            open: false,
            cases: [
              { tag: "Err", payload: { kind: "positional", items: [a] } },
              { tag: "Ok", payload: { kind: "positional", items: [b] } },
            ],
          }
        default:
          return fail("Stream can only be the whole type of a definition: type Events = Stream Event", n.pos)
      }
    }
    const def = defs.get(n.head)
    if (!def) {
      if (imported.has(n.head) || (BUILTINS as readonly string[]).includes(n.head)) fail(`${n.head} takes no arguments`, n.pos)
      return lookupName(n.head, n.pos)
    }
    if (n.args.length !== def.params.length) {
      fail(`${n.head} needs ${def.params.length} argument${def.params.length === 1 ? "" : "s"} (${[n.head, ...def.params].join(" ")}), got ${n.args.length}`, n.pos)
    }
    if (def.rowParams.size === 0) {
      return refTo(instance(def, n.args.map((a) => evaluate(a, env)), n.pos), n.pos)
    }
    // Types with rows are expanded where they are used.
    if (expanding.includes(def.decl.name)) fail(`${def.decl.name} has row parameters and so can't be recursive`, n.pos)
    const inner = new Map<string, Binding>()
    def.params.forEach((p, i) => {
      const arg = n.args[i]!
      inner.set(p, def.rowParams.has(p) ? { kind: "row", row: rowArg(arg, env) } : { kind: "type", type: evaluate(arg, env) })
    })
    expanding.push(def.decl.name)
    try {
      const body = def.decl.body
      if (body.t === "app" && body.head === "Stream") fail("Stream can only be the whole type of a definition", n.pos)
      return evaluate(body, inner)
    } finally {
      expanding.pop()
    }
  }

  const rowArg = (n: Node, env: ReadonlyMap<string, Binding>): RowValue => {
    if (n.t === "var") {
      const b = env.get(n.name)!
      if (b.kind === "type") fail(`${n.name} is a type parameter and can't fill a row`, n.pos)
      return (b as Extract<Binding, { kind: "row" }>).row
    }
    const t = resolveRef(evaluate(n, env), n.pos)
    if (t.kind === "variant") return { kind: "cases", cases: t.cases, open: t.open, ...(t.row ? { row: t.row } : {}) }
    if (t.kind === "record") return { kind: "fields", fields: t.fields, closed: t.closed, ...(t.row ? { row: t.row } : {}) }
    return fail("a row is filled with a variant < … > (< > for any tags) or a record { … }", n.pos)
  }

  const rowOf = (row: RowNode, env: ReadonlyMap<string, Binding>): RowValue => {
    const b = env.get(row.name)
    if (!b) return fail(`unknown type parameter ${row.name}`, row.pos)
    if (b.kind === "type") return fail(`${row.name} is a type parameter, not a row`, row.pos)
    return b.row
  }

  const evaluateFields = (nodes: readonly FieldNode[], env: ReadonlyMap<string, Binding>): Field[] => {
    const seen = new Set<string>()
    return nodes.map((f) => {
      if (seen.has(f.key)) fail(`field ${f.key} appears twice`, f.pos)
      seen.add(f.key)
      return { key: f.key, optional: f.optional, type: evaluate(f.type, env) }
    })
  }

  const evaluateRecord = (n: RecordNode, env: ReadonlyMap<string, Binding>): RecordType => {
    const fields = evaluateFields(n.fields, env)
    if (!n.row) return { kind: "record", fields, closed: n.closed }
    const row = rowOf(n.row, env)
    switch (row.kind) {
      case "unfilled":
        return { kind: "record", fields, closed: n.closed, row: row.name }
      case "cases":
        return fail("this row is a record row; it can't be filled with a variant", n.row.pos)
      case "fields": {
        const keys = new Set(fields.map((f) => f.key))
        for (const f of row.fields) if (keys.has(f.key)) fail(`field ${f.key} appears twice after filling the row`, n.row.pos)
        // Closed only if both parts are.
        return { kind: "record", fields: [...fields, ...row.fields], closed: n.closed && row.closed, ...(row.row ? { row: row.row } : {}) }
      }
    }
  }

  const evaluateVariant = (n: VariantNode, env: ReadonlyMap<string, Binding>): VariantType => {
    const seen = new Set<string>()
    const cases: Case[] = n.cases.map((c) => {
      if (seen.has(c.tag)) fail(`tag ${c.tag} appears twice`, c.pos)
      seen.add(c.tag)
      const [first] = c.args
      const payload: Payload =
        c.args.length === 0 ? { kind: "none" }
        : c.args.length === 1 && first!.t === "record" ? { kind: "record", record: evaluateRecord(first!, env) }
        : { kind: "positional", items: c.args.map((a) => evaluate(a, env)) }
      return { tag: c.tag, payload }
    })
    if (!n.row) return { kind: "variant", cases, open: !n.closed }
    const row = rowOf(n.row, env)
    switch (row.kind) {
      case "unfilled":
        return { kind: "variant", cases, open: !n.closed, row: row.name }
      case "fields":
        return fail("this row is a variant row; it can't be filled with a record", n.row.pos)
      case "cases": {
        for (const c of row.cases) if (seen.has(c.tag)) fail(`tag ${c.tag} appears twice after filling the row`, n.row.pos)
        // Closed only if both parts are.
        return { kind: "variant", cases: [...cases, ...row.cases], open: !n.closed || row.open, ...(row.row ? { row: row.row } : {}) }
      }
    }
  }

  const definitionOf = (def: Def): Definition => {
    if (def.definition) return def.definition
    const d = def.decl
    def.definition = {
      name: d.name,
      params: def.params,
      rowParams: def.rowParams,
      doc: d.doc,
      source: text.slice(d.docStart, d.end).trim(),
      offset: d.pos,
      template: undefined as unknown as Instance, // set below, once the definition exists
    }
    return def.definition
  }

  // Evaluate every definition (templates for generic ones), so all errors surface.
  for (const def of defs.values()) {
    const definition = definitionOf(def)
    const args = def.params.map((p): Type => ({ kind: "param", name: p }))
    const inst = instance(def, args, def.decl.pos)
    ;(definition as { template: Instance }).template = inst
    while (queue.length > 0) {
      const [i, d] = queue.shift()!
      evaluateInstance(i, d)
    }
  }
  for (const [inst, pos] of pendingStreamChecks) {
    if (inst.stream) fail(`${inst.name} is a Stream; a stream can only be the whole file, not part of a type`, pos)
  }
  // §9.9: every cycle passes through a record, array or variant.
  for (const inst of instances.values()) resolveRef({ kind: "ref", instance: inst }, inst.definition.offset)

  const definitions = [...defs.values()].map((d) => d.definition!)
  const byName = new Map(definitions.map((d) => [d.name, d]))
  return { definitions, imports: imported, definition: (name) => byName.get(name) }
}

/**
 * The instance of a non-generic definition, or of a generic one applied to
 * concrete types. Use for building schemas.
 */
export function instanceOf(file: SchemaFile, name: string): Instance | undefined {
  const d = file.definition(name)
  return d && d.params.length === 0 ? d.template : undefined
}
