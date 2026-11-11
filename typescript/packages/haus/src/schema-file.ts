/**
 * Schema files (`.schema.haus`): parse, resolve and check them.
 *
 *   import std/time (Instant)            built in (spec §13)
 *   import @haus/money (Money)           a schema package, found by a ModuleResolver
 *   import ./common (Address)            a schema file next to this one
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
 * - `...Name` copies the cases of a named variant (`< ...UserEvent | Ping >`)
 *   or the fields of a named record (`{ ...Entity, name: String }`). Whether
 *   the result is open or closed is decided by its own `closed` alone.
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

/** Types of the standard modules (spec §13), by module. Only std/time: everything else is an ordinary schema package. */
export const STD_MODULES = {
  "std/time": ["Date", "Time", "DateTime", "Instant", "ZonedDateTime", "Duration", "YearMonth", "TimeZone"],
} as const

/** Modules that used to be standard, and where they went. */
const MOVED_MODULES: Record<string, string> = { "std/money": "@haus/money" }
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
  /**
   * The type's identity, the same in every language: `@haus/money@1#Money`
   * for a type of a schema package, `<id>#Name` for a file with an id, or
   * just the name.
   */
  readonly id: string
  /** The identity of the file that defines it; undefined for the file being parsed when it has no id. */
  readonly module: string | undefined
  readonly params: readonly string[]
  /** The `//` comment lines just above the definition. */
  readonly doc: string
  /** The definition's source text, with its comment. */
  readonly source: string
  readonly offset: number
  /**
   * The type for non-generic definitions; for generic ones the template,
   * with `param` types for the parameters.
   */
  readonly template: Instance
}

export interface SchemaFile {
  /** The file's own definitions, in source order. */
  readonly definitions: readonly Definition[]
  /** Types imported from std modules. */
  readonly imports: ReadonlyMap<string, StdType>
  /** Types imported from other schema files and packages, by the name they have here. */
  readonly imported: ReadonlyMap<string, Definition>
  /** The file's identity (ParseSchemaOptions.id), if it has one. */
  readonly id: string | undefined
  /** The definition named `name`, if any. */
  definition(name: string): Definition | undefined
}

// ── lexer ────────────────────────────────────────────────────

