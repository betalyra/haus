import { HausSyntaxError, locate, START, type Origin } from "./errors.js"
import { arr, bytes, num, rec, str, variant, type HBytes, type HRecord, type Value } from "./value.js"

export const MAX_DEPTH = 256

/** Resource limits. Every parser enforces them while parsing (spec: "Limits"). */
export interface Limits {
  /** Nesting depth of records, arrays and payloads. */
  readonly maxDepth: number
  /** Characters in one number literal, including sign, separators and exponent. */
  readonly maxNumberLength: number
  /** Largest absolute exponent, e.g. 6144 allows `1e6144` but not `1e6145`. */
  readonly maxExponent: number
  /** Characters in one decoded string. */
  readonly maxStringLength: number
}

export const DEFAULT_LIMITS: Limits = {
  maxDepth: MAX_DEPTH,
  maxNumberLength: 1000,
  maxExponent: 6144,
  maxStringLength: 16 * 1024 * 1024,
}

/** Raw bidirectional controls (U+202A–U+202E, U+2066–U+2069) are not allowed outside escapes. */
const isBidiControl = (c: number) => (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)
/** Raw control characters (C0, DEL, C1): allowed raw only as tab and line breaks, where the grammar says. */
const isControl = (c: number) => c < 0x20 || (c >= 0x7f && c <= 0x9f)
const hex4 = (c: number) => c.toString(16).toUpperCase().padStart(4, "0")

const isIdentChar = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
const isUpper = (c: number) => c >= 65 && c <= 90
const isLowerStart = (c: number) => (c >= 97 && c <= 122) || c === 95
const isDigit = (c: number) => c >= 48 && c <= 57

const HEX = /-?0x([0-9A-Fa-f](?:_?[0-9A-Fa-f])*)/y
const BIN = /-?0b([01](?:_?[01])*)/y
const DEC = /-?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?/y
const BLANK = /^[ \t]*$/

const describe = (c: string | undefined) =>
  c === undefined ? "end of input" : c === "\n" ? "line break" : `'${c}'`

/**
 * Recursive-descent parser over one complete piece of text. The streaming
 * reader cuts the input into pieces holding one value each; `parseAll`
 * runs over a whole file.
 */
export class Parser {
  private pos = 0
  private depth = 0
  /** With locations: [start, end) of every comment, in source order. */
  readonly comments: [number, number][] = []

  constructor(
    private readonly src: string,
    private readonly origin: Origin = START,
    private readonly limits: Limits = DEFAULT_LIMITS,
    /** Record source positions on every value (for editor tooling). */
    private readonly locations = false,
  ) {}

  /** A whole file: zero or more comma-separated values. */
  parseSequence(): Value[] {
    const out: Value[] = []
    this.skipBom()
    this.skipTrivia()
    while (!this.eof()) {
      out.push(this.parseValue())
      this.skipTrivia()
      if (this.eof()) break
      this.expect(",", "expected ',' between top-level values")
      this.skipTrivia()
    }
    return out
  }

  /** Exactly one value surrounded by trivia (used by the stream reader). */
  parseSingle(): Value {
    this.skipBom()
    this.skipTrivia()
    if (this.eof() || this.peek() === ",") this.fail("expected a value")
    const v = this.parseValue()
    this.skipTrivia()
    if (!this.eof()) this.fail(`expected ',' between top-level values, found ${describe(this.peek())}`)
    return v
  }

  // ── values ─────────────────────────────────────────────────

  private parseValue(): Value {
    if (!this.locations) return this.parseValueAt()
    const start = this.pos
    const v = this.parseValueAt()
    return Object.assign(v, { start, end: this.pos })
  }

