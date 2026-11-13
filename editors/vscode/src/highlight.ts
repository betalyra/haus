// Highlights haus and haus-schema code for the Markdown preview.
//
// The preview highlights code with highlight.js, not with TextMate grammars, so
// this is a small tokenizer that mirrors syntaxes/haus*.tmLanguage.json. It emits
// highlight.js class names, so the colours follow the preview's theme.

/** A token class: a highlight.js scope name, or plain text. */
type Kind = "comment" | "string" | "number" | "attr" | "type" | "keyword" | "plain"

const rules: readonly (readonly [Kind, RegExp])[] = [
  ["comment", /\/\/[^\n]*/y],
  ["string", /"""[\s\S]*?(?:"""|$)/y],
  ["string", /\bx"[^"\n]*"?/y],
  ["attr", /"(?:[^"\\\n]|\\.)*"(?=\s*:)/y],
  ["string", /"(?:[^"\\\n]|\\.)*"?/y],
  ["number", /-?\b0[xX][0-9A-Fa-f](?:_?[0-9A-Fa-f])*\b/y],
  ["number", /-?\b0[bB][01](?:_?[01])*\b/y],
  ["number", /-?\b[0-9](?:_?[0-9])*(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9]+)?\b/y],
  ["attr", /\b[a-z_][A-Za-z0-9_]*\??(?=\s*:)/y],
  ["type", /\b[A-Z][A-Za-z0-9_]*\b/y],
  ["keyword", /\.\.\./y],
  ["plain", /[a-z_][A-Za-z0-9_]*|\s+|[^\s"/A-Za-z0-9_-]+|./y],
]

/** Words that are keywords in a schema (`type`, `closed`, `import`). */
const schemaKeywords = new Set(["type", "closed", "import"])

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

const span = (kind: Kind, text: string) => (kind === "plain" ? escape(text) : `<span class="hljs-${kind}">${escape(text)}</span>`)

/** Block comments nest in haus: the length of the comment starting at `start`. */
const blockComment = (code: string, start: number) => {
  let depth = 0
  let i = start
  while (i < code.length) {
    if (code.startsWith("/*", i)) (depth++, (i += 2))
    else if (code.startsWith("*/", i)) {
      depth--
      i += 2
      if (depth === 0) return i - start
    } else i++
  }
  return code.length - start
}

const token = (code: string, at: number, schema: boolean): [Kind, string] => {
  if (code.startsWith("/*", at)) return ["comment", code.slice(at, at + blockComment(code, at))]
  for (const [kind, re] of rules) {
    re.lastIndex = at
    const m = re.exec(code)
    if (m && m[0].length > 0) {
      if (kind === "plain" && schema && schemaKeywords.has(m[0])) return ["keyword", m[0]]
      return [kind, m[0]]
    }
  }
  return ["plain", code.charAt(at)]
}

/** The code as HTML with highlight.js classes. */
export function highlightHaus(code: string, schema = false): string {
  let html = ""
  for (let at = 0; at < code.length; ) {
    const [kind, text] = token(code, at, schema)
    html += span(kind, text)
    at += text.length
  }
  return html
}

/** Minimal shape of the markdown-it instance the preview passes in. */
interface MarkdownIt {
  options: { highlight?: ((code: string, lang: string, attrs: string) => string) | null }
}

/** Plugs haus into the Markdown preview: ```haus and ```haus-schema blocks; every other language as before. */
export function extendMarkdownIt<M extends MarkdownIt>(md: M): M {
  const fallback = md.options.highlight
  md.options.highlight = (code, lang, attrs) => {
    const name = lang.trim().toLowerCase()
    if (name === "haus" || name === "haus-schema") return `<div>${highlightHaus(code, name === "haus-schema")}</div>`
    return fallback ? fallback(code, lang, attrs) : ""
  }
  return md
}
