/**
 * Differential testing of the std/time checkers: generated strings through
 * the Lean model (spec/lean/Haus/Time) and the TypeScript, Rust and Roc
 * checkers, reporting where they disagree. See ../README.md.
 *
 *   node fuzz/src/time.ts [--count N] [--seed S] [--out DIR]
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { checkStdTime, STD_TIME_TYPES, type StdTimeType } from "../../typescript/packages/haus/dist/index.js"
import { Rng } from "./generate.ts"

const { values: args } = parseArgs({
  options: {
    count: { type: "string", default: "20000" },
    seed: { type: "string", default: String(Date.now() % 1_000_000) },
    out: { type: "string", default: "fuzz/.out/time" },
  },
})
const count = Number(args.count)
const seed = Number(args.seed)
const out = args.out!
const root = new URL("../..", import.meta.url).pathname

// ── generating ───────────────────────────────────────────────

const pad = (n: number, width: number) => String(n).padStart(width, "0")

/** A number for a field: usually in range, often at or just past its edges. */
function field(r: Rng, width: number, edges: readonly number[], max: number): string {
  if (r.chance(0.4)) return pad(r.pick(edges), width)
  if (r.chance(0.05)) return pad(r.int(10 ** width), width)
  return pad(r.int(max + 1), width)
}

const year = (r: Rng) => field(r, 4, [0, 1, 4, 100, 400, 1900, 2000, 2024, 2026, 2100, 2400, 9999], 9999)
const month = (r: Rng) => field(r, 2, [0, 1, 2, 4, 6, 9, 11, 12, 13], 12)
const day = (r: Rng) => field(r, 2, [0, 1, 28, 29, 30, 31, 32], 31)
const date = (r: Rng) => `${year(r)}-${month(r)}-${day(r)}`

function fraction(r: Rng): string {
  if (r.chance(0.6)) return ""
  return "." + Array.from({ length: r.pick([0, 1, 2, 3, 6, 8, 9, 9, 10, 12]) }, () => r.int(10)).join("")
}

const time = (r: Rng) =>
  `${field(r, 2, [0, 23, 24, 25], 23)}:${field(r, 2, [0, 59, 60, 61], 59)}:${field(r, 2, [0, 59, 60, 61], 59)}${fraction(r)}`

function offset(r: Rng): string {
  if (r.chance(0.3)) return "Z"
  if (r.chance(0.05)) return r.pick(["z", "-00:00", "+0100", "+01", "+01:00:00", "UTC", "+1:00"])
  return `${r.pick(["+", "-"])}${field(r, 2, [0, 1, 14, 23, 24, 99], 23)}:${field(r, 2, [0, 30, 59, 60], 59)}`
}

const ZONE_PARTS = ["Europe", "Lisbon", "America", "Argentina", "Buenos_Aires", "Etc", "GMT+5", "GMT-14", "UTC", "Z",
  "Port-au-Prince", "a", "A1", ".", "..", "...", ".hidden", "x.y", "", "1abc", "_x", "-x", "é", "Ünicode", "a b", "]", "[", ":", "\\"]

function zone(r: Rng): string {
  if (r.chance(0.2)) return offset(r)
  if (r.chance(0.05)) return "a".repeat(r.pick([254, 255, 256])) + (r.chance(0.5) ? "/b" : "")
  const parts = Array.from({ length: 1 + r.int(3) }, () => (r.chance(0.7) ? r.pick(ZONE_PARTS.slice(0, 12)) : r.pick(ZONE_PARTS)))
  return (r.chance(0.05) ? "/" : "") + parts.join("/") + (r.chance(0.05) ? "/" : "")
}

const BIG = [0, 1, 7, 59, 60, 4294967295, 4294967296, 9007199254740991, 9007199254740992, 104249991374, 104249991375,
  2502085904094, 2502085904095, 150119154561465, 150119154561466]

/** A component's number: sometimes with leading zeros, or (for a zero component) zeros only. */
function count_(r: Rng, zero: boolean): string {
  if (zero) return r.chance(0.8) ? "0" : r.pick(["00", "000", "01"])
  if (r.chance(0.1)) return "9".repeat(r.pick([20, 25, 40, 309, 400]))
  const n = r.chance(0.5) ? String(r.pick(BIG)) : String(r.int(1000))
  return r.chance(0.15) ? r.pick(["0", "0", "00"]) + n : n
}

