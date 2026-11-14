/**
 * The schema decoders under test (schema.ts). Each gets a file of lines
 * `SUITE TYPE HEX` (a value's haus text as hex-encoded UTF-8) and gives one
 * outcome per line: decode the value with the named type of the suite's
 * schema file, encode the result, and write its canonical form (spec §12).
 * TypeScript and Effect run in this process; the others are the programs
 * built by build.sh.
 */
import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { canonical, compileSchemaFile, parseAll } from "../../typescript/packages/haus/dist/index.js"
import * as h from "../../typescript/packages/haus/dist/schema.js"

/** `ok` with the canonical form of the encoded result, `err` (any reason), or a crash. */
export type Outcome = { readonly kind: "ok"; readonly text: string } | { readonly kind: "err"; readonly reason: string } | { readonly kind: "crash"; readonly reason: string }

export interface SchemaCase {
  readonly suite: string
  readonly type: string
  readonly text: string
}

export interface SchemaRunner {
  readonly name: string
  run(file: string, cases: readonly SchemaCase[]): Outcome[]
}

const root = new URL("../..", import.meta.url).pathname

export const caseLine = (c: SchemaCase) => `${c.suite} ${c.type} ${Buffer.from(c.text, "utf8").toString("hex")}`

function parseOutcome(line: string): Outcome {
  if (line.startsWith("ok ")) return { kind: "ok", text: line.slice(3) }
  if (line.startsWith("err")) return { kind: "err", reason: line.slice(4) }
  return { kind: "crash", reason: `unexpected output: ${line.slice(0, 200)}` }
}

/**
 * A runner that is a separate program: `program [...args] FILE`. When it
 * crashes or hangs, the cases are split in halves until the ones that crash
 * it are found.
 */
function external(name: string, program: string, args: readonly string[] = []): SchemaRunner {
  const runRange = (file: string, cases: readonly SchemaCase[]): Outcome[] => {
    const part = `${file}.${name}`
    writeLines(part, cases)
    const p = spawnSync(program, [...args, part], { maxBuffer: 1 << 30, encoding: "utf8", timeout: 600_000 })
    const lines = (p.stdout ?? "").split("\n").filter((l) => l !== "")
    if (p.status === 0 && lines.length === cases.length) return lines.map(parseOutcome)
    if (cases.length === 1) {
      const why = p.error ? String(p.error) : p.signal ? `signal ${p.signal}` : `exit ${p.status}, ${lines.length} lines`
      return [{ kind: "crash", reason: `CRASH (${why}): ${(p.stderr ?? "").trim().split("\n").slice(0, 3).join(" ").slice(0, 300)}` }]
    }
    const mid = cases.length >> 1
    return [...runRange(file, cases.slice(0, mid)), ...runRange(file, cases.slice(mid))]
  }
  return { name, run: runRange }
}

const writeLines = (file: string, cases: readonly SchemaCase[]) => writeFileSync(file, cases.map((c) => caseLine(c) + "\n").join(""))

/** The single value of a case's text, or why it isn't one. */
function single(text: string): { value: any } | { error: string } {
  try {
    const vs = parseAll(text)
    return vs.length === 1 ? { value: vs[0] } : { error: "not a single value" }
  } catch (e) {
    return { error: `not a single value: ${(e as Error).message}` }
  }
}

/** Every schema file of the fuzzer: the suite's and fuzz/schema's, by suite name. */
export function schemaTexts(dirs: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const dir of dirs) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".schema.haus")) out.set(f.replace(".schema.haus", ""), readFileSync(join(dir, f), "utf8"))
    }
  }
  return out
}

/** A runner in this process: decode and encode for one case, or throw. */
function inProcess(name: string, roundtrip: (suite: string, type: string, value: any) => Outcome): SchemaRunner {
  return {
    name,
    run: (_file, cases) =>
      cases.map((c) => {
        const v = single(c.text)
        if ("error" in v) return { kind: "err", reason: v.error }
        try {
          return roundtrip(c.suite, c.type, v.value)
        } catch (e) {
          return { kind: "crash", reason: `CRASH: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`.slice(0, 300) }
        }
      }),
  }
}

/** @haus-fmt/haus: `compileSchemaFile`, `h.decode`, `h.encode`. */
export function typescriptRunner(texts: ReadonlyMap<string, string>): SchemaRunner {
  const compiled = new Map([...texts].map(([s, t]) => [s, compileSchemaFile(t).schemas as Record<string, h.Schema<unknown>>]))
  return inProcess("typescript", (suite, type, value) => {
    const schema = compiled.get(suite)?.[type]
    if (!schema) return { kind: "crash", reason: `CRASH: no type ${suite}.${type}` }
    let decoded: unknown
    try {
      decoded = h.decode(schema, value)
    } catch (e) {
      if (e instanceof h.HausDecodeError) return { kind: "err", reason: e.message }
      throw e
    }
    try {
      return { kind: "ok", text: canonical(h.encode(schema, decoded)) }
    } catch (e) {
      // Encoding what was decoded must work (spec §15): an encode error is a finding.
      if (e instanceof h.HausEncodeError) return { kind: "crash", reason: `CRASH: encoding failed: ${e.message}` }
      throw e
    }
  })
}

/** @haus-fmt/effect: `Haus.compileSchemaFile`, `decodeValue`, `encodeValue`. */
export async function effectRunner(texts: ReadonlyMap<string, string>): Promise<SchemaRunner> {
  const dir = join(root, "typescript/packages/effect")
  const Haus = await import(pathToFileURL(join(dir, "dist/index.js")).href)
  const effectEntry = createRequire(join(dir, "package.json")).resolve("effect")
  const { Effect, Exit, Cause } = await import(pathToFileURL(effectEntry).href)
  const compiled = new Map([...texts].map(([s, t]) => [s, Haus.compileSchemaFile(t).schemas]))
  return inProcess("effect", (suite, type, value) => {
    const schema = compiled.get(suite)?.[type]
    if (!schema) return { kind: "crash", reason: `CRASH: no type ${suite}.${type}` }
    const decoded = Effect.runSyncExit(Haus.decodeValue(schema)(value))
    if (Exit.isFailure(decoded)) {
      if (Cause.hasDies(decoded.cause)) return { kind: "crash", reason: `CRASH: ${String(decoded.cause).slice(0, 300)}` }
      return { kind: "err", reason: String(decoded.cause).slice(0, 300) }
    }
    const encoded = Effect.runSyncExit(Haus.encodeValue(schema)(decoded.value))
    if (Exit.isFailure(encoded)) return { kind: "crash", reason: `CRASH: encoding failed: ${String(encoded.cause).slice(0, 300)}` }
    return { kind: "ok", text: canonical(encoded.value) }
  })
}

export const lean = (types: string) => external("lean", join(root, "spec/lean/.lake/build/bin/haus-ref"), ["--schema-batch", types])
export const rust = () => external("rust", join(root, "fuzz/schema-rust/target/release/schema_runner"))
export const roc = () => external("roc", join(root, "fuzz/.build/roc-schema-runner"))
export const python = () => external("python", join(root, "python/.venv/bin/python"), [join(root, "python/fuzz/schema_runner.py")])
