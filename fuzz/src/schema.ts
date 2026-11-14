/**
 * Differential testing of schema decoding (spec §15): generated values are
 * decoded with every type of the schema suite (test-suite/schema, plus
 * fuzz/schema) and encoded again, by the Lean reference decoder and by each
 * binding. Accepting or rejecting, and the canonical form of what is encoded,
 * must agree. See ../README.md.
 *
 *   node fuzz/src/schema.ts [--count N] [--seed S] [--out DIR] [--runners lean,typescript,…]
 *   node fuzz/src/main.ts --schema …   (the same)
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { canonical, parseAll, type Value } from "../../typescript/packages/haus/dist/index.js"
import { Rng } from "./generate.ts"
import { Generator, type Env, type Type } from "./schema-gen.ts"
import {
  caseLine, effectRunner, lean, roc, rust, schemaTexts, typescriptRunner, type Outcome, type SchemaCase, type SchemaRunner,
} from "./schema-runners.ts"

const root = new URL("../..", import.meta.url).pathname
const SCHEMA_DIRS = [join(root, "test-suite/schema"), join(root, "fuzz/schema")]
const ALL_RUNNERS = ["lean", "typescript", "effect", "rust", "roc"]

export async function run(argv: readonly string[]): Promise<number> {
  const { values: args } = parseArgs({
    args: [...argv],
    options: {
      count: { type: "string", default: "5000" },
      seed: { type: "string", default: String(Date.now() % 1_000_000) },
      out: { type: "string", default: "fuzz/.out/schema" },
      runners: { type: "string", default: ALL_RUNNERS.join(",") },
      batch: { type: "string", default: "4000" },
      schema: { type: "boolean", default: false }, // from main.ts
    },
  })
  const count = Number(args.count)
  const seed = Number(args.seed)
  const out = args.out!
  mkdirSync(out, { recursive: true })

  // ── the types ──────────────────────────────────────────────
  // Resolved by spec/lean/scripts/schema-types.ts, for Lean and for the generator.
  const suites = SCHEMA_DIRS.flatMap((dir) => {
    const p = spawnSync(process.execPath, [join(root, "spec/lean/scripts/schema-types.ts"), dir], { encoding: "utf8", maxBuffer: 1 << 28 })
    if (p.status !== 0) throw new Error(`schema-types.ts ${dir}: ${p.stderr}`)
    return JSON.parse(p.stdout).suites as { name: string; defs?: [string, Type][]; error?: string }[]
  })
  const typesFile = join(out, "types.json")
  writeFileSync(typesFile, JSON.stringify({ suites }))
  const envs = new Map<string, Env>()
  const entries: { suite: string; type: string }[] = []
  for (const s of suites) {
    if (s.error !== undefined) throw new Error(`${s.name}: the schema file is rejected: ${s.error}`)
    envs.set(s.name, new Map(s.defs))
    // The types a case can name: the non-generic definitions.
    for (const [name] of s.defs!) if (/^[A-Z][A-Za-z0-9_]*$/.test(name)) entries.push({ suite: s.name, type: name })
  }
  const generators = new Map([...envs].map(([s, env]) => [s, new Generator(env)]))

  // ── the runners ────────────────────────────────────────────
  const wanted = args.runners!.split(",")
  if (wanted[0] !== "lean") throw new Error("--runners must start with lean, the reference")
  const texts = schemaTexts(SCHEMA_DIRS)
  const runners: SchemaRunner[] = []
  for (const name of wanted) {
    if (name === "lean") runners.push(lean(typesFile))
    else if (name === "typescript") runners.push(typescriptRunner(texts))
    else if (name === "effect") runners.push(await effectRunner(texts))
    else if (name === "rust") runners.push(rust())
    else if (name === "roc") runners.push(roc())
    else throw new Error(`unknown runner ${name} (${ALL_RUNNERS.join(", ")})`)
  }

  const runAll = (cases: readonly SchemaCase[]): Outcome[][] => {
    const file = join(out, "cases.txt")
    const byRunner = runners.map((r) => r.run(file, cases))
    return cases.map((_, i) => byRunner.map((rs) => rs[i]!))
  }

  // ── comparing ──────────────────────────────────────────────
  /** Per runner after lean: "=" if it agrees with lean, else its outcome's kind. The first is lean's kind. */
  const pattern = (c: SchemaCase, rs: readonly Outcome[]): string => {
    const ref = rs[0]!
    return rs.map((o, i) => (i === 0 ? ref.kind : agrees(ref, o) ? "=" : o.kind)).join(" ")
  }
  const disagrees = (p: string) => p.startsWith("crash") || p.split(" ").slice(1).some((x) => x !== "=")

  /** The smallest case with the same pattern of disagreement (see shrink). */
  const shrink = (c: SchemaCase, p: string) => shrinkCase(c, p, (cs) => runAll(cs).map((rs, i) => pattern(cs[i]!, rs)))

  // ── run ────────────────────────────────────────────────────
  const rng = new Rng(seed)
  const batch = Number(args.batch)
  console.log(`seed ${seed}: ${count} schema cases (${entries.length} types in ${envs.size} schema files) through ${runners.map((r) => r.name).join(", ")}`)
  const perType = new Map(entries.map((e) => [`${e.suite}.${e.type}`, { total: 0, ok: 0 }]))
  const found = new Map<string, { case: SchemaCase; pattern: string; outcomes: Outcome[]; hits: number }>()
  const leaks = new Map<string, { case: SchemaCase; reason: string; leaked: string }>()
  let accepted = 0
  for (let done = 0; done < count; done += batch) {
    const cases = Array.from({ length: Math.min(batch, count - done) }, () => {
      const e = rng.pick(entries)
      const deep = rng.chance(0.04) ? rng.pick([8, 30, 60, 100, 126, 200, 254, 300]) : 0
      const miss = rng.chance(0.55) ? 0 : rng.pick([0.03, 0.08, 0.2])
      const text = generators.get(e.suite)!.value(rng, { ref: e.type }, { miss, maxDepth: rng.pick([1, 2, 3, 4, 6]), deep })
      return { suite: e.suite, type: e.type, text }
    })
    const results = runAll(cases)
    results.forEach((rs, i) => {
      const c = cases[i]!
      const stat = perType.get(`${c.suite}.${c.type}`)!
      stat.total++
      if (rs[0]!.kind === "ok") (stat.ok++, accepted++)
      // An error inside a Secret must not show the value (spec §15).
      rs.forEach((o, k) => {
        if (o.kind !== "err" || !mentionsSecret(envs.get(c.suite)!, { ref: c.type })) return
        const leaked = secretParts(envs.get(c.suite)!, c.type, c.text).find((x) => o.reason.includes(x))
        const key = `${runners[k]!.name} ${c.suite}.${c.type}`
        if (leaked !== undefined && !leaks.has(key)) leaks.set(key, { case: c, reason: o.reason, leaked })
      })
      const p = pattern(c, rs)
      if (!disagrees(p)) return
      // One shrunk example per type and pattern, counting the others.
      const groupKey = `${c.suite}.${c.type} ${p}`
      const seen = found.get(groupKey)
      if (seen) return void seen.hits++
      const small = shrink(c, p)
      found.set(groupKey, { case: small, pattern: p, outcomes: runAll([small])[0]!, hits: 1 })
    })
    process.stdout.write(`  ${Math.min(done + batch, count)} cases, ${found.size} disagreements\n`)
  }

  console.log(`${accepted} accepted, ${count - accepted} rejected (by lean)`)
  for (const [k, s] of perType) console.log(`  ${k.padEnd(22)} ${String(s.ok).padStart(6)} accepted of ${s.total}`)
  if (found.size === 0) console.log("no disagreements")
  const report: string[] = []
  for (const [key, f] of found) {
    const lines = [
      `DISAGREEMENT ${key} (${f.hits} cases; shrunk)`,
      `  case: ${f.case.suite} ${f.case.type} ${JSON.stringify(f.case.text)}`,
      `  line: ${caseLine(f.case)}`,
      ...f.outcomes.map((o, i) => `  ${runners[i]!.name.padEnd(10)} ${o.kind === "ok" ? `ok ${o.text}` : `${o.kind} ${o.reason}`}`),
    ]
    report.push(lines.join("\n"))
    console.log("\n" + lines.join("\n"))
  }
  for (const [key, l] of leaks) {
    const lines = [
      `SECRET SHOWN IN AN ERROR: ${key}`,
      `  case: ${l.case.suite} ${l.case.type} ${JSON.stringify(l.case.text)}`,
      `  shows ${JSON.stringify(l.leaked)}: ${l.reason.slice(0, 300)}`,
    ]
    report.push(lines.join("\n"))
    console.log("\n" + lines.join("\n"))
  }
  writeFileSync(join(out, "failures.txt"), report.join("\n\n") + "\n")
  return found.size || leaks.size ? 1 : 0
}