/** A fraction of zeros, sometimes ending in a digit that isn't. */
const zeroFraction = (r: Rng) =>
  r.chance(0.5) ? "" : "." + "0".repeat(r.int(9)) + (r.chance(0.2) ? String(1 + r.int(9)) : "0")

function duration(r: Rng): string {
  // Zero durations, often signed: `-` is only allowed before a duration that isn't zero.
  const zero = r.chance(0.2)
  // Otherwise often some components zero among ones that aren't: only zero seconds alone are allowed.
  const mixed = !zero && r.chance(0.35)
  const isZero = () => zero || (mixed && r.chance(0.4))
  // Zero seconds alone (the zero duration `PT0S`, with or without a fraction), or with a fraction that isn't zero.
  const lone = r.chance(zero ? 0.4 : mixed ? 0.15 : 0)
  const date = lone ? "" : ["Y", "M", "W", "D"].filter(() => r.chance(0.35)).map((u) => count_(r, isZero()) + u).join("")
  const timeUnits = lone ? ["S"] : ["H", "M", "S"].filter(() => r.chance(0.35))
  const component = (u: string) => {
    const z = isZero()
    const frac = u === "S" || r.chance(0.05) ? (z ? zeroFraction(r) : fraction(r)) : ""
    return count_(r, z) + frac + u
  }
  const time = timeUnits.map(component).join("")
  const t = time !== "" || r.chance(0.1) ? "T" + time : ""
  const sign = r.chance(zero ? 0.6 : 0.2) ? "-" : r.chance(0.03) ? "+" : ""
  return sign + (r.chance(0.02) ? "p" : "P") + date + t
}

/** A string meant for `type`: built from its parts, usually well formed. */
function valueFor(r: Rng, type: StdTimeType): string {
  switch (type) {
    case "Date": return date(r)
    case "Time": return time(r)
    case "DateTime": return `${date(r)}${r.pick(["T", "T", "T", "T", "t", " "])}${time(r)}`
    case "Instant": return `${date(r)}T${time(r)}${offset(r)}`
    case "ZonedDateTime": return `${date(r)}T${time(r)}${offset(r)}[${zone(r)}]${r.chance(0.03) ? "[u-ca=iso8601]" : ""}`
    case "Duration": return duration(r)
    case "YearMonth": return `${year(r)}-${month(r)}`
    case "TimeZone": return zone(r)
  }
}

const NOISE = ["0", "9", "-", "+", ":", ".", "T", "t", "Z", "z", "P", "S", "M", "D", "/", "[", "]", " ", "\0", "é", "😀", "\n", "_"]

/** Small edits: a character removed, inserted or replaced, a slice repeated, the end cut off. */
function mutate(r: Rng, s: string): string {
  const cs = [...s]
  for (let k = 1 + r.int(2); k > 0; k--) {
    const at = r.int(cs.length + 1)
    switch (r.int(5)) {
      case 0: cs.splice(at, 1); break
      case 1: cs.splice(at, 0, r.pick(NOISE)); break
      case 2: cs.splice(at, 1, r.pick(NOISE)); break
      case 3: cs.splice(at, 0, ...cs.slice(at, at + 1 + r.int(4))); break
      case 4: cs.length = at; break
    }
  }
  return cs.join("")
}

interface Case {
  readonly type: StdTimeType
  readonly text: string
}

function generate(r: Rng): Case {
  const type = r.pick(STD_TIME_TYPES)
  // Sometimes a string made for another type: the checks must not be fooled by near misses.
  const text = valueFor(r, r.chance(0.1) ? r.pick(STD_TIME_TYPES) : type)
  return { type, text: r.chance(0.4) ? mutate(r, text) : text }
}

// ── running ──────────────────────────────────────────────────

type Outcome = "ok" | "no" | string

const hex = (s: string) => Buffer.from(s, "utf8").toString("hex")

