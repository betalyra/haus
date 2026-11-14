/** `Secret a`, `Any` and attributes through the Effect adapter (spec §14, §15). */
import { canonical, equals, parse, parseSchemaFile, type Value } from "@haus-fmt/haus"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Redacted, Schema } from "effect"
import { inspect } from "node:util"
import * as Haus from "../src/index.js"

const SECRET = "hunter2-ZQXJ9WVK"

/** No part of the secret: not the whole, not a piece of 4 characters or more. */
const expectNoPartOf = (secret: string, text: string) => {
  for (let i = 0; i + 4 <= secret.length; i++) expect(text).not.toContain(secret.slice(i, i + 4))
}

const failure = <A>(effect: Effect.Effect<A, Haus.HausError>): Haus.HausError => {
  const exit = Effect.runSyncExit(effect)
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = (exit.cause as unknown as { reasons: ReadonlyArray<{ error?: Haus.HausError }> }).reasons[0]
  if (!reason?.error) throw new Error(String(exit.cause))
  return reason.error
}

const schema = `
  type Config = closed { name: String, key: Secret String, pin?: Secret Int8, keys: Secret (Map Int), extra: Any }
  type Root = Config`
const { schemas } = Haus.compileSchemaFile(schema)
const Config = schemas.Config!

describe("Secret", () => {
  it("decodes to a Redacted that hides the value", () => {
    const config = Effect.runSync(Haus.decode(Config)(`{ name: "a", key: "${SECRET}", pin: 12, keys: { a: 1 }, extra: 1 }`)) as {
      key: Redacted.Redacted<string>
      pin: Redacted.Redacted<number>
      keys: Redacted.Redacted<Record<string, bigint>>
    }
    expect(Redacted.isRedacted(config.key)).toBe(true)
    expect(Redacted.value(config.key)).toBe(SECRET)
    expect(Redacted.value(config.pin)).toBe(12)
    expect(Redacted.value(config.keys)).toEqual({ a: 1n })
    expect(String(config.key)).toBe("<redacted>")
    expect(JSON.stringify(config)).not.toContain(SECRET)
    expect(inspect(config, { depth: 10 })).not.toContain(SECRET)
    // Written in full: the receiver needs it.
    expect(Effect.runSync(Haus.encode(Config)(config, { style: "compact" }))).toBe(`{ name: "a", key: "${SECRET}", pin: 12, keys: { a: 1 }, extra: 1 }`)
  })

  it("leaves the value out of errors, from the converter and from Effect", () => {
    const inputs: [string, string][] = [
      [`{ name: "a", key: 98765432, keys: {}, extra: 1 }`, `expected String (a Secret: the value is not shown)\n  at ["key"]`],
      [`{ name: "a", key: "a", pin: "${SECRET}", keys: {}, extra: 1 }`, `expected Int8 (a Secret: the value is not shown)\n  at ["pin"]`],
      [`{ name: "a", key: "a", pin: 98765, keys: {}, extra: 1 }`, `expected Int8 (a Secret: the value is not shown)\n  at ["pin"]`],
      [`{ name: "a", key: "a", keys: { "${SECRET}": "x" }, extra: 1 }`, `expected Map Int (a Secret: the value is not shown)\n  at ["keys"]`],
    ]
    for (const [input, message] of inputs) {
      const e = failure(Haus.decode(Config)(input))
      expect(e._tag).toBe("HausSchemaError")
      expect(e.message).toBe(message)
      expectNoPartOf(SECRET, e.message)
      expectNoPartOf("98765432", e.message)
    }
  })

  it("leaves the value out of encode errors", () => {
    const value = { name: "a", key: Redacted.make(SECRET), pin: Redacted.make(98765), keys: Redacted.make({}), extra: parse("1") }
    const e = failure(Haus.encode(Config)(value as never))
    expectNoPartOf("98765", e.message)
    expect(e.message).toContain("(a Secret: the value is not shown)")
    const bare = failure(Haus.encode(Config)({ ...value, pin: undefined, key: SECRET } as never))
    expectNoPartOf(SECRET, bare.message)
  })

  it("works with Schema.Redacted written by hand", () => {
    const S = Schema.Struct({ token: Schema.Redacted(Schema.String), pin: Schema.optionalKey(Schema.Redacted(Schema.Number)) })
    const s = Effect.runSync(Haus.decode(S)(`{ token: "${SECRET}" }`))
    expect(Redacted.value(s.token)).toBe(SECRET)
    const e = failure(Haus.decode(S)(`{ token: "a", pin: "${SECRET}" }`))
    expect(e.message).toBe(`expected a valid value (a Secret: the value is not shown)\n  at ["pin"]`)
  })
})

describe("Any", () => {
  it("decodes to the parsed value, unchanged, and encodes it back", () => {
    for (const text of ["1", "0x10", "-0", '"text"', 'x"00ff"', '[1, "a", None]', '{ b: 1, a: [Some({ c: 19.90 })] }', 'Invoice { total: 19.90, lines: [Line(1, "A1")] }']) {
      const value = parse(text)
      const decoded = Effect.runSync(Haus.decodeValue(Haus.Any)(value))
      expect(decoded).toBe(value)
      expect(equals(Effect.runSync(Haus.encodeValue(Haus.Any)(decoded)), value)).toBe(true)
    }
    const root = Effect.runSync(Haus.decode(Config)(`{ name: "a", key: "k", keys: {}, extra: X { y: [1, 2.50] } }`)) as { extra: Value }
    expect(canonical(root.extra)).toBe(canonical(parse("X { y: [1, 2.50] }")))
  })

  it("checks a value before writing it", () => {
    const e = failure(Haus.encodeValue(Haus.Any)({ kind: "number", text: "1; 2" } as Value))
    expect(e.message).toContain("normalized literal")
  })
})

describe("declarations", () => {
  it("declare Secret as Redacted and Any as Value", () => {
    const d = Haus.schemaDeclarations(parseSchemaFile(schema))
    expect(d).toContain('import type { Redacted as Redacted$, Schema as Schema$ } from "effect";')
    expect(d).toContain("readonly key: Redacted$.Redacted<string>; readonly pin?: Redacted$.Redacted<number>; readonly keys: Redacted$.Redacted<{ readonly [key: string]: bigint }>; readonly extra: Haus$.Value")
  })

  it("mark deprecated types, fields and tags", () => {
    const d = Haus.schemaDeclarations(parseSchemaFile(`
      @deprecated("use Customer")
      type Client = { id: Int, @deprecated("use email") mail?: String }
      type Shape = < Circle { r: Float64 } | @deprecated Square { side: Float64 } >
      type Level = < Debug | @deprecated("gone") Trace >`))
    expect(d).toContain(" * @deprecated use Customer\n */\nexport type Client<")
    expect(d).toContain("/** @deprecated use email */ readonly mail?: string")
    expect(d).toContain('/** @deprecated */ readonly _tag: "Square"')
    expect(d).toContain('/** @deprecated gone */ "Trace"')
  })
})
