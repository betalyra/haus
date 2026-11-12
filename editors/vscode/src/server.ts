// haus language server: syntax diagnostics, outline, hover with inferred
// types, formatting, and schema inference.
// Runs in its own process; the parser is the TypeScript one from the repo.
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve as resolvePath } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  checkData,
  completeAt,
  contextOf,
  format,
  HausSyntaxError,
  hoverAt,
  hoverMarkdown,
  infer,
  inferSchema,
  parseDocument,
  parseSchemaFile,
  schemaReference,
  type SchemaFile,
  type HRecord,
  type HoverContext,
  type Inference,
  type Value,
} from "@haus-fmt/haus"
import { schemaOptions } from "@haus-fmt/haus/node"
import {
  CompletionItemKind,
  createConnection,
  InsertTextFormat,
  DiagnosticSeverity,
  ProposedFeatures,
  SymbolKind,
  TextDocuments,
  TextDocumentSyncKind,
  type CompletionItem,
  type Diagnostic,
  type DocumentSymbol,
  type Hover,
  type Range,
  type TextEdit,
} from "vscode-languageserver/node"
import { TextDocument } from "vscode-languageserver-textdocument"

const connection = createConnection(ProposedFeatures.all)
const documents = new TextDocuments(TextDocument)

interface Parsed {
  values: Value[]
  comments: [number, number][]
  inference: Inference
}

/** Last successful parse per document, so outline and hover keep working while there's an error. */
const parsed = new Map<string, Parsed>()

/** Last valid schema file per `.schema.haus` document. */
const schemas = new Map<string, SchemaFile>()

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    documentSymbolProvider: true,
    hoverProvider: true,
    documentFormattingProvider: true,
    completionProvider: { triggerCharacters: ["{", ":", ",", "(", "["] },
  },
}))

// ── diagnostics ──────────────────────────────────────────────

// The schema a data file is checked against: named in a `// schema: …`
// comment at the top, or the `.schema.haus` file next to it.
interface SchemaLink {
  readonly path: string
  readonly type: string
  /** Where the comment names it (undefined for the sibling file). */
  readonly span: readonly [number, number] | undefined
}

function schemaLink(document: TextDocument): SchemaLink | undefined {
  if (!document.uri.startsWith("file:")) return undefined
  const path = fileURLToPath(document.uri)
  const ref = schemaReference(document.getText())
  if (ref) return { path: resolvePath(dirname(path), ref.path), type: ref.type, span: [ref.start, ref.end] }
  const sibling = path.replace(/\.haus$/, ".schema.haus")
  return sibling !== path && existsSync(sibling) ? { path: sibling, type: "Root", span: undefined } : undefined
}

/** The schema file's text: from the editor if it is open (unsaved changes count), else from disk. */
function schemaText(path: string): string | undefined {
  const open = documents.get(pathToFileURL(path).toString())
  if (open) return open.getText()
  return existsSync(path) ? readFileSync(path, "utf8") : undefined
}

const schemaCache = new Map<string, SchemaFile>()
/** A schema file and its imports (packages from node_modules, files next to it), cached by path and text. */
function compileSchema(text: string, path: string): SchemaFile {
  const key = `${path}\0${text}`
  let file = schemaCache.get(key)
  if (!file) {
    if (schemaCache.size > 32) schemaCache.clear()
    file = parseSchemaFile(text, schemaOptions(path))
    schemaCache.set(key, file)
  }
  return file
}

/** Errors and hints from the data file's schema. */
function schemaDiagnostics(document: TextDocument, values: Value[]): Diagnostic[] {
  const link = schemaLink(document)
  if (!link) return []
  const range = (start: number, end: number): Range => ({ start: document.positionAt(start), end: document.positionAt(end) })
  const at = link.span ? range(...link.span) : range(0, 0)
  const name = link.path.split(/[\\/]/).pop()!
  const text = schemaText(link.path)
  if (text === undefined) return [{ range: at, severity: DiagnosticSeverity.Error, source: "haus", message: `schema file not found: ${link.path}` }]
  let file: SchemaFile
  try {
    file = compileSchema(text, link.path)
  } catch (e) {
    if (!(e instanceof HausSyntaxError)) throw e
    return [{ range: at, severity: DiagnosticSeverity.Error, source: "haus", message: `${name}: ${e.message}` }]
  }
  return checkData(file, link.type, values).map((issue) => ({
    range: range(issue.start, issue.end),
    severity: issue.severity === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Hint,
    ...(issue.severity === "hint" ? { code: "not-in-schema" } : {}),
    source: `haus (${name})`,
    message: issue.message,
  }))
}