// ── comparing with lean ──────────────────────────────────────

/** Whether a runner's outcome agrees with lean's: the same kind, and for ok the same canonical form. */
function agrees(ref: Outcome, o: Outcome): boolean {
  if (ref.kind === "crash" || o.kind !== ref.kind) return false
  return o.kind === "err" || (o.kind === "ok" && ref.kind === "ok" && o.text === ref.text)
}

// ── secrets ──────────────────────────────────────────────────

const secretTypes = new WeakMap<Env, Map<string, boolean>>()

/** Whether a value of `t` can contain a `Secret`. */
export function mentionsSecret(env: Env, t: Type, seen: Set<string> = new Set()): boolean {
  if ("secret" in t) return true
  if ("ref" in t) {
    let memo = secretTypes.get(env)
    if (!memo) secretTypes.set(env, (memo = new Map()))
    if (memo.has(t.ref)) return memo.get(t.ref)!
    if (seen.has(t.ref)) return false
    seen.add(t.ref)
    const r = mentionsSecret(env, env.get(t.ref)!, seen)
    memo.set(t.ref, r)
    return r
  }
  if ("array" in t) return mentionsSecret(env, t.array, seen)
  if ("map" in t) return mentionsSecret(env, t.map, seen)
  if ("maybe" in t) return mentionsSecret(env, t.maybe, seen)
  if ("record" in t) return t.record.fields.some((f) => mentionsSecret(env, f.type, seen))
  if ("variant" in t) return t.variant.cases.some((k) => k.payload !== "none" && ("record" in k.payload ? k.payload.record.fields.some((f) => mentionsSecret(env, f.type, seen)) : k.payload.positional.some((x) => mentionsSecret(env, x, seen))))
  return false
}

