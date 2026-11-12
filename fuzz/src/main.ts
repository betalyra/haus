/**
 * Differential testing: the same generated inputs through every haus parser,
 * reporting where they disagree. See ../README.md.
 *
 *   node fuzz/src/main.ts [--count N] [--seed S] [--out DIR]
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { input, Rng } from "./generate.ts"
import { runAll, runners, type Result } from "./runners.ts"

const { values: args } = parseArgs({
  options: {
    count: { type: "string", default: "2000" },
    seed: { type: "string", default: String(Date.now() % 1_000_000) },
    out: { type: "string", default: "fuzz/.out" },
  },
})
const count = Number(args.count)
const seed = Number(args.seed)
const out = args.out!
const BATCH = 5000

/** What must agree: accepted with these values, or rejected. A crash (line -1) never agrees. */
const outcome = (r: Result) => (r.ok ? `ok ${r.json}` : r.line < 0 ? "crash" : "err")
const disagrees = (rs: readonly Result[]) => new Set(rs.map(outcome)).size > 1
/** Positions of the errors, where every parser reports one (line 0: no position, e.g. invalid UTF-8). */
const positionsDiffer = (rs: readonly Result[]) =>
  rs.every((r) => !r.ok && r.line > 0) && new Set(rs.map((r) => (r.ok ? "" : `${r.line}:${r.column}`))).size > 1

/**
 * The smallest input that still disagrees, found by removing ever smaller
 * slices (delta debugging). Each round runs every parser once on a batch of
 * candidates.
 */
function shrink(bytes: Uint8Array): Uint8Array {
  let best = bytes
  let size = Math.max(1, best.length >> 1)
  for (let round = 0; round < 400 && best.length > 1; round++) {
    const candidates: Uint8Array[] = []
    for (let at = 0; at < best.length; at += size) {
      candidates.push(Uint8Array.from([...best.subarray(0, at), ...best.subarray(at + size)]))
    }
    const results = runAll(join(out, "shrink"), candidates)
    const i = results.findIndex(disagrees)
    if (i >= 0) best = candidates[i]!
    else if (size > 1) size >>= 1
    else break
  }
  return best
}

const show = (bytes: Uint8Array) => JSON.stringify(Buffer.from(bytes).toString("utf8"))

function describe(bytes: Uint8Array): string {
  const rs = runAll(join(out, "shrink"), [bytes])[0]!
  return [
    `input: ${show(bytes)}`,
    ...rs.map((r, i) => `  ${runners[i]!.name.padEnd(10)} ${r.ok ? `ok ${r.json}` : `err ${r.line}:${r.column} ${r.reason}`}`),
  ].join("\n")
}

// ── run ──────────────────────────────────────────────────────

const suite = join(new URL("../..", import.meta.url).pathname, "test-suite")
const seeds = ["valid", "invalid"].flatMap((d) =>
  readdirSync(join(suite, d)).filter((f) => f.endsWith(".haus")).map((f) => new Uint8Array(readFileSync(join(suite, d, f)))))

const rng = new Rng(seed)
const failures: Uint8Array[] = []
const seen = new Set<string>()
let accepted = 0
let positionMismatches = 0
const positionExamples: Uint8Array[] = []

console.log(`seed ${seed}: ${count} cases through ${runners.map((r) => r.name).join(", ")}`)
for (let done = 0; done < count; done += BATCH) {
  const cases = Array.from({ length: Math.min(BATCH, count - done) }, () => input(rng, seeds))
  const results = runAll(join(out, "cases"), cases)
  results.forEach((rs, i) => {
    if (rs[0]!.ok) accepted++
    if (disagrees(rs)) {
      const small = shrink(cases[i]!)
      const key = show(small)
      if (!seen.has(key)) {
        seen.add(key)
        failures.push(small)
      }
    } else if (positionsDiffer(rs)) {
      positionMismatches++
      if (positionExamples.length < 5) positionExamples.push(cases[i]!)
    }
  })
}

console.log(`${accepted} accepted, ${count - accepted} rejected (by lean)`)
mkdirSync(join(out, "failures"), { recursive: true })
if (failures.length === 0) console.log("no disagreements")
failures.forEach((f, i) => {
  const report = describe(f)
  writeFileSync(join(out, "failures", `${i}.haus`), f)
  writeFileSync(join(out, "failures", `${i}.txt`), report + "\n")
  console.log(`\nDISAGREEMENT ${i} (shrunk, saved to ${join(out, "failures", `${i}.haus`)}):\n${report}`)
})
console.log(`\n${positionMismatches} cases rejected by all, at different positions`)
for (const p of positionExamples) console.log(describe(p))
process.exitCode = failures.length ? 1 : 0