// ── completion ───────────────────────────────────────────────

connection.onCompletion(({ textDocument, position }): CompletionItem[] => {
  const document = documents.get(textDocument.uri)
  if (!document || document.languageId !== "haus") return []
  const link = schemaLink(document)
  const text = link && schemaText(link.path)
  if (!link || text === undefined) return []
  let file: SchemaFile
  try {
    file = compileSchema(text, link.path)
  } catch {
    return []
  }
  const kinds = { field: CompletionItemKind.Field, tag: CompletionItemKind.EnumMember, value: CompletionItemKind.Value }
  return completeAt(file, link.type, document.getText(), document.offsetAt(position)).map((c) => ({
    label: c.label,
    kind: kinds[c.kind],
    detail: c.detail,
    insertText: c.insertText,
    insertTextFormat: InsertTextFormat.Snippet,
    sortText: c.sortText,
    // A tag is inserted with its payload; filter on the bare name.
    filterText: c.label.replace(/[ ({].*$/, ""),
  }))
})

function validate(document: TextDocument): void {
  const diagnostics: Diagnostic[] = []
  try {
    if (document.languageId === "haus-schema") {
      const options = document.uri.startsWith("file:") ? schemaOptions(fileURLToPath(document.uri)) : {}
      schemas.set(document.uri, parseSchemaFile(document.getText(), options))
    }
    else {
      const { values, comments } = parseDocument(document.getText())
      parsed.set(document.uri, { values, comments, inference: infer(values) })
      diagnostics.push(...schemaDiagnostics(document, values))
    }
  } catch (e) {
    if (!(e instanceof HausSyntaxError)) throw e
    // Offsets are UTF-16, like LSP positions; highlight the character at the error.
    const start = document.positionAt(e.offset)
    const end = document.positionAt(Math.min(e.offset + 1, document.getText().length))
    diagnostics.push({ range: { start, end }, severity: DiagnosticSeverity.Error, source: "haus", message: e.reason })
  }
  void connection.sendDiagnostics({ uri: document.uri, diagnostics })
}

documents.onDidChangeContent(({ document }) => {
  validate(document)
  // A changed schema: check the open data files again.
  if (document.languageId === "haus-schema") {
    for (const other of documents.all()) if (other.languageId === "haus") validate(other)
  }
})

documents.onDidClose(({ document }) => {
  parsed.delete(document.uri)
  schemas.delete(document.uri)
  void connection.sendDiagnostics({ uri: document.uri, diagnostics: [] })
})

// ── outline ──────────────────────────────────────────────────

connection.onDocumentSymbol(({ textDocument }) => {
  const doc = documents.get(textDocument.uri)
  const schema = schemas.get(textDocument.uri)
  if (doc && schema) {
    return schema.definitions.map((d): DocumentSymbol => {
      const start = doc.offsetAt(doc.positionAt(d.offset))
      const range = { start: doc.positionAt(start), end: doc.positionAt(start + "type ".length + d.name.length) }
      return { name: d.name, detail: d.params.join(" "), kind: SymbolKind.Class, range, selectionRange: range }
    })
  }
  const values = parsed.get(textDocument.uri)?.values
  if (!doc || !values) return []
  const range = (start = 0, end = start): Range => ({ start: doc.positionAt(start), end: doc.positionAt(end) })

  const symbol = (name: string, v: Value, nameSpan?: readonly [number, number]): DocumentSymbol => {
    const full = range(nameSpan?.[0] ?? v.start, v.end)
    return {
      name,
      detail: detail(v),
      kind: symbolKind(v),
      range: full,
      selectionRange: nameSpan ? range(nameSpan[0], nameSpan[1]) : range(v.start, v.end),
      children: children(v),
    }
  }

  const fieldSymbols = (r: HRecord) => [...r.fields].map(([k, x]) => symbol(k, x, r.keySpans?.get(k)))

  const children = (v: Value): DocumentSymbol[] => {
    switch (v.kind) {
      case "record":
        return fieldSymbols(v)
      case "array":
        return v.items.map((x, i) => symbol(`[${i}]`, x))
      case "variant": {
        const [first] = v.args
        if (v.args.length === 1 && first?.kind === "record") return fieldSymbols(first)
        return v.args.map((x, i) => symbol(`[${i}]`, x))
      }
      default:
        return []
    }
  }

  // A single record document shows its fields at the top level.
  const [only] = values
  if (values.length === 1 && only?.kind === "record") return fieldSymbols(only)
  return values.map((v, i) => symbol(v.kind === "variant" ? `[${i}] ${v.tag}` : `[${i}]`, v))
})

const symbolKind = (v: Value): SymbolKind =>
  ({ record: SymbolKind.Object, array: SymbolKind.Array, string: SymbolKind.String, bytes: SymbolKind.Array, number: SymbolKind.Number, variant: SymbolKind.EnumMember })[v.kind]

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

const detail = (v: Value): string => {
  switch (v.kind) {
    case "number": return v.text
    case "string": return JSON.stringify(v.value.length > 40 ? v.value.slice(0, 40) + "…" : v.value)
    case "bytes": return plural(v.bytes.length, "byte")
    case "array": return plural(v.items.length, "item")
    case "record": return plural(v.fields.size, "field")
    case "variant": return v.args.length === 0 ? v.tag : `${v.tag}(…)`
  }
}

// ── hover ────────────────────────────────────────────────────

connection.onHover(({ textDocument, position }): Hover | null => {
  const doc = documents.get(textDocument.uri)
  const schema = schemas.get(textDocument.uri)
  if (doc && schema) {
    // A type name: show its definition.
    const text = doc.getText()
    const offset = doc.offsetAt(position)
    let start = offset
    let end = offset
    while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1]!)) start--
    while (end < text.length && /[A-Za-z0-9_]/.test(text[end]!)) end++
    const d = schema.definition(text.slice(start, end))
    if (!d) return null
    return { contents: { kind: "markdown", value: `\`\`\`haus-schema\n${d.source}\n\`\`\`` } }
  }
  const state = parsed.get(textDocument.uri)
  if (!doc || !state) return null
  const info = hoverAt(hoverState(doc, state), doc.offsetAt(position))
  if (!info) return null
  return {
    contents: { kind: "markdown", value: hoverMarkdown(info) },
    range: { start: doc.positionAt(info.start), end: doc.positionAt(info.end) },
  }
})