  private parseValueAt(): Value {
    const c = this.src.charCodeAt(this.pos)
    switch (this.src[this.pos]) {
      case "{":
        return this.parseRecord()
      case "[":
        return this.parseArray()
      case '"':
        return this.src.startsWith('"""', this.pos) ? this.parseBlockString() : this.parseBasicString()
      case "-":
        return this.parseNumber()
    }
    if (isDigit(c)) return this.parseNumber()
    if (isUpper(c)) return this.parseVariant()
    if (c === 120 && this.src.charCodeAt(this.pos + 1) === 34) return this.parseBytes() // x"
    if (isLowerStart(c)) {
      const word = this.readIdent()
      const hint =
        word === "true" ? " (booleans are the variants True / False)"
        : word === "false" ? " (booleans are the variants True / False)"
        : word === "null" ? " (use the variant None)"
        : ""
      this.fail(`unexpected identifier '${word}': lowercase identifiers can only be record keys${hint}`, this.pos - word.length)
    }
    this.fail(`expected a value, found ${describe(this.peek())}`)
  }

  private enter() {
    if (++this.depth > this.limits.maxDepth) this.fail(`nesting deeper than ${this.limits.maxDepth} levels`)
  }

  private parseRecord(): HRecord {
    const open = this.pos
    this.enter()
    this.pos++ // {
    const fields = new Map<string, Value>()
    const keySpans = this.locations ? new Map<string, readonly [number, number]>() : undefined
    this.skipTrivia()
    while (this.peek() !== "}") {
      if (this.eof()) this.fail("unclosed '{'", open)
      const keyPos = this.pos
      const key = this.parseKey()
      keySpans?.set(key, [keyPos, this.pos])
      this.skipTrivia()
      this.expect(":", `expected ':' after key '${key}'`)
      this.skipTrivia()
      const value = this.parseValue()
      if (fields.has(key)) this.fail(`duplicate key '${key}'`, keyPos)
      fields.set(key, value)
      this.skipTrivia()
      if (this.peek() === ",") {
        this.pos++
        this.skipTrivia()
      } else if (this.peek() !== "}") {
        this.fail(this.eof() ? "unclosed '{'" : `expected ',' or '}', found ${describe(this.peek())}`, this.eof() ? open : this.pos)
      }
    }
    this.pos++ // }
    this.depth--
    return keySpans ? { ...rec(fields), keySpans } : rec(fields)
  }

  private parseKey(): string {
    const c = this.src.charCodeAt(this.pos)
    if (this.peek() === '"') {
      if (this.src.startsWith('"""', this.pos)) this.fail("block strings can't be record keys")
      return this.parseBasicString().value
    }
    if (isLowerStart(c)) return this.readIdent()
    if (isUpper(c)) {
      const word = this.readIdent()
      this.fail(`record keys must start with a lowercase letter or '_'; quote it: "${word}"`, this.pos - word.length)
    }
    this.fail(`expected a record key, found ${describe(this.peek())}`)
  }

  private parseArray(): Value {
    const items = this.parseList("[", "]")
    return arr(items)
  }

  /** `open value, value, ... close`, with an optional trailing comma. */
  private parseList(open: string, close: string): Value[] {
    const start = this.pos
    this.enter()
    this.pos++
    const items: Value[] = []
    this.skipTrivia()
    while (this.peek() !== close) {
      if (this.eof()) this.fail(`unclosed '${open}'`, start)
      items.push(this.parseValue())
      this.skipTrivia()
      if (this.peek() === ",") {
        this.pos++
        this.skipTrivia()
      } else if (this.peek() !== close) {
        this.fail(this.eof() ? `unclosed '${open}'` : `expected ',' or '${close}', found ${describe(this.peek())}`, this.eof() ? start : this.pos)
      }
    }
    this.pos++
    this.depth--
    return items
  }

  private parseVariant(): Value {
    const tag = this.readIdent()
    const afterTag = this.pos
    // The payload must follow on the same line: only spaces and tabs in between.
    // Otherwise `Heartbeat⏎{ a: 1 }` with a forgotten comma would silently
    // become one variant with a payload.
    while (this.peek() === " " || this.peek() === "\t") this.pos++
    if (this.peek() === "(") {
      const parenPos = this.pos
      const args = this.parseList("(", ")")
      if (args.length === 0) this.fail(`empty payload: write '${tag}' without parentheses`, parenPos)
      return variant(tag, args)
    }
    if (this.peek() === "{") {
      const start = this.pos
      const record = this.parseRecord()
      return variant(tag, [this.locations ? Object.assign(record, { start, end: this.pos }) : record])
    }
    this.pos = afterTag
    return variant(tag)
  }