/** A runner that is a separate program: `program [...args] FILE`, one line per case. */
function external(program: string, args: readonly string[] = []): (file: string, cases: readonly Case[]) => Outcome[] {
  return (file, cases) => {
    const p = spawnSync(program, [...args, file], { maxBuffer: 1 << 30, encoding: "utf8" })
    if (p.status !== 0) return cases.map(() => `CRASH: ${(p.stderr || String(p.signal)).trim().split("\n")[0]}`)
    const lines = p.stdout.split("\n").filter((l) => l !== "")
    if (lines.length !== cases.length) throw new Error(`${program}: ${lines.length} results for ${cases.length} cases`)
    return lines
  }
}

const runners: ReadonlyArray<{ readonly name: string; run(file: string, cases: readonly Case[]): Outcome[] }> = [
  { name: "lean", run: external(join(root, "spec/lean/.lake/build/bin/haus-ref"), ["--time-batch"]) },
  { name: "typescript", run: (_f, cases) => cases.map((c) => (checkStdTime(c.type, c.text) === undefined ? "ok" : "no")) },
  { name: "rust", run: external(join(root, "rust/target/release/examples/time_runner")) },
  { name: "roc", run: external(join(root, "fuzz/.build/roc-time-runner")) },
]

/** results[case][runner] */
function runAll(cases: readonly Case[]): Outcome[][] {
  mkdirSync(out, { recursive: true })
  const file = join(out, "cases.txt")
  writeFileSync(file, cases.map((c) => `${c.type} ${hex(c.text)}\n`).join(""))
  const byRunner = runners.map((r) => r.run(file, cases))
  return cases.map((_, i) => byRunner.map((rs) => rs[i]!))
}

const disagrees = (rs: readonly Outcome[]) => new Set(rs).size > 1

/** The shortest text that still disagrees, by removing ever smaller slices. */
function shrink(c: Case): Case {
  let best = [...c.text]
  let size = Math.max(1, best.length >> 1)
  while (best.length > 0) {
    const candidates: Case[] = []
    for (let at = 0; at < best.length; at += size) {
      candidates.push({ type: c.type, text: [...best.slice(0, at), ...best.slice(at + size)].join("") })
    }
    const i = runAll(candidates).findIndex(disagrees)
    if (i >= 0) best = [...candidates[i]!.text]
    else if (size > 1) size >>= 1
    else break
  }
  return { type: c.type, text: best.join("") }
}

// ── run ──────────────────────────────────────────────────────

const BATCH = 500_000
const rng = new Rng(seed)
console.log(`seed ${seed}: ${count} std/time cases through ${runners.map((r) => r.name).join(", ")}`)
const accepted = new Map(STD_TIME_TYPES.map((t) => [t, 0]))
const total = new Map(STD_TIME_TYPES.map((t) => [t, 0]))
const found = new Map<string, Outcome[]>()
for (let done = 0; done < count; done += BATCH) {
  const cases = Array.from({ length: Math.min(BATCH, count - done) }, () => generate(rng))
  runAll(cases).forEach((rs, i) => {
    const c = cases[i]!
    total.set(c.type, total.get(c.type)! + 1)
    if (rs[0] === "ok") accepted.set(c.type, accepted.get(c.type)! + 1)
    if (!disagrees(rs)) return
    const small = shrink(c)
    const key = `${small.type}(${JSON.stringify(small.text)})`
    if (!found.has(key)) found.set(key, runAll([small])[0]!)
  })
}
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)
console.log(`${sum(accepted)} accepted, ${count - sum(accepted)} rejected (by lean)`)
for (const type of STD_TIME_TYPES) console.log(`  ${type.padEnd(14)} ${accepted.get(type)} accepted of ${total.get(type)}`)

if (found.size === 0) console.log("no disagreements")
for (const [key, rs] of found) {
  console.log(`\nDISAGREEMENT (shrunk): ${key}\n${rs.map((o, i) => `  ${runners[i]!.name.padEnd(10)} ${o}`).join("\n")}`)
}
writeFileSync(join(out, "failures.txt"), [...found.keys()].join("\n") + "\n")
process.exitCode = found.size ? 1 : 0