/** The hover context of a data file: its values, their inferred types and, with a schema, the schema's types. */
function hoverState(doc: TextDocument, state: Parsed): HoverContext {
  const link = schemaLink(doc)
  const text = link && schemaText(link.path)
  if (!link || text === undefined) return { values: state.values, inference: state.inference }
  try {
    return contextOf(state.values, { file: compileSchema(text, link.path), type: link.type })
  } catch (e) {
    if (!(e instanceof HausSyntaxError)) throw e
    return { values: state.values, inference: state.inference }
  }
}

// ── formatting ───────────────────────────────────────────────

connection.onDocumentFormatting(({ textDocument }): TextEdit[] => {
  const doc = documents.get(textDocument.uri)
  if (!doc || doc.languageId === "haus-schema") return []
  const text = doc.getText()
  let state: { values: Value[]; comments: [number, number][] }
  try {
    state = parseDocument(text)
  } catch {
    return [] // syntax errors are already shown as diagnostics
  }
  const formatted = format(state.values, { source: text, comments: state.comments })
  if (formatted === text) return []
  return [{ range: { start: doc.positionAt(0), end: doc.positionAt(text.length) }, newText: formatted }]
})

/** The whole document in the given style; null on syntax errors. Comments are kept except in compact. */
connection.onRequest("haus/print", ({ uri, style }: { uri: string; style: "pretty" | "compact" }): string | null => {
  const doc = documents.get(uri)
  if (!doc) return null
  const text = doc.getText()
  try {
    const { values, comments } = parseDocument(text)
    return format(values, { style, source: text, comments })
  } catch {
    return null
  }
})

// ── schema inference ─────────────────────────────────────────

connection.onRequest("haus/inferSchema", ({ uri }: { uri: string }): string | null => {
  const state = parsed.get(uri)
  return state ? inferSchema(state.values) : null
})

/** What the prelude says a tag means. */
documents.listen(connection)
connection.listen()
