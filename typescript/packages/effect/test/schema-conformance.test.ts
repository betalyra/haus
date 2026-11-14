/**
 * The schema conformance suite (test-suite/schema, spec §15), through the
 * Effect adapter: each schema file is compiled to Effect schemas, and each
 * case goes haus Value → Effect type (`decodeValue`) → haus Value (`encodeValue`).
 */
import { canonical, parseAll, type Value } from "@haus-fmt/haus"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as Haus from "../src/index.js"

const DIR = fileURLToPath(new URL("../../../../test-suite/schema/", import.meta.url))

interface Case {
  readonly ok: boolean
  readonly type: string
  readonly input: Value
  readonly output: Value
  readonly name: string
}

/** The cases of one file: `Ok { type, input, output? }` and `Err { type, input }`. */
const schemaCases = (text: string): Case[] =>
  parseAll(text).map((v) => {
    if (v.kind !== "variant" || (v.tag !== "Ok" && v.tag !== "Err") || v.args[0]?.kind !== "record") throw new Error(`not a case: ${canonical(v)}`)
    const f = v.args[0].fields
    const type = f.get("type")
    const input = f.get("input")
    if (type?.kind !== "string" || input === undefined) throw new Error(`not a case: ${canonical(v)}`)
    return { ok: v.tag === "Ok", type: type.value, input, output: f.get("output") ?? input, name: `${v.tag} ${type.value} ${canonical(input)}` }
  })

/** Cases expected to fail, by suite and name: limits of the Effect types the adapter maps to. */
const EXPECTED_FAILURES: Readonly<Record<string, ReadonlyArray<string>>> = {
  builtins: [
    // std/time Instant decodes to Effect's DateTime.Utc, which drops the written
    // offset (+01:00 comes back as Z): a documented lossy mapping (spec §13.4,
    // README "Three of these keep the value…"). Haus.InstantText keeps the text.
    `Ok At Instant("2026-11-13T10:00:00.250+01:00")`,
  ],
  numbers: [
    // Decimal decodes to Effect's BigDecimal, which has no negative zero: `-0`
    // comes back as `0`. A documented lossy mapping, like Instant.
    "Ok Dec -0",
  ],
}

const suites = readdirSync(DIR).filter((f) => f.endsWith(".schema.haus")).map((f) => f.replace(".schema.haus", ""))

describe.each(suites)("%s", (suite) => {
  const { schemas } = Haus.compileSchemaFile(readFileSync(`${DIR}${suite}.schema.haus`, "utf8"))
  const cases = schemaCases(readFileSync(`${DIR}${suite}.cases.haus`, "utf8"))
  const expectedFailures = new Set(EXPECTED_FAILURES[suite] ?? [])

  const run = (c: Case) => {
    const schema = schemas[c.type]
    if (!schema) throw new Error(`no type ${c.type}`)
    const decoded = Effect.runSyncExit(Haus.decodeValue(schema)(c.input))
    if (!c.ok) {
      expect(Exit.isFailure(decoded), "decoding should fail").toBe(true)
      return
    }
    if (Exit.isFailure(decoded)) throw new Error(`decoding failed: ${String(decoded.cause)}`)
    const encoded = Effect.runSync(Haus.encodeValue(schema)(decoded.value))
    expect(canonical(encoded)).toBe(canonical(c.output))
  }

  for (const c of cases) (expectedFailures.has(c.name) ? it.fails : it)(c.name, () => run(c))
})
