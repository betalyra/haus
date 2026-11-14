/**
 * Resolves the schema suite's schema files for the Lean reference decoder.
 *
 *   node spec/lean/scripts/schema-types.ts [SUITE_DIR] > spec/lean/schema-suite.json
 *
 * Each `SUITE_DIR/NAME.schema.haus` (default: test-suite/schema) is parsed and
 * resolved by the TypeScript binding's schema-file parser
 * (typescript/packages/haus, built to dist/ by `pnpm build` or fuzz/build.sh;
 * set HAUS_TS_DIST to use another build). Every named type the file's
 * definitions reach is written out, generic ones applied to their arguments,
 * in the JSON form that `haus-ref --schema-suite` reads (spec/lean/Main.lean):
 *
 *   { "suites": [ { "name": "types", "defs": [["Ints", T], ["List(Int)", T], …] } ] }
 *
 *   T = {"builtin": "Int"} | {"time": "Date"} | {"array": T} | {"map": T}
 *     | {"maybe": T} | {"secret": T} | {"ref": KEY}
 *     | {"record": {"closed": B, "fields": [{"key": K, "optional": B, "type": T}]}}
 *     | {"variant": {"closed": B, "cases": [{"tag": TAG, "payload": P}]}}
 *   P = "none" | {"record": {"closed": B, "fields": […]}} | {"positional": [T]}
 *
 * Attributes are left out: decoding never reads them (spec §15). The script
 * checks that on the TypeScript side too: the file with its attributes
 * removed must resolve to the same types. A file the parser rejects is
 * written as `{ "name": …, "error": … }`, and its cases are reported as
 * skipped. The output depends only on the schema files, so running it again
 * gives the same file.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"

const root = new URL("../../..", import.meta.url).pathname
const dist = resolvePath(process.env.HAUS_TS_DIST ?? join(root, "typescript/packages/haus/dist"))
const { parseSchemaFile, withoutAttributes } = await import(pathToFileURL(join(dist, "schema-file.js")).href)

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

/** The named types a file's own definitions reach, as JSON. */
function resolve(text: string): [string, Json][] {
  const file = parseSchemaFile(text)
  const defs = new Map<string, Json>()
  const pending: any[] = []

  const ref = (inst: any): Json => {
    if (!defs.has(inst.key)) {
      defs.set(inst.key, null)
      pending.push(inst)
    }
    return { ref: inst.key }
  }
  const record = (r: any): Json => ({
    closed: r.closed,
    fields: r.fields.map((f: any) => ({ key: f.key, optional: f.optional, type: type(f.type) })),
  })
  const payload = (p: any): Json =>
    p.kind === "none" ? "none" : p.kind === "record" ? { record: record(p.record) } : { positional: p.items.map(type) }
  const type = (t: any): Json => {
    switch (t.kind) {
      case "builtin": return { builtin: t.name }
      case "std": return { time: t.name }
      case "array": return { array: type(t.item) }
      case "map": return { map: type(t.value) }
      case "maybe": return { maybe: type(t.item) }
      case "secret": return { secret: type(t.item) }
      case "record": return { record: record(t) }
      case "variant": return { variant: { closed: !t.open, cases: t.cases.map((c: any) => ({ tag: c.tag, payload: payload(c.payload) })) } }
      case "ref": return ref(t.instance)
      default: throw new Error(`unexpected type kind ${t.kind}`)
    }
  }

  for (const d of file.definitions) if (d.params.length === 0) ref(d.template)
  while (pending.length > 0) {
    const inst = pending.shift()
    if (inst.stream) throw new Error(`${inst.key} is a Stream: the suite has no stream cases`)
    defs.set(inst.key, type(inst.body))
  }
  return [...defs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

const dir = process.argv[2] ?? join(root, "test-suite/schema")
const names = readdirSync(dir).filter((f) => f.endsWith(".schema.haus")).map((f) => f.replace(".schema.haus", "")).sort()
const suites: Json[] = names.map((name) => {
  const text = readFileSync(join(dir, `${name}.schema.haus`), "utf8")
  try {
    const defs = resolve(text)
    if (JSON.stringify(resolve(withoutAttributes(text))) !== JSON.stringify(defs)) {
      throw new Error(`${name}: the types change when the attributes are removed`)
    }
    return { name, defs }
  } catch (e) {
    if (!(e instanceof Error) || e.constructor.name !== "HausSchemaFileError") throw e
    return { name, error: `${e.message}` }
  }
})
// One suite, and one type in it, per line, so that changes show up in diffs.
const lines = suites.map((s: any) =>
  s.error !== undefined
    ? `  ${JSON.stringify(s)}`
    : `  {"name": ${JSON.stringify(s.name)}, "defs": [\n${s.defs.map((d: Json) => `    ${JSON.stringify(d)}`).join(",\n")}\n  ]}`)
process.stdout.write(`{"suites": [\n${lines.join(",\n")}\n]}\n`)
