// haus language server: syntax diagnostics, outline, hover with inferred
// types, formatting, and schema inference.
// Runs in its own process; the parser is the TypeScript one from the repo.
import {
  format,
  HausSyntaxError,
  infer,
  inferSchema,
  parseDocument,
  printShape,
  type HRecord,
  type Inference,
  type Value,
} from "@haus-fmt/haus"
import {
  createConnection,
  DiagnosticSeverity,
  ProposedFeatures,
  SymbolKind,
  TextDocuments,
  TextDocumentSyncKind,
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

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    documentSymbolProvider: true,
    hoverProvider: true,
    documentFormattingProvider: true,
  },
}))

// ── diagnostics ──────────────────────────────────────────────

documents.onDidChangeContent(({ document }) => {
  const diagnostics: Diagnostic[] = []
  try {
    const { values, comments } = parseDocument(document.getText())
    parsed.set(document.uri, { values, comments, inference: infer(values) })
  } catch (e) {
    if (!(e instanceof HausSyntaxError)) throw e
    // Offsets are UTF-16, like LSP positions; highlight the character at the error.
    const start = document.positionAt(e.offset)
    const end = document.positionAt(Math.min(e.offset + 1, document.getText().length))
    diagnostics.push({ range: { start, end }, severity: DiagnosticSeverity.Error, source: "haus", message: e.reason })
  }
  void connection.sendDiagnostics({ uri: document.uri, diagnostics })
})

documents.onDidClose(({ document }) => {
  parsed.delete(document.uri)
  void connection.sendDiagnostics({ uri: document.uri, diagnostics: [] })
})

// ── outline ──────────────────────────────────────────────────

connection.onDocumentSymbol(({ textDocument }) => {
  const doc = documents.get(textDocument.uri)
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
  ({ record: SymbolKind.Object, array: SymbolKind.Array, string: SymbolKind.String, number: SymbolKind.Number, variant: SymbolKind.EnumMember })[v.kind]

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

const detail = (v: Value): string => {
  switch (v.kind) {
    case "number": return v.text
    case "string": return JSON.stringify(v.value.length > 40 ? v.value.slice(0, 40) + "…" : v.value)
    case "array": return plural(v.items.length, "item")
    case "record": return plural(v.fields.size, "field")
    case "variant": return v.args.length === 0 ? v.tag : `${v.tag}(…)`
  }
}

// ── hover ────────────────────────────────────────────────────

connection.onHover(({ textDocument, position }): Hover | null => {
  const doc = documents.get(textDocument.uri)
  const state = parsed.get(textDocument.uri)
  if (!doc || !state) return null
  const offset = doc.offsetAt(position)

  for (const top of state.values) {
    const hit = find(top, offset)
    if (hit) {
      return {
        contents: { kind: "markdown", value: describe(hit.value, hit.key) + inferred(state.inference, hit.value) },
        range: { start: doc.positionAt(hit.span[0]), end: doc.positionAt(hit.span[1]) },
      }
    }
  }
  return null
})

interface Hit {
  value: Value
  /** Set when hovering a record key; `value` is then the field's value. */
  key?: string
  span: readonly [number, number]
}

/** The innermost value (or record key) at `offset`. */
function find(v: Value, offset: number): Hit | undefined {
  if (v.start === undefined || v.end === undefined || offset < v.start || offset >= v.end) return undefined
  const inner = (items: readonly Value[]) => {
    for (const x of items) {
      const hit = find(x, offset)
      if (hit) return hit
    }
    return undefined
  }
  switch (v.kind) {
    case "record":
      for (const [key, span] of v.keySpans ?? []) {
        if (offset >= span[0] && offset < span[1]) return { value: v.fields.get(key)!, key, span }
      }
      return inner([...v.fields.values()]) ?? { value: v, span: [v.start, v.end] }
    case "array":
      return inner(v.items) ?? { value: v, span: [v.start, v.end] }
    case "variant": {
      const tagEnd = v.start + v.tag.length
      if (offset < tagEnd) return { value: v, span: [v.start, tagEnd] }
      return inner(v.args) ?? { value: v, span: [v.start, v.end] }
    }
    default:
      return { value: v, span: [v.start, v.end] }
  }
}

/** The type unified over every value at the same position in this file. */
function inferred(inference: Inference, v: Value): string {
  const shape = inference.shapeOf.get(v)
  if (!shape) return ""
  const seen = shape.occurrences === 1 ? "1 value" : `${shape.occurrences} values`
  return `\n\n---\n\nInferred from this file (${seen} at this position):\n\n\`\`\`haus-schema\n${printShape(shape, { width: 60 })}\n\`\`\``
}

// ── formatting ───────────────────────────────────────────────

connection.onDocumentFormatting(({ textDocument }): TextEdit[] => {
  const doc = documents.get(textDocument.uri)
  if (!doc) return []
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
const PRELUDE: Record<string, string> = {
  True: "`Bool` (prelude)",
  False: "`Bool` (prelude)",
  None: "`Maybe a` (prelude): no value",
  Some: "`Maybe a` (prelude): a value",
  Ok: "`Result e a` (prelude): success",
  Err: "`Result e a` (prelude): failure",
  Keep: "`Patch a` (prelude): leave unchanged",
  Set: "`Patch a` / `Set a` (prelude)",
  Money: "`Money` (prelude): `Money(Decimal, Currency)`",
  Date: "`Date` (prelude): RFC 3339 full-date",
  Time: "`Time` (prelude): RFC 3339 partial-time",
  DateTime: "`DateTime` (prelude): date and time, no zone",
  Instant: "`Instant` (prelude): exact point in time (RFC 3339)",
  ZonedDateTime: "`ZonedDateTime` (prelude): instant + IANA zone (RFC 9557)",
  Duration: "`Duration` (prelude): ISO 8601 duration",
  Bytes: "`Bytes` (prelude): base64",
  Uuid: "`Uuid` (prelude)",
  Map: "`Map k v` (prelude): `Map([(k, v), …])`",
  NaN: "`Float64` (prelude): not a number",
  Infinity: "`Float64` (prelude): +∞",
  NegInfinity: "`Float64` (prelude): −∞",
}

function describe(v: Value, key?: string): string {
  const head = key === undefined ? "" : `**field** \`${key}\`\n\n`
  switch (v.kind) {
    case "number": {
      const asFloat = Number(v.text)
      const exact = /^-?\d+$/.test(v.text) ? Number.isSafeInteger(asFloat) : String(asFloat) === v.text
      return `${head}**number** \`${v.text}\` — exact decimal` +
        (exact ? "" : `\n\nAs a \`Float64\` this would be \`${asFloat}\` (not exact; use \`Decimal\` or \`BigInt\`).`)
    }
    case "string":
      return `${head}**string**, ${plural([...v.value].length, "character")}`
    case "array":
      return `${head}**array**, ${plural(v.items.length, "item")}`
    case "record":
      return `${head}**record**, ${plural(v.fields.size, "field")}: ${[...v.fields.keys()].map((k) => `\`${k}\``).join(", ")}`
    case "variant": {
      const [first] = v.args
      const payload =
        v.args.length === 0 ? "no payload"
        : v.args.length === 1 && first?.kind === "record" ? `record payload (${plural(first.fields.size, "field")})`
        : plural(v.args.length, "positional argument")
      const prelude = PRELUDE[v.tag]
      return `${head}**variant** \`${v.tag}\` — ${payload}` + (prelude ? `\n\n${prelude}` : "")
    }
  }
}

documents.listen(connection)
connection.listen()