/**
 * The strings, numbers and keys at secret places of a case's value (at least
 * 5 characters, so that they don't turn up in a message by chance).
 */
export function secretParts(env: Env, type: string, text: string): string[] {
  let v: Value
  try {
    const vs = parseAll(text)
    if (vs.length !== 1) return []
    v = vs[0]!
  } catch {
    return []
  }
  const out = new Set<string>()
  const all = (x: Value): void => {
    if (x.kind === "string") out.add(x.value)
    else if (x.kind === "number") out.add(x.text)
    else if (x.kind === "array") x.items.forEach(all)
    else if (x.kind === "record") for (const [k, y] of x.fields) (out.add(k), all(y))
    else if (x.kind === "variant") x.args.forEach(all)
  }
  const walk = (t: Type, x: Value, depth: number): void => {
    if (depth > 300) return
    if ("secret" in t) return all(x)
    if ("ref" in t) return walk(env.get(t.ref)!, x, depth + 1)
    if ("array" in t && x.kind === "array") return x.items.forEach((y) => walk(t.array, y, depth + 1))
    if ("map" in t && x.kind === "record") return x.fields.forEach((y) => walk(t.map, y, depth + 1))
    if ("maybe" in t && x.kind === "variant") return x.args.forEach((y) => walk(t.maybe, y, depth + 1))
    const fields = (fs: RecordFields, y: Value | undefined) => {
      if (y?.kind === "record") for (const f of fs) if (y.fields.has(f.key)) walk(f.type, y.fields.get(f.key)!, depth + 1)
    }
    if ("record" in t) return fields(t.record.fields, x)
    if ("variant" in t && x.kind === "variant") {
      const p = t.variant.cases.find((k) => k.tag === x.tag)?.payload
      if (p === undefined || p === "none") return
      if ("record" in p) return fields(p.record.fields, x.args[0])
      p.positional.forEach((pt, i) => x.args[i] !== undefined && walk(pt, x.args[i]!, depth + 1))
    }
  }
  walk({ ref: type }, v, 0)
  return [...out].filter((x) => [...x].length >= 5)
}