  private parseNumber(): Value {
    const start = this.pos
    this.checkNumberLimits(start)
    let text: string | undefined
    for (const [re, radix] of [[HEX, "0x"], [BIN, "0b"]] as const) {
      re.lastIndex = start
      const m = re.exec(this.src)
      if (m) {
        const neg = this.src[start] === "-"
        const n = BigInt(radix + m[1]!.replaceAll("_", ""))
        text = (neg && n !== 0n ? "-" : "") + n.toString()
        this.pos = re.lastIndex
        break
      }
    }
    if (text === undefined) {
      DEC.lastIndex = start
      const m = DEC.exec(this.src)
      if (!m) this.fail("invalid number", start)
      text = m[0].replaceAll("_", "").replace("E", "e")
      this.pos = DEC.lastIndex
    }
    const next = this.src.charCodeAt(this.pos)
    if (isIdentChar(next) || this.peek() === ".") {
      let end = this.pos
      while (end < this.src.length && (isIdentChar(this.src.charCodeAt(end)) || this.src[end] === ".")) end++
      this.fail(`invalid number '${this.src.slice(start, end)}'`, start)
    }
    return num(text)
  }

  /** Checked before converting, so huge literals are rejected cheaply. */
  private checkNumberLimits(start: number) {
    let end = start
    while (end < this.src.length && /[-+0-9A-Za-z_.]/.test(this.src[end]!)) end++
    if (end - start > this.limits.maxNumberLength) {
      this.fail(`number literal longer than ${this.limits.maxNumberLength} characters`, start)
    }
    const exp = /^-?(?:0|[1-9][0-9_]*)(?:\.[0-9_]+)?[eE]([+-]?)([0-9_]+)$/.exec(this.src.slice(start, end))
    if (exp && Number(exp[2]!.replaceAll("_", "")) > this.limits.maxExponent) {
      this.fail(`exponent larger than ${this.limits.maxExponent}`, start)
    }
  }

  // ── bytes ──────────────────────────────────────────────────

  /** `x"0b34 ff"`: two hex digits per byte; spaces and tabs between bytes. */
  private parseBytes(): HBytes {
    const open = this.pos
    this.pos += 2 // x"
    const out: number[] = []
    for (;;) {
      if (this.eof()) this.fail("unterminated byte string", open)
      const c = this.src.charCodeAt(this.pos)
      if (c === 34) break // "
      if (c === 32 || c === 9) {
        this.pos++
        continue
      }
      const hi = hexValue(c)
      if (hi < 0) {
        this.fail(
          c === 10 || c === 13 ? "line break in byte string (keep x\"…\" on one line)"
          : `invalid character ${describe(this.src[this.pos]!)} in byte string (expected hex digits)`,
        )
      }
      const lo = hexValue(this.src.charCodeAt(this.pos + 1))
      if (lo < 0) this.fail("a byte needs two hex digits (an odd number of digits, or a space inside a byte)", this.pos)
      out.push(hi * 16 + lo)
      this.pos += 2
      if (this.pos - open - 2 > this.limits.maxStringLength) this.fail(`byte string longer than ${this.limits.maxStringLength} characters`, open)
    }
    this.pos++ // "
    return bytes(Uint8Array.from(out))
  }

  // ── strings ────────────────────────────────────────────────

