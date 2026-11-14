/** The schema conformance suite (test-suite/schema, spec §15). */
import { describe, expect, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { canonical, compileSchemaFile, parseAll, type Value } from "../src/index.js"
import * as h from "../src/schema.js"

const DIR = join(import.meta.dirname, "../../../../test-suite/schema")

interface Case {
  readonly ok: boolean
  readonly type: string
  readonly input: Value
  readonly output: Value
  readonly name: string
}

/** The cases of one file: `Ok { type, input, output? }` and `Err { type, input }`. */
export const schemaCases = (text: string): Case[] =>
  parseAll(text).map((v) => {
    if (v.kind !== "variant" || (v.tag !== "Ok" && v.tag !== "Err") || v.args[0]?.kind !== "record") throw new Error(`not a case: ${canonical(v)}`)
    const f = v.args[0].fields
    const type = f.get("type")
    const input = f.get("input")
    if (type?.kind !== "string" || input === undefined) throw new Error(`not a case: ${canonical(v)}`)
    return { ok: v.tag === "Ok", type: type.value, input, output: f.get("output") ?? input, name: `${v.tag} ${type.value} ${canonical(input)}` }
  })

const suites = readdirSync(DIR).filter((f) => f.endsWith(".schema.haus")).map((f) => f.replace(".schema.haus", ""))

describe.each(suites)("%s", (suite) => {
  const { schemas } = compileSchemaFile(readFileSync(join(DIR, `${suite}.schema.haus`), "utf8"))
  const cases = schemaCases(readFileSync(join(DIR, `${suite}.cases.haus`), "utf8"))

  it.each(cases)("$name", (c) => {
    const schema = schemas[c.type]
    if (!schema) throw new Error(`no type ${c.type}`)
    if (c.ok) expect(canonical(h.encode(schema, h.decode(schema, c.input)))).toBe(canonical(c.output))
    else expect(() => h.decode(schema, c.input)).toThrow(h.HausDecodeError)
  })
})
