/**
 * Inputs for differential testing: haus text written with varied formatting
 * (mostly valid), edge cases at the limits, and byte-level mutations of both.
 */

/** A seeded random number generator (mulberry32), so a run can be repeated. */
export class Rng {
  private state: number
  constructor(seed: number) {
    this.state = seed >>> 0
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  int(n: number): number {
    return Math.floor(this.next() * n)
  }
  chance(p: number): boolean {
    return this.next() < p
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!
  }
  times(max: number, f: () => string): string[] {
    return Array.from({ length: this.int(max + 1) }, f)
  }
}

// ── formatting ───────────────────────────────────────────────

const COMMENTS = ["// note\n", "// café 😀\t\n", "/* c */", "/* a /* nested */ b */", "/* multi\n   line */", "/**/", "// x\r\n"]

/** Whitespace between tokens: usually none or a space, sometimes line breaks and comments. */
function ws(r: Rng): string {
  const x = r.next()
  if (x < 0.45) return ""
  if (x < 0.75) return " "
  if (x < 0.85) return r.pick(["\n", "\t", "\r\n", "  ", "\n  "])
  return r.pick([" ", "\n"]) + r.pick(COMMENTS) + r.pick(["", " ", "\n"])
}

// ── leaves ───────────────────────────────────────────────────

const digits = (r: Rng, n: number, alphabet = "0123456789") =>
  Array.from({ length: n }, () => r.pick([...alphabet])).join("")

function number(r: Rng): string {
  const sign = r.chance(0.2) ? "-" : ""
  switch (r.int(10)) {
    case 0: return sign + "0"
    case 1: return sign + (1 + r.int(9)) + digits(r, r.int(6))
    case 2: return sign + "1_000" + (r.chance(0.5) ? "_000" : "")
    case 3: return sign + r.int(100) + "." + digits(r, 1 + r.int(4))
    case 4: return sign + (1 + r.int(9)) + r.pick(["e", "E"]) + r.pick(["", "+", "-"]) + (1 + r.int(400))
    case 5: return sign + "0x" + digits(r, 1 + r.int(6), "0123456789abcdefABCDEF")
    case 6: return sign + "0b" + digits(r, 1 + r.int(12), "01")
    case 7: return sign + (1 + r.int(9)) + digits(r, 15 + r.int(30)) // beyond 2^53
    case 8: return sign + "19.90"
    default: return sign + r.pick(["1e6144", "1e-6144", "1e6145", "0x" + "f".repeat(997), "1" + "0".repeat(999), "1" + "0".repeat(1000)])
  }
}

const STRING_PARTS = ["a", "hello", " ", "é", "😀", "中文", "\\n", "\\t", '\\"', "\\\\", "\\u{41}", "\\u{1F600}", "\\u{0}", "\\u{1B}", "\\u{7F}", "\\u{85}", "\\u{202E}", "\\r", "'", "/*", "*/", "//", ","]

function basicString(r: Rng): string {
  return '"' + r.times(5, () => r.pick(STRING_PARTS)).join("") + '"'
}

function blockString(r: Rng, indent: string): string {
  const nl = r.chance(0.2) ? "\r\n" : "\n"
  const inner = indent + r.pick(["", "  ", "\t"])
  const lines = r.times(3, () => r.pick(["", inner + "line", inner + 'say "hi" \\"""', inner + "  deeper", inner + "tab\there", inner + "😀 \\u{1B}"]))
  return '"""' + r.pick(["", " "]) + nl + lines.map((l) => l + nl).join("") + inner + '"""'
}

function bytes(r: Rng): string {
  return 'x"' + r.times(4, () => digits(r, 2, "0123456789abcdefABCDEF") + r.pick(["", " ", "\t"])).join("") + '"'
}

const KEYS = ["a", "b", "id", "_x", "snake_case", "camelCase", "k1"]
const QUOTED_KEYS = ['"x-y"', '""', '"__proto__"', '"Upper"', '"café"', '"with space"', '"\\u{41}"']

function key(r: Rng): string {
  return r.chance(0.8) ? r.pick(KEYS) : r.pick(QUOTED_KEYS)
}

const TAGS = ["None", "Some", "True", "False", "Point", "Circle", "Tag", "A", "Ok", "Err"]

// ── containers ───────────────────────────────────────────────

function list(r: Rng, open: string, close: string, items: string[]): string {
  if (items.length === 0) return open + ws(r) + close
  const sep = () => ws(r) + "," + ws(r)
  return open + ws(r) + items.join(sep()) + (r.chance(0.3) ? sep() : ws(r)) + close
}

function record(r: Rng, depth: number): string {
  const fields: string[] = []
  const used = new Set<string>()
  for (let i = r.int(4); i > 0; i--) {
    let k = key(r)
    if (used.has(k) && r.chance(0.9)) continue // duplicates are rare, and invalid
    used.add(k)
    fields.push(k + ws(r) + ":" + ws(r) + value(r, depth + 1))
  }
  return list(r, "{", "}", fields)
}

function value(r: Rng, depth: number): string {
  const leaf = depth > 4 || r.chance(0.35)
  const x = r.int(leaf ? 5 : 9)
  switch (x) {
    case 0: return number(r)
    case 1: return r.chance(0.85) ? basicString(r) : blockString(r, "  ".repeat(depth))
    case 2: return bytes(r)
    case 3: return r.pick(TAGS)
    case 4: return r.chance(0.5) ? number(r) : basicString(r)
    case 5: return list(r, "[", "]", r.times(4, () => value(r, depth + 1)))
    case 6: return record(r, depth)
    case 7: {
      const args = Array.from({ length: 1 + r.int(3) }, () => value(r, depth + 1))
      return r.pick(TAGS) + r.pick(["", "", " ", "\t"]) + list(r, "(", ")", args)
    }
    default: return r.pick(TAGS) + r.pick([" ", " ", "", "\t"]) + record(r, depth)
  }
}

/** Nesting right at and just past the depth limit (256). */
function deep(r: Rng): string {
  const n = r.pick([255, 256, 257])
  const open = r.pick(["[", "{ a: ", "Some("])
  const close = { "[": "]", "{ a: ": " }", "Some(": ")" }[open]!
  return open.repeat(n) + "1" + close.repeat(n)
}

/** A whole file: an optional byte order mark, then zero or more values. */
export function file(r: Rng): string {
  if (r.chance(0.02)) return deep(r)
  const bom = r.chance(0.03) ? "\uFEFF" : ""
  const values = Array.from({ length: r.pick([0, 1, 1, 1, 2, 3]) }, () => value(r, 0))
  const sep = () => ws(r) + "," + ws(r)
  const end = r.chance(0.05) ? "// last line without a line break" : ""
  return bom + ws(r) + values.join(sep()) + (values.length && r.chance(0.4) ? sep() : ws(r)) + end
}

// ── mutations ────────────────────────────────────────────────

const enc = new TextEncoder()

/** Characters and byte sequences that tend to sit on the edge of the grammar. */
const SNIPPETS: Uint8Array[] = [
  '"', "\\", "/", "*", ",", ":", "{", "}", "[", "]", "(", ")", "\r", "\n", "\t", " ", "_", ".", "e", "x", "0", "-",
  '"""', "//", "/*", "*/", "\u0000", "\u001b", "\u007f", "\u0085", "\u009b", "\u202e", "\u2066", "\ufeff", "true", "null",
].map((s) => enc.encode(s)).concat([
  Uint8Array.of(0xff), Uint8Array.of(0x80), Uint8Array.of(0xc0, 0x80), Uint8Array.of(0xed, 0xa0, 0x80), Uint8Array.of(0xf4, 0x90, 0x80, 0x80),
])

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** One to three random edits: delete, insert a snippet, duplicate a slice, or cut short. */
export function mutate(r: Rng, input: Uint8Array): Uint8Array {
  let b = input
  for (let n = 1 + r.int(3); n > 0; n--) {
    const at = r.int(b.length + 1)
    switch (r.int(5)) {
      case 0: b = concat(b.subarray(0, at), b.subarray(at + 1 + r.int(3))); break
      case 1:
      case 2: b = concat(b.subarray(0, at), r.pick(SNIPPETS), b.subarray(at)); break
      case 3: {
        const end = Math.min(b.length, at + 1 + r.int(8))
        b = concat(b.subarray(0, end), b.subarray(at, end), b.subarray(end))
        break
      }
      default: b = b.subarray(0, at)
    }
  }
  return b
}

/** A test input: generated text, half of the time mutated, sometimes starting from a seed. */
export function input(r: Rng, seeds: readonly Uint8Array[]): Uint8Array {
  const base = seeds.length && r.chance(0.1) ? r.pick(seeds) : enc.encode(file(r))
  return r.chance(0.5) ? mutate(r, base) : base
}