  private parseBasicString() {
    const open = this.pos
    this.pos++ // "
    let out = ""
    let chunk = this.pos
    for (;;) {
      if (this.eof()) this.fail("unterminated string", open)
      const c = this.src.charCodeAt(this.pos)
      if (c === 34) break // "
      if (c === 92) {
        // \
        out += this.src.slice(chunk, this.pos)
        out += this.readEscape()
        chunk = this.pos
        continue
      }
      if (isBidiControl(c)) this.fail(`raw bidirectional control character U+${hex4(c)} (write it as \\u{${hex4(c)}})`)
      if (isControl(c)) {
        this.fail(
          c === 10 ? "line break in string (use \\n or a \"\"\" block string)"
          : c === 9 ? "raw tab in string (use \\t)"
          : `raw control character U+${hex4(c)} in string (write it as \\u{${hex4(c)}})`,
        )
      }
      this.pos++
    }
    out += this.src.slice(chunk, this.pos)
    this.pos++ // "
    return str(this.checkStringLength(out, open))
  }

  /** At a backslash. Consumes the escape and returns its text. */
  private readEscape(): string {
    const start = this.pos
    const e = this.src[this.pos + 1]
    this.pos += 2
    switch (e) {
      case '"': return '"'
      case "\\": return "\\"
      case "n": return "\n"
      case "r": return "\r"
      case "t": return "\t"
      case "u": {
        const m = /\{([0-9A-Fa-f]{1,6})\}/y
        m.lastIndex = this.pos
        const r = m.exec(this.src)
        if (!r) this.fail("invalid unicode escape: expected \\u{1-6 hex digits}", start)
        const cp = parseInt(r[1]!, 16)
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) this.fail(`\\u{${r[1]}} is not a Unicode scalar value`, start)
        this.pos = m.lastIndex
        return String.fromCodePoint(cp)
      }
    }
    this.fail(`invalid escape '\\${e ?? ""}'`, start)
  }

  private parseBlockString() {
    const open = this.pos
    this.pos += 3
    while (this.peek() === " " || this.peek() === "\t") this.pos++
    if (this.src.startsWith("\r\n", this.pos)) this.pos += 2
    else if (this.peek() === "\n") this.pos++
    else this.fail('opening """ must be followed by a line break', this.eof() ? open : this.pos)

    // Find the closing """, skipping escaped characters.
    const contentStart = this.pos
    let close = -1
    for (let i = this.pos; i < this.src.length; i++) {
      const c = this.src.charCodeAt(i)
      if (c === 92) i++
      else if (c === 34 && this.src.startsWith('"""', i)) {
        close = i
        break
      }
    }
    if (close < 0) this.fail("unterminated block string", open)

    // Split into lines, remembering where each starts.
    const lines: { text: string; at: number }[] = []
    let at = contentStart
    for (;;) {
      const nl = this.src.indexOf("\n", at)
      if (nl < 0 || nl >= close) {
        lines.push({ text: this.src.slice(at, close), at })
        break
      }
      const end = nl > at && this.src.charCodeAt(nl - 1) === 13 ? nl - 1 : nl
      lines.push({ text: this.src.slice(at, end), at })
      at = nl + 1
    }
    const last = lines.pop()!
    if (!BLANK.test(last.text)) this.fail('closing """ must be on its own line', close)
    const indent = last.text

    const out: string[] = []
    for (const line of lines) {
      if (line.text.startsWith(indent)) out.push(this.decodeBlockLine(line.text.slice(indent.length), line.at + indent.length))
      else if (BLANK.test(line.text)) out.push("")
      else this.fail('line is indented less than the closing """', line.at)
    }
    this.pos = close + 3
    return str(this.checkStringLength(out.join("\n"), open))
  }

  /** The limit counts characters (code points), not UTF-16 units: an emoji is one character, but two units. */
  private checkStringLength(s: string, open: number): string {
    if (s.length > this.limits.maxStringLength && codePoints(s) > this.limits.maxStringLength) {
      this.fail(`string longer than ${this.limits.maxStringLength} characters`, open)
    }
    return s
  }

  /** Process escapes in one block-string line, starting at `at` in the source. */
  private decodeBlockLine(text: string, at: number): string {
    let out = ""
    let i = 0
    let chunk = 0
    while (i < text.length) {
      const c = text.charCodeAt(i)
      if (c === 92) {
        out += text.slice(chunk, i)
        const saved = this.pos
        this.pos = at + i
        out += this.readEscape()
        i = this.pos - at
        this.pos = saved
        chunk = i
      } else {
        if (isControl(c) && c !== 9) this.fail(`raw control character U+${hex4(c)} in block string (write it as \\u{${hex4(c)}})`, at + i)
        if (isBidiControl(c)) this.fail(`raw bidirectional control character U+${hex4(c)} (write it as \\u{${hex4(c)}})`, at + i)
        i++
      }
    }
    return out + text.slice(chunk)
  }

  // ── trivia & helpers ───────────────────────────────────────

  private skipBom() {
    if (this.src.charCodeAt(0) === 0xfeff && this.pos === 0) this.pos = 1
  }

  private skipTrivia() {
    for (;;) {
      const c = this.src[this.pos]
      if (c === " " || c === "\t" || c === "\n") {
        this.pos++
      } else if (c === "\r" && this.src[this.pos + 1] === "\n") {
        this.pos += 2
      } else if (c === "\r") {
        this.fail("carriage return without a line feed (line breaks are LF or CRLF)")
      } else if (c === "/" && this.src[this.pos + 1] === "/") {
        const nl = this.src.indexOf("\n", this.pos)
        const end = nl < 0 ? this.src.length : nl
        this.checkCommentText(this.pos, end)
        if (this.locations) this.comments.push([this.pos, end])
        this.pos = end
      } else if (c === "/" && this.src[this.pos + 1] === "*") {
        this.skipBlockComment()
      } else if (c === "/") {
        this.fail("unexpected '/' (comments are // or /* */)")
      } else {
        return
      }
    }
  }

  private skipBlockComment() {
    const open = this.pos
    let depth = 0
    while (this.pos < this.src.length) {
      if (this.src.startsWith("/*", this.pos)) {
        depth++
        this.pos += 2
      } else if (this.src.startsWith("*/", this.pos)) {
        this.pos += 2
        if (--depth === 0) {
          if (this.locations) this.comments.push([open, this.pos])
          return this.checkCommentText(open, this.pos)
        }
      } else {
        this.pos++
      }
    }
    this.fail("unterminated block comment", open)
  }

  /**
   * Comments are where "Trojan Source" attacks hide reordered text, and where
   * control characters (ESC, CSI, NUL) can rewrite what a terminal shows.
   * Allowed: tab, and in block comments line breaks (CR only before LF).
   */
  private checkCommentText(start: number, end: number) {
    for (let i = start; i < end; i++) {
      const c = this.src.charCodeAt(i)
      if (isBidiControl(c)) this.fail(`raw bidirectional control character U+${hex4(c)} in comment`, i)
      if (!isControl(c) || c === 9 || c === 10) continue
      if (c === 13 && this.src.charCodeAt(i + 1) === 10) continue
      this.fail(c === 13 ? "carriage return without a line feed (line breaks are LF or CRLF)" : `raw control character U+${hex4(c)} in comment`, i)
    }
  }

  private readIdent(): string {
    const start = this.pos
    while (this.pos < this.src.length && isIdentChar(this.src.charCodeAt(this.pos))) this.pos++
    return this.src.slice(start, this.pos)
  }

  private peek(): string | undefined {
    return this.src[this.pos]
  }

  private eof(): boolean {
    return this.pos >= this.src.length
  }

  private expect(ch: string, message: string) {
    if (this.peek() !== ch) this.fail(`${message}, found ${describe(this.peek())}`)
    this.pos++
  }

  private fail(reason: string, at: number = this.pos): never {
    const p = locate(this.src, at, this.origin)
    throw new HausSyntaxError(reason, p.offset, p.line, p.column)
  }
}

/** The number of code points: each surrogate pair counts once. */
const codePoints = (s: string): number => {
  let n = s.length
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) n--
  }
  return n
}

/** The value of a hex digit, or -1. */
const hexValue = (c: number): number =>
  c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1