type Token =
  | { readonly t: "upper" | "lower" | "string" | "module"; readonly value: string; readonly pos: number }
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
    // A package or file after `import`: @org/name, @org/name@1, ./file, ../dir/file.
    const module = /@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:@[0-9]+)?|\.\.?\/[A-Za-z0-9_./-]*/y
    if (s[pos] === "@" || s.startsWith("./", pos) || s.startsWith("../", pos)) {
      module.lastIndex = pos
      const mm = module.exec(s)
      if (mm) {
        this.pos += mm[0].length
        return { t: "module", value: mm[0], pos }
      }
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

/**
 * `...Name`: the fields or cases of the named type, copied in. `at` is how
 * many own fields or cases come before it, to keep the written order.
 */
interface SpreadNode {
  readonly name: string
  readonly at: number
  readonly pos: number
}

interface FieldNode {
  readonly key: string
  readonly optional: boolean
  readonly type: Node
  readonly pos: number
}

interface RecordNode {
  readonly t: "record"
  readonly fields: readonly FieldNode[]
  readonly spreads: readonly SpreadNode[]
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
  readonly spreads: readonly SpreadNode[]
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
    if (this.cur().t === "module") parts.push(this.advance().value)
    else {
      do {
        if (this.tok.t !== "lower") this.unexpected("a module like std/time, @org/name or ./file")
        parts.push(this.advance().value)
      } while (this.is("/") && this.advance())
    }
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

  /** `...Name`, after the `...`. */
  private parseSpread(at: number): SpreadNode {
    const t = this.tok
    if (t.t === "lower" && !this.keyword()) {
      return this.fail(`row parameters (...${t.value}) aren't supported; spread a named type instead: ...UserEvent`, t.pos)
    }
    if (t.t !== "upper") this.unexpected("a type name after '...': ...UserEvent")
    this.advance()
    return { name: t.value, at, pos: t.pos }
  }

  private parseRecord(closed: boolean): RecordNode {
    const pos = this.advance().pos
    if (this.is("|")) this.fail("{| … |} is gone: write closed { … } for a closed record", this.tok.pos)
    const fields: FieldNode[] = []
    const spreads: SpreadNode[] = []
    while (!this.is("}")) {
      if (this.is("...")) {
        this.advance()
        spreads.push(this.parseSpread(fields.length))
      } else {
        const k = this.tok
        if (k.t !== "lower" && k.t !== "string") this.unexpected("a field name, ...Name or '}'")
        this.advance()
        const optional = this.is("?")
        if (optional) this.advance()
        this.expect(":")
        const type = this.parseApp()
        fields.push({ key: k.value, optional, type, pos: k.pos })
      }
      if (this.is(",")) this.advance()
      else if (!this.is("}")) this.unexpected("',' or '}'")
    }
    this.expect("}")
    return { t: "record", fields, spreads, closed, pos }
  }

  private parseVariant(closed: boolean): VariantNode {
    const pos = this.advance().pos
    const cases: CaseNode[] = []
    const spreads: SpreadNode[] = []
    if (this.is("|")) this.advance()
    while (!this.is(">")) {
      if (this.cur().t === "upper") {
        const tag = this.advance()
        const args: Node[] = []
        while (this.startsAtom()) args.push(this.parseAtom())
        cases.push({ tag: tag.value, args, pos: tag.pos })
      } else if (this.is("...")) {
        this.advance()
        spreads.push(this.parseSpread(cases.length))
      } else this.unexpected("a tag, ...Name or '>'")
      if (this.is(">")) break
      this.expect("|")
    }
    this.advance()
    if (closed && cases.length === 0 && spreads.length === 0) this.fail("a closed variant needs at least one tag", pos)
    return { t: "variant", cases, spreads, closed, pos }
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

// ── imports ──────────────────────────────────────────────────

/** A schema file found for an import. */
export interface ResolvedModule {
  /** Unique for each file (e.g. its absolute path); passed back as `from` for the file's own imports. */
  readonly key: string
  /**
   * The file's identity, the same in every language: `@haus/money@1` for a
   * package's schema (from its manifest), `<package>/<path>` for other files.
   */
  readonly id: string
  readonly text: string
  /** The package version (semver), checked against an `@major` in the import. */
  readonly version?: string
}

/**
 * Finds the schema files that imports name. Resolution happens when the
 * schema is built, never while data is parsed (spec §9.2). Throw an Error
 * with a readable message when a module can't be found.
 */
export interface ModuleResolver {
  /** `module` as written (`@haus/money`, `@haus/money@1`, `./common`), imported by the file `from` (undefined: the root file without a key). */
  resolve(module: string, from: string | undefined): ResolvedModule
}

export interface ParseSchemaOptions {
  /** Finds imported packages and files. Without one, only std modules can be imported. */
  readonly resolver?: ModuleResolver
  /** The root file's key for the resolver (e.g. its path), so relative imports resolve from it. */
  readonly key?: string
  /** The root file's identity, for the ids of its types (see ResolvedModule.id). */
  readonly id?: string
}

// ── resolution ───────────────────────────────────────────────

const PRELUDE_GENERIC: Record<string, number> = { Array: 1, Map: 1, Maybe: 1, Result: 2, Stream: 1 }
const MAX_INSTANCES = 10_000
const MAX_FILES = 256

/** What each type parameter stands for while a generic type is evaluated. */
type Env = ReadonlyMap<string, Type>

type Fail = (reason: string, pos: number) => never

/** One schema file: the root, or one it imports (directly or not). */
interface Unit {
  readonly root: boolean
  readonly id: string | undefined
  readonly text: string
  readonly fail: Fail
  /** Its own definitions, by name: what other files can import. */
  readonly own: Map<string, Def>
  /** Every named type in scope: its own definitions and imported ones. */
  readonly scope: Map<string, Def>
  readonly std: Map<string, StdType>
}

interface Def {
  readonly decl: TypeDecl
  readonly params: readonly string[]
  readonly unit: Unit
  definition?: Definition
}

const majorOf = (version: string) => /^v?(\d+)/.exec(version)?.[1]

/** Parse and check a schema file and the files it imports. Throws HausSchemaFileError. */
export function parseSchemaFile(text: string, options: ParseSchemaOptions = {}): SchemaFile {
  const rootFail: Fail = (reason, pos) => {
    const at = locate(text, pos, { offset: 0, line: 1, column: 1 })
    throw new HausSchemaFileError(reason, at.offset, at.line, at.column)
  }
  const units = new Map<string, Unit>()
  const loading: string[] = []
  const allDefs: Def[] = []
  /** The file that has each id: two files with one id would give their types the same ids. */
  const ids = new Map<string, string | undefined>()

  // ── loading: parse each file once, build its scope ──
  const load = (text: string, key: string | undefined, id: string | undefined, fail: Fail, root: boolean): Unit => {
    if (units.size >= MAX_FILES) fail(`more than ${MAX_FILES} schema files are imported`, 0)
    const { imports, types } = new SchemaParser(text, fail).parseFile()
    const unit: Unit = { root, id, text, fail, own: new Map(), scope: new Map(), std: new Map() }
    if (key !== undefined) units.set(key, unit)
    if (id !== undefined) ids.set(id, key)
    loading.push(key ?? "")
    try {
      for (const imp of imports) {
        if (imp.module.startsWith("std/")) {
          const names = (STD_MODULES as Record<string, readonly StdType[]>)[imp.module]
          if (!names) {
            const moved = MOVED_MODULES[imp.module]
            fail(moved
              ? `${imp.module} is no longer a standard module; it is the package ${moved}: import ${moved} (${imp.names.map((n) => n.name).join(", ")})`
              : `unknown standard module ${imp.module} (there is ${Object.keys(STD_MODULES).join(", ")})`, imp.pos)
          }
          for (const n of imp.names) {
            if (!names!.includes(n.name as StdType)) fail(`${imp.module} has no type ${n.name} (it has ${names!.join(", ")})`, n.pos)
            if (unit.std.has(n.name) || unit.scope.has(n.name)) fail(`${n.name} is imported twice`, n.pos)
            unit.std.set(n.name, n.name as StdType)
          }
          continue
        }
        if (!/^(@[^/]+\/|\.\.?\/)/.test(imp.module)) fail(`unknown module ${imp.module}: import std/…, a package @org/name or a file ./name`, imp.pos)
        const dep = loadImport(imp, key, fail)
        for (const n of imp.names) {
          const def = dep.own.get(n.name)
          if (!def) fail(`${imp.module} has no type ${n.name}${dep.own.size ? ` (it has ${[...dep.own.keys()].join(", ")})` : ""}`, n.pos)
          if (unit.std.has(n.name) || unit.scope.has(n.name)) fail(`${n.name} is imported twice`, n.pos)
          unit.scope.set(n.name, def!)
        }
      }
      for (const decl of types) {
        if (unit.own.has(decl.name)) fail(`type ${decl.name} is defined twice`, decl.pos)
        if (unit.scope.has(decl.name) || unit.std.has(decl.name)) fail(`type ${decl.name} is already imported`, decl.pos)
        if ((BUILTINS as readonly string[]).includes(decl.name) || decl.name in PRELUDE_GENERIC) {
          fail(`${decl.name} is a prelude type and can't be redefined`, decl.pos)
        }
        const seen = new Set<string>()
        for (const p of decl.params) {
          if (p.name === "_") fail("_ can't be a parameter name", p.pos)
          if (seen.has(p.name)) fail(`parameter ${p.name} appears twice`, p.pos)
          seen.add(p.name)
        }
        const def: Def = { decl, params: decl.params.map((p) => p.name), unit }
        unit.own.set(decl.name, def)
        unit.scope.set(decl.name, def)
        allDefs.push(def)
      }
    } finally {
      loading.pop()
    }
    return unit
  }

  const loadImport = (imp: ImportDecl, from: string | undefined, fail: Fail): Unit => {
    const resolver = options.resolver
    if (!resolver) return fail(`can't import ${imp.module}: no module resolver (only std modules can be imported here)`, imp.pos)
    let r: ResolvedModule
    try {
      r = resolver.resolve(imp.module.replace(/@[0-9]+$/, ""), from)
    } catch (e) {
      return fail(`can't import ${imp.module}: ${e instanceof Error ? e.message : String(e)}`, imp.pos)
    }
    const wanted = /^@.+@([0-9]+)$/.exec(imp.module)?.[1]
    if (wanted !== undefined && r.version !== undefined && majorOf(r.version) !== wanted) {
      fail(`${imp.module} wants major version ${wanted}, but version ${r.version} was found`, imp.pos)
    }
    if (loading.includes(r.key)) fail(`import cycle: ${imp.module} imports this file again`, imp.pos)
    const cached = units.get(r.key)
    if (cached) return cached
    if (ids.has(r.id) && ids.get(r.id) !== r.key) {
      fail(`${imp.module} is ${r.id}, but another file already is: two copies or two packages with the same name (${r.key})`, imp.pos)
    }
    // Errors inside an imported file are reported at the import, with their place in that file.
    const nested: Fail = (reason, pos) => {
      const at = locate(r.text, pos, { offset: 0, line: 1, column: 1 })
      return fail(`${imp.module} (${at.line}:${at.column}): ${reason}`, imp.pos)
    }
    return load(r.text, r.key, r.id, nested, false)
  }

  const root = load(text, options.key, options.id, rootFail, true)
  const scopeOf = (def: Def, name: string) => def.unit.scope.get(name)

  // Every lowercase name in a type must be one of the definition's parameters.
  const checkParams = (def: Def): void => {
    const params = new Set(def.params)
    const visit = (n: Node): void => {
      switch (n.t) {
        case "var":
          if (!params.has(n.name)) def.unit.fail(`unknown type parameter ${n.name}`, n.pos)
          return
        case "app":
          return n.args.forEach(visit)
        case "record":
          return n.fields.forEach((f) => visit(f.type))
        case "variant":
          return n.cases.forEach((c) => c.args.forEach(visit))
        default:
          return
      }
    }
    visit(def.decl.body)
  }
  for (const def of allDefs) {
    const fail = def.unit.fail
    checkParams(def)
    // §9.10: a generic type refers to itself only with its own parameters.
    const check = (n: Node): void => {
      if (n.t === "app") {
        if (scopeOf(def, n.head) === def && !(n.args.length === def.params.length && n.args.every((a, i) => a.t === "var" && a.name === def.params[i]))) {
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
  const defOf = new Map<Instance, Def>()
  /** The file whose nodes are being evaluated: names resolve in its scope, errors point into it. */
  let current: Unit = root
  const fail: Fail = (reason, pos) => current.fail(reason, pos)
  const within = <R>(unit: Unit, f: () => R): R => {
    const saved = current
    current = unit
    try {
      return f()
    } finally {
      current = saved
    }
  }

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
        return `{${t.closed ? "|" : ""}${t.fields.map((f) => `${JSON.stringify(f.key)}${f.optional ? "?" : ""}:${keyOf(f.type)}`).join(",")}}`
      case "variant":
        return `<${t.cases.map((c) => c.tag + payloadKey(c.payload)).join("|")}${t.open ? "|_" : ""}>`
    }
  }
  const payloadKey = (p: Payload): string =>
    p.kind === "none" ? "" : p.kind === "record" ? keyOf(p.record) : `(${p.items.map(keyOf).join(",")})`

  /** Types of other files are keyed by their id, so equal names in two files stay apart. */
  const nameKey = (def: Def) => (def.unit.root ? def.decl.name : definitionOf(def).id)

  const instance = (def: Def, args: readonly Type[], pos: number): Instance => {
    const key = args.length === 0 ? nameKey(def) : `${nameKey(def)}(${args.map(keyOf).join(",")})`
    let inst = instances.get(key)
    if (inst) return inst
    if (instances.size >= MAX_INSTANCES) fail(`more than ${MAX_INSTANCES} type instances: a generic type grows without bound`, pos)
    inst = new Instance(definitionOf(def), args, key)
    instances.set(key, inst)
    defOf.set(inst, def)
    queue.push([inst, def])
    return inst
  }
  const queue: [Instance, Def][] = []

  const evaluateInstance = (inst: Instance, def: Def): void =>
    within(def.unit, () => {
      if (inst.state === "done") return
      if (inst.state === "evaluating") fail(`type ${def.decl.name} spreads itself (directly or through another type)`, def.decl.pos)
      inst.state = "evaluating"
      const env: Env = new Map(def.params.map((p, i) => [p, inst.args[i]!]))
      const body = def.decl.body
      if ((body.t === "app" && body.head === "Stream") || (body.t === "name" && body.name === "Stream")) {
        if (body.t !== "app" || body.args.length !== 1) return fail("Stream needs 1 argument", body.pos)
        inst.stream = true
        inst.body = evaluate(body.args[0]!, env)
      } else inst.body = evaluate(body, env)
      inst.state = "done"
    })

  /** The body of a type, evaluating it now if necessary. */
  const bodyOf = (inst: Instance): Type => {
    evaluateInstance(inst, defOf.get(inst)!)
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
    const def = current.scope.get(name)
    if (def) {
      if (def.params.length > 0) fail(`${name} needs ${def.params.length} argument${def.params.length > 1 ? "s" : ""} (${[name, ...def.params].join(" ")})`, pos)
      return refTo(instance(def, [], pos), pos)
    }
    const std = current.std.get(name)
    if (std) return { kind: "std", name: std }
    if ((BUILTINS as readonly string[]).includes(name)) return { kind: "builtin", name: name as Builtin }
    if (name in PRELUDE_GENERIC) fail(`${name} needs ${PRELUDE_GENERIC[name]} argument${PRELUDE_GENERIC[name]! > 1 ? "s" : ""}`, pos)
    const module = Object.entries(STD_MODULES).find(([, names]) => (names as readonly string[]).includes(name))?.[0]
      ?? (name === "Money" || name === "Currency" ? "@haus/money" : undefined)
    return fail(module ? `unknown type ${name}; import it with: import ${module} (${name})` : `unknown type ${name}`, pos)
  }

  const refTo = (inst: Instance, pos: number): Type => {
    if (inst.state === "done" && inst.stream) fail(`${inst.name} is a Stream; a stream can only be the whole file, not part of a type`, pos)
    pendingStreamChecks.push([inst, pos, current])
    return { kind: "ref", instance: inst }
  }
  const pendingStreamChecks: [Instance, number, Unit][] = []

  const evaluate = (n: Node, env: Env): Type => {
    switch (n.t) {
      case "name":
        if (n.name === "Stream") return fail("Stream needs 1 argument", n.pos)
        return lookupName(n.name, n.pos)
      case "var":
        return env.get(n.name)!
      case "app":
        return apply(n, env)
      case "record":
        return evaluateRecord(n, env)
      case "variant":
        return evaluateVariant(n, env)
    }
  }

  const apply = (n: Extract<Node, { t: "app" }>, env: Env): Type => {
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
    const def = current.scope.get(n.head)
    if (!def) {
      if (current.std.has(n.head) || (BUILTINS as readonly string[]).includes(n.head)) fail(`${n.head} takes no arguments`, n.pos)
      return lookupName(n.head, n.pos)
    }
    if (n.args.length !== def.params.length) {
      fail(`${n.head} needs ${def.params.length} argument${def.params.length === 1 ? "" : "s"} (${[n.head, ...def.params].join(" ")}), got ${n.args.length}`, n.pos)
    }
    return refTo(instance(def, n.args.map((a) => evaluate(a, env)), n.pos), n.pos)
  }

  /** The record or variant that `...Name` copies from, evaluated now if necessary. */
  const spreadOf = (sp: SpreadNode, want: "record" | "variant"): RecordType | VariantType => {
    const def = current.scope.get(sp.name)
    if (!def) {
      lookupName(sp.name, sp.pos) // reports unknown types, with an import hint
      return fail(`${sp.name} can't be spread: only a named ${want} can`, sp.pos)
    }
    if (def.params.length > 0) {
      fail(`${sp.name} has parameters (${[sp.name, ...def.params].join(" ")}); only a type without parameters can be spread`, sp.pos)
    }
    const inst = instance(def, [], sp.pos)
    const t = resolveRef({ kind: "ref", instance: inst }, sp.pos)
    if (inst.stream) fail(`${sp.name} is a Stream and can't be spread`, sp.pos)
    if (t.kind !== want) fail(`${sp.name} is not a ${want}, so it can't be spread here`, sp.pos)
    return t as RecordType | VariantType
  }

  /** Own entries and spread ones, in the order they are written. */
  const inOrder = <T>(own: readonly T[], spreads: readonly SpreadNode[], spread: (sp: SpreadNode) => readonly T[]): T[] => {
    const out: T[] = []
    own.forEach((x, i) => {
      for (const sp of spreads) if (sp.at === i) out.push(...spread(sp))
      out.push(x)
    })
    for (const sp of spreads) if (sp.at === own.length) out.push(...spread(sp))
    return out
  }

  /** Reports a field or tag that appears twice, saying where each one came from. */
  const once = (what: "field" | "tag") => {
    const seen = new Map<string, string>()
    return (name: string, from: string, pos: number) => {
      const before = seen.get(name)
      if (before !== undefined) {
        const where = [before, from].filter(Boolean).join(" and ")
        fail(`${what} ${name} appears twice${where ? ` (${where})` : ""}`, pos)
      }
      seen.set(name, from)
    }
  }

  const evaluateRecord = (n: RecordNode, env: Env): RecordType => {
    const check = once("field")
    const own = n.fields.map((f) => ({ field: { key: f.key, optional: f.optional, type: evaluate(f.type, env) }, from: "", pos: f.pos }))
    const fields = inOrder(own, n.spreads, (sp) =>
      (spreadOf(sp, "record") as RecordType).fields.map((field) => ({ field, from: `from ...${sp.name}`, pos: sp.pos })),
    ).map(({ field, from, pos }) => (check(field.key, from, pos), field))
    // Open or closed is decided here alone, never by what is spread in.
    return { kind: "record", fields, closed: n.closed }
  }

  const evaluateVariant = (n: VariantNode, env: Env): VariantType => {
    const check = once("tag")
    const own = n.cases.map((c) => {
      const [first] = c.args
      const payload: Payload =
        c.args.length === 0 ? { kind: "none" }
        : c.args.length === 1 && first!.t === "record" ? { kind: "record", record: evaluateRecord(first!, env) }
        : { kind: "positional", items: c.args.map((a) => evaluate(a, env)) }
      return { c: { tag: c.tag, payload } as Case, from: "", pos: c.pos }
    })
    const cases = inOrder(own, n.spreads, (sp) =>
      (spreadOf(sp, "variant") as VariantType).cases.map((c) => ({ c, from: `from ...${sp.name}`, pos: sp.pos })),
    ).map(({ c, from, pos }) => (check(c.tag, from, pos), c))
    // Open or closed is decided here alone, never by what is spread in.
    return { kind: "variant", cases, open: !n.closed }
  }

  const definitionOf = (def: Def): Definition => {
    if (def.definition) return def.definition
    const d = def.decl
    def.definition = {
      name: d.name,
      id: def.unit.id === undefined ? d.name : `${def.unit.id}#${d.name}`,
      module: def.unit.id,
      params: def.params,
      doc: d.doc,
      source: def.unit.text.slice(d.docStart, d.end).trim(),
      offset: d.pos,
      template: undefined as unknown as Instance, // set below, once the definition exists
    }
    return def.definition
  }

  // Evaluate every definition of every file (templates for generic ones), so all errors surface.
  for (const def of allDefs) {
    const definition = definitionOf(def)
    const args = def.params.map((p): Type => ({ kind: "param", name: p }))
    const inst = within(def.unit, () => instance(def, args, def.decl.pos))
    ;(definition as { template: Instance }).template = inst
    while (queue.length > 0) {
      const [i, d] = queue.shift()!
      evaluateInstance(i, d)
    }
  }
  for (const [inst, pos, unit] of pendingStreamChecks) {
    if (inst.stream) unit.fail(`${inst.name} is a Stream; a stream can only be the whole file, not part of a type`, pos)
  }
  // §9.9: every cycle passes through a record, array or variant.
  for (const inst of instances.values()) within(defOf.get(inst)!.unit, () => resolveRef({ kind: "ref", instance: inst }, inst.definition.offset))

  const definitions = [...root.own.values()].map((d) => d.definition!)
  const byName = new Map(definitions.map((d) => [d.name, d]))
  const imported = new Map([...root.scope].filter(([, d]) => d.unit !== root).map(([name, d]) => [name, d.definition!]))
  return { definitions, imports: root.std, imported, id: options.id, definition: (name) => byName.get(name) ?? imported.get(name) }
}

/**
 * The instance of a non-generic definition, or of a generic one applied to
 * concrete types. Use for building schemas.
 */
export function instanceOf(file: SchemaFile, name: string): Instance | undefined {
  const d = file.definition(name)
  return d && d.params.length === 0 ? d.template : undefined
}