type RecordFields = readonly { readonly key: string; readonly type: Type }[]

// ── shrinking ────────────────────────────────────────────────

/**
 * A smaller case with the same pattern of disagreement. First the canonical
 * form of the value, then smaller values: elements, fields and arguments
 * removed, a node replaced by one of its children, strings cut. If the
 * canonical form doesn't disagree (the spelling matters), slices of the text
 * are removed instead.
 */
function shrinkCase(c: SchemaCase, p: string, patterns: (cs: readonly SchemaCase[]) => string[]): SchemaCase {
  const withText = (text: string) => ({ suite: c.suite, type: c.type, text })
  let value: Value | undefined
  try {
    const vs = parseAll(c.text)
    if (vs.length === 1) value = vs[0]
  } catch {}
  if (value && patterns([withText(canonical(value))])[0] === p) {
    for (let round = 0; round < 200; round++) {
      const seen = new Set<string>()
      const candidates = [...smaller(value)].map(canonical).filter((t) => !seen.has(t) && seen.add(t)).sort((x, y) => x.length - y.length).slice(0, 400)
      if (candidates.length === 0) break
      const ps = patterns(candidates.map(withText))
      const i = ps.findIndex((q) => q === p)
      if (i < 0) break
      value = parseAll(candidates[i]!)[0]!
    }
    return withText(canonical(value))
  }
  let best = [...c.text]
  let size = Math.max(1, best.length >> 1)
  for (let round = 0; round < 400 && best.length > 1; round++) {
    const candidates: SchemaCase[] = []
    for (let at = 0; at < best.length; at += size) candidates.push(withText([...best.slice(0, at), ...best.slice(at + size)].join("")))
    const i = patterns(candidates).findIndex((q) => q === p)
    if (i >= 0) best = [...candidates[i]!.text]
    else if (size > 1) size >>= 1
    else break
  }
  return withText(best.join(""))
}

/** Values one step smaller than `v`. */
function* smaller(v: Value): IterableIterator<Value> {
  switch (v.kind) {
    case "string": {
      const cs = [...v.value]
      if (cs.length > 0) {
        yield { kind: "string", value: "" }
        yield { kind: "string", value: cs.slice(0, cs.length >> 1).join("") }
        yield { kind: "string", value: cs.slice(cs.length >> 1).join("") }
        for (let i = 0; i < cs.length && i < 40; i++) yield { kind: "string", value: [...cs.slice(0, i), ...cs.slice(i + 1)].join("") }
      }
      return
    }
    case "bytes":
      if (v.bytes.length > 0) {
        yield { kind: "bytes", bytes: v.bytes.subarray(0, v.bytes.length >> 1) }
        yield { kind: "bytes", bytes: v.bytes.subarray(1) }
      }
      return
    case "number":
      if (v.text !== "0") yield { kind: "number", text: "0" }
      if (v.text.length > 1) yield { kind: "number", text: "1" }
      return
    case "array":
      yield* v.items
      for (let i = 0; i < v.items.length; i++) yield { kind: "array", items: v.items.filter((_, j) => j !== i) }
      for (let i = 0; i < v.items.length; i++) for (const x of smaller(v.items[i]!)) yield { kind: "array", items: v.items.map((y, j) => (j === i ? x : y)) }
      return
    case "record": {
      const fs = [...v.fields]
      yield* v.fields.values()
      for (const [k] of fs) yield { kind: "record", fields: new Map(fs.filter(([j]) => j !== k)) }
      for (const [k, x] of fs) for (const y of smaller(x)) yield { kind: "record", fields: new Map(fs.map(([j, z]) => [j, j === k ? y : z])) }
      return
    }
    case "variant":
      yield* v.args
      for (let i = 0; i < v.args.length; i++) yield { kind: "variant", tag: v.tag, args: v.args.filter((_, j) => j !== i) }
      for (let i = 0; i < v.args.length; i++) for (const x of smaller(v.args[i]!)) yield { kind: "variant", tag: v.tag, args: v.args.map((y, j) => (j === i ? x : y)) }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await run(process.argv.slice(2))
