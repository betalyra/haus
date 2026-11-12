/**
 * The parsers under test. Each gets a directory of cases (00000.haus, …) and
 * returns one result per case. TypeScript runs in this process; the others
 * are the binaries built by build.sh.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { HausSyntaxError, parseAll } from "../../typescript/packages/haus/dist/index.js"

export type Result =
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly line: number; readonly column: number; readonly reason: string }

export interface Runner {
  readonly name: string
  run(dir: string, cases: readonly Uint8Array[]): Result[]
}

const root = new URL("../..", import.meta.url).pathname

/** JSON with object keys sorted, so field order doesn't matter. */
export function normalize(json: string): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(sort)
    : x !== null && typeof x === "object" ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sort(v)]))
    : x
  return JSON.stringify(sort(JSON.parse(json)))
}

function parseLine(line: string): Result {
  if (line.startsWith("ok ")) return { ok: true, json: normalize(line.slice(3)) }
  const m = /^err (\d+) (\d+) ?(.*)$/s.exec(line)
  if (!m) throw new Error(`unexpected runner output: ${line.slice(0, 200)}`)
  return { ok: false, line: Number(m[1]), column: Number(m[2]), reason: m[3]! }
}

/** A runner that is a separate program: `program [...args] DIR N`. */
function external(name: string, program: string, args: readonly string[] = []): Runner {
  return {
    name,
    run(dir, cases) {
      const p = spawnSync(program, [...args, dir, String(cases.length)], { maxBuffer: 1 << 30, encoding: "utf8" })
      if (p.status !== 0) throw new Error(`${name} failed (${p.status}): ${p.stderr.slice(0, 500)}`)
      const lines = p.stdout.split("\n").filter((l) => l !== "")
      if (lines.length !== cases.length) throw new Error(`${name}: ${lines.length} results for ${cases.length} cases`)
      return lines.map((l) => {
        try {
          return parseLine(l)
        } catch (e) {
          throw new Error(`${name}: ${(e as Error).message}`)
        }
      })
    },
  }
}

/** The suite's JSON encoding (test-suite/README.md). */
function canonical(v: any): unknown {
  switch (v.kind) {
    case "string": return v.value
    case "number": return { num: v.text }
    case "bytes": return { bytes: Buffer.from(v.bytes).toString("hex") }
    case "array": return v.items.map(canonical)
    case "record": return { rec: Object.fromEntries([...v.fields].map(([k, x]: [string, unknown]) => [k, canonical(x)])) }
    case "variant": return v.args.length ? { tag: v.tag, args: v.args.map(canonical) } : { tag: v.tag }
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

const typescript: Runner = {
  name: "typescript",
  run: (_dir, cases) =>
    cases.map((bytes): Result => {
      let text: string
      try {
        text = utf8.decode(bytes)
      } catch {
        return { ok: false, line: 0, column: 0, reason: "invalid UTF-8" }
      }
      try {
        return { ok: true, json: normalize(JSON.stringify(parseAll(text).map(canonical))) }
      } catch (e) {
        if (e instanceof HausSyntaxError) return { ok: false, line: e.line, column: e.column, reason: e.reason }
        throw e
      }
    }),
}

export const runners: readonly Runner[] = [
  external("lean", join(root, "spec/lean/.lake/build/bin/haus-ref"), ["--batch"]),
  external("rust", join(root, "rust/target/release/examples/fuzz_runner")),
  external("roc", join(root, "fuzz/.build/roc-runner")),
  typescript,
]

/** Writes the cases to `dir` and runs every parser on them: results[case][runner]. */
export function runAll(dir: string, cases: readonly Uint8Array[]): Result[][] {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  cases.forEach((c, i) => writeFileSync(join(dir, `${String(i).padStart(5, "0")}.haus`), c))
  const byRunner = runners.map((r) => r.run(dir, cases))
  return cases.map((_, i) => byRunner.map((rs) => rs[i]!))
}
