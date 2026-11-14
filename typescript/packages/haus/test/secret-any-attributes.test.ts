/** `Secret a`, `Any` and attributes (spec §14, §15), and the `#haus` directive (§10). */
import { inspect } from "node:util"
import { describe, expect, it } from "vitest"
import {
  canonical, checkData, compileSchemaFile, deprecation, equals, hoverAt, hoverContext, hoverMarkdown, hoverText, parse, parseAll,
  parseSchemaFile, parseWithLocations, schemaDeclarations, Secret, StreamReader, withoutAttributes, type RecordType, type Value, type VariantType,
} from "../src/index.js"
import * as h from "../src/schema.js"

const SECRET = "hunter2-ZQXJ9WVK"

/** The error a call throws. */
const thrown = (f: () => unknown): Error => {
  try {
    f()
  } catch (e) {
    return e as Error
  }
  throw new Error("expected an error")
}

/** No part of the secret: not the whole, not a piece of 4 characters or more. */
const expectNoPartOf = (secret: string, text: string) => {
  for (let i = 0; i + 4 <= secret.length; i++) expect(text).not.toContain(secret.slice(i, i + 4))
}

describe("Secret", () => {
  it("hides its value when printed, logged, inspected or converted to JSON", () => {
    const s = new Secret(SECRET)
    expect(String(s)).toBe("<redacted>")
    expect(`${s}`).toBe("<redacted>")
    expect(s.toString()).toBe("<redacted>")
    expect(JSON.stringify({ key: s })).toBe('{"key":"<redacted>"}')
    expect(inspect(s)).toBe("Secret(<redacted>)")
    expect(inspect({ nested: [s] }, { depth: 10 })).not.toContain(SECRET)
    expect(Object.keys(s)).toEqual([])
    expect({ ...s }).toEqual({})
    expect(Object.prototype.toString.call(s)).toBe("[object Secret]")
  })

  it("gives the value out only through expose()", () => {
    expect(new Secret(SECRET).expose()).toBe(SECRET)
    expect(Secret.make(42n).expose()).toBe(42n)
    expect(h.Secret.make("x")).toBeInstanceOf(Secret)
    expect(h.Secret.is(h.Secret.make("x"))).toBe(true)
    expect(h.Secret.is("x")).toBe(false)
  })

  it("decodes what its type decodes and encodes it back unchanged", () => {
    const Config = h.Record({ key: h.Secret(h.String), pin: h.Optional(h.Secret(h.Int)) })
    const config = h.parse(Config, `{ key: "${SECRET}", pin: 1234 }`)
    expect(config.key).toBeInstanceOf(Secret)
    expect(config.key.expose()).toBe(SECRET)
    expect(config.pin?.expose()).toBe(1234n)
    expect(h.stringify(Config, config, { style: "compact" })).toBe(`{ key: "${SECRET}", pin: 1234 }`)
    expect(h.stringify(Config, { key: h.Secret.make("new") }, { style: "compact" })).toBe('{ key: "new" }')
  })

  it("leaves the value out of decode errors: only the place and the type", () => {
    const cases: [h.AnySchema, string][] = [
      [h.Record({ key: h.Secret(h.Int) }), `{ key: "${SECRET}" }`],
      [h.Record({ key: h.Secret(h.String) }), "{ key: 98765432 }"],
      [h.Record({ key: h.Secret(h.UInt8) }), "{ key: 9876543210 }"],
      [h.Record({ key: h.Secret(h.Array(h.Int)) }), `{ key: [1, "${SECRET}"] }`],
      [h.Record({ key: h.Secret(h.Map(h.Int)) }), `{ key: { "${SECRET}": "x" } }`],
      [h.Record({ key: h.Secret(h.Record({ a: h.Int }, { closed: true })) }), `{ key: { a: 1, ${SECRET.replace("-", "_").toLowerCase()}: 2 } }`],
      [h.Record({ key: h.Secret(h.Variant({ A: h.Unit })) }), `{ key: Hunter2Zqxj }`],
      [h.Record({ key: h.Secret(h.Date) }), `{ key: Date("${SECRET}") }`],
      [h.Record({ key: h.Secret(h.Decimal) }), `{ key: x"${"ab".repeat(8)}" }`],
    ]
    for (const [schema, text] of cases) {
      const e = thrown(() => h.parse(schema, text))
      expect(e).toBeInstanceOf(h.HausDecodeError)
      const err = e as h.HausDecodeError
      expect(err.path).toEqual(["key"])
      expect(err.message).toMatch(/^expected .* \(a Secret: the value is not shown\) at \$\.key$/)
      for (const secret of [SECRET, SECRET.replace("-", "_").toLowerCase(), "98765432", "9876543210", "Hunter2Zqxj", "abababab"]) {
        expectNoPartOf(secret, err.message)
      }
    }
  })

  it("leaves the value out of Standard Schema issues", () => {
    const result = h.Record({ key: h.Secret(h.Int) })["~standard"].validate(`{ key: "${SECRET}" }`)
    expect("issues" in result && result.issues).toBeTruthy()
    expectNoPartOf(SECRET, JSON.stringify(result))
  })

  it("leaves the value out of encode errors", () => {
    const Config = h.Record({ key: h.Secret(h.UInt8) })
    const wrong = thrown(() => h.encode(Config, { key: h.Secret.make(98765432) }))
    expect(wrong).toBeInstanceOf(h.HausEncodeError)
    expect(wrong.message).toBe("expected UInt8 (a Secret: the value is not shown) at $.key")
    // A bare value where a Secret belongs: not quoted either.
    const bare = thrown(() => h.encode(h.Record({ key: h.Secret(h.String) }), { key: SECRET } as never))
    expect(bare.message).toBe("expected a Secret (h.Secret.make(…)), got string at $.key")
  })

  it("comes from Secret in schema files", () => {
    const { schemas } = compileSchemaFile(`type Root = { key: Secret String, keys: Array (Secret Int) }`)
    const root = h.parse(schemas.Root!, `{ key: "${SECRET}", keys: [1, 2] }`) as { key: Secret<string>; keys: Secret<bigint>[] }
    expect(root.key.expose()).toBe(SECRET)
    expect(root.keys.map((k) => k.expose())).toEqual([1n, 2n])
    expect(JSON.stringify(root)).toBe('{"key":"<redacted>","keys":["<redacted>","<redacted>"]}')
    const e = thrown(() => h.parse(schemas.Root!, `{ key: "a", keys: [1, "${SECRET}"] }`))
    expect(e.message).toBe("expected Int (a Secret: the value is not shown) at $.keys[1]")
  })
})

describe("Any", () => {
  const texts = ["1", "0x10", "-0", '"text"', 'x"00ff"', '[1, "a", None]', "{ b: 1, a: [Some({ c: 19.90 })] }", 'Invoice { total: 19.90, lines: [Line(1, "A1")] }']

  it("decodes to the parsed value, unchanged, and encodes it back", () => {
    for (const text of texts) {
      const value = parse(text)
      const decoded = h.decode(h.Any, value)
      expect(decoded).toBe(value)
      expect(equals(h.encode(h.Any, decoded), value)).toBe(true)
      expect(canonical(h.parse(h.Any, text))).toBe(canonical(value))
    }
  })

  it("round-trips through a schema file", () => {
    const { schemas } = compileSchemaFile(`type Root = { kind: String, payload: Any }`)
    const text = '{ kind: "x", payload: Order { id: 0xFF, total: 19.90, tags: [A, B("c")] } }'
    const root = h.parse(schemas.Root!, text) as { payload: Value }
    expect(root.payload.kind).toBe("variant")
    expect(h.stringify(schemas.Root!, root, { style: "compact" })).toBe('{ kind: "x", payload: Order { id: 255, total: 19.90, tags: [A, B("c")] } }')
  })

  it("checks a value before writing it", () => {
    const bad: unknown[] = [
      { kind: "number", text: "1; 2" },
      { kind: "number", text: "0xFF" },
      { kind: "number", text: "1e99999" },
      { kind: "variant", tag: "lower", args: [] },
      { kind: "record", fields: { a: 1 } },
      { kind: "array", items: [{ kind: "nope" }] },
      "plain string",
    ]
    for (const value of bad) expect(() => h.encode(h.Any, value as Value)).toThrow(h.HausEncodeError)
    const deep: Value = Array.from({ length: 300 }).reduce<Value>((v) => ({ kind: "array", items: [v] }), { kind: "number", text: "1" })
    expect(() => h.encode(h.Any, deep)).toThrow(/nesting deeper/)
  })
})

describe("attributes", () => {
  const schema = `
    // A client.
    @deprecated("use Customer")
    type Client = { id: Int, @deprecated("use email") mail?: String, email?: String }
    type Shape = < Circle { r: Float64 } | @deprecated Square { side: Float64 } >
    type Base = { @deprecated("gone") old?: Int }
    type Person = { ...Base, name: String }
    type Kinds = < ...Shape | Dot >
    @since("2.0") type Later = { @example(1, [True], { a: "b" }) n: Int }`

  it("are kept for tools on definitions, fields and cases, also through spreads", () => {
    const file = parseSchemaFile(schema)
    const client = file.definition("Client")!
    expect(deprecation(client.attributes)).toBe("use Customer")
    expect(client.doc).toBe("A client.")
    expect(client.source.startsWith("// A client.\n    @deprecated(")).toBe(true)
    const body = (name: string) => file.definition(name)!.template.body
    const fields = (name: string) => (body(name) as RecordType).fields
    expect(deprecation(fields("Client").find((f) => f.key === "mail")!.attributes)).toBe("use email")
    expect(deprecation(fields("Client").find((f) => f.key === "email")!.attributes)).toBeUndefined()
    expect(deprecation(fields("Person").find((f) => f.key === "old")!.attributes)).toBe("gone")
    const cases = (body("Kinds") as VariantType).cases
    expect(deprecation(cases.find((c) => c.tag === "Square")!.attributes)).toBe("")
    const later = file.definition("Later")!
    expect(later.attributes.map((a) => a.name)).toEqual(["since"])
  })

  it("warn about attributes this version doesn't define", () => {
    const file = parseSchemaFile(schema)
    expect(file.warnings.map((w) => [w.message.split(":")[0], schema.slice(w.offset, w.end), w.line])).toEqual([
      ["unknown attribute @since", '@since("2.0")', 9],
      ["unknown attribute @example", '@example(1, [True], { a: "b" })', 9],
    ])
    expect(parseSchemaFile(`@deprecated type A = Int`).warnings).toEqual([])
  })

  it("are rejected where they are malformed", () => {
    const rejected: [string, RegExp][] = [
      [`type A = { @deprecated(1) x: Int }`, /@deprecated takes no argument or one string/],
      [`@deprecated("a", "b") type A = Int`, /@deprecated takes no argument or one string/],
      [`type A = { @deprecated @deprecated("x") x: Int }`, /@deprecated appears twice/],
      [`type A = < @since(1) @since(2) X >`, /@since appears twice/],
      [`type A = { @deprecated ("x") x: Int }`, /no space is allowed between @deprecated and '\('/],
      [`type A = { @deprecated/* */("x") x: Int }`, /no space is allowed/],
      [`type B = { x: Int }\ntype A = { @deprecated ...B }`, /can't be put on a spread/],
      [`type B = < X >\ntype A = < @deprecated ...B >`, /can't be put on a spread/],
      [`@deprecated import std/time (Date)`, /a type definition after the attribute/],
      [`type A = { @deprecated }`, /a field name after the attribute/],
      [`type A = { @deprecated() x: Int }`, /needs at least one value/],
      [`type A = { @deprecated("x" x: Int }`, /expected ',' or '\)'/],
      [`type A = { @Deprecated x: Int }`, /expected an attribute name/],
      [`type A = { @example([1, ) x: Int }`, /expected a value/],
    ]
    for (const [text, message] of rejected) expect(() => parseSchemaFile(text), text).toThrow(message)
    // Comments and a trailing comma between the arguments are fine.
    expect(() => parseSchemaFile(`type A = { @example(1, /* two */ 2,) x: Int }`)).not.toThrow()
  })

  it("don't change decoding", () => {
    const text = `{ id: 1, mail: "a@b.c" }`
    const withAttributes = compileSchemaFile(schema).schemas.Client!
    const stripped = withoutAttributes(schema)
    expect(stripped).not.toContain("@")
    expect(stripped.length).toBe(schema.length)
    expect(h.parse(compileSchemaFile(stripped).schemas.Client!, text)).toEqual(h.parse(withAttributes, text))
  })

  it("become JSDoc @deprecated in declarations", () => {
    const d = schemaDeclarations(parseSchemaFile(schema))
    expect(d).toContain(" * @deprecated use Customer\n */\nexport type Client = ")
    expect(d).toContain("/** @deprecated use email */ readonly mail?: string")
    expect(d).toContain('/** @deprecated */ readonly _tag: "Square"')
    expect(d).toContain("/** @deprecated gone */ readonly old?: bigint")
    expect(schemaDeclarations(parseSchemaFile(`type L = closed < A | @deprecated("*/ no") B >`))).toContain('"A" | /** @deprecated *\\/ no */ "B"')
  })

  it("make checkData hint at deprecated fields and tags the data uses", () => {
    const issues = (type: string, data: string) =>
      checkData(parseSchemaFile(schema), type, parseWithLocations(data)).map((i) => `${i.severity} ${data.slice(i.start, i.end)}: ${i.message}`)
    expect(issues("Client", `{ id: 1, mail: "a" }`)).toEqual(["hint mail: mail is deprecated: use email"])
    expect(issues("Client", `{ id: 1, email: "a" }`)).toEqual([])
    expect(issues("Shape", `Square { side: 1 }`)).toEqual(["hint Square: Square is deprecated"])
    expect(issues("Kinds", `Square { side: 1 }`)).toEqual(["hint Square: Square is deprecated"])
    expect(issues("Person", `{ name: "a", old: 1 }`)).toEqual(["hint old: old is deprecated: gone"])
  })
})

describe("Secret and Any in tools", () => {
  const schema = `type Root = { name: String, key: Secret String, pin?: Secret Int, extra: Any, keys: Secret (Map Int) }`
  const file = parseSchemaFile(schema)

  it("declare Secret<T> and Value", () => {
    const d = schemaDeclarations(file)
    expect(d).toContain("readonly key: h$.Secret<string>; readonly pin?: h$.Secret<bigint>; readonly extra: h$.Value; readonly keys: h$.Secret<ReadonlyMap<string, bigint>>")
  })

  it("checkData masks values inside a Secret", () => {
    const data = `{ name: "a", key: 98765432, pin: "${SECRET}", extra: Whatever(1), keys: { "${SECRET}": "x", ok: 1 } }`
    const issues = checkData(file, "Root", parseWithLocations(data))
    expect(issues.map((i) => `${i.severity} ${data.slice(i.start, i.end).slice(0, 8)}: ${i.message}`)).toEqual([
      "error 98765432: expected String (a Secret: the value is not shown)",
      `error "${SECRET.slice(0, 7)}: expected Int (a Secret: the value is not shown)`,
      `error { "${SECRET.slice(0, 5)}: expected Map Int (a Secret: the value is not shown)`,
    ])
    for (const i of issues) expectNoPartOf(SECRET, i.message), expectNoPartOf("98765432", i.message)
  })

  it("hover masks values inside a Secret", () => {
    const data = `{ name: "a", key: "${SECRET}", pin: 1234567, extra: 1, keys: { a: 7 } }`
    const ctx = hoverContext(data, { file, type: "Root" })
    const key = hoverAt(ctx, data.indexOf(SECRET))!
    expect(key.secret).toBe(true)
    expect(key.schema?.type).toBe("Secret String")
    expect(hoverMarkdown(key)).not.toContain("character")
    expect(hoverMarkdown(key)).toContain("**secret** (the value is not shown)")
    const pin = hoverAt(ctx, data.indexOf("1234567"))!
    expect(pin.note).toBeUndefined()
    expect(pin.inferred).toBeUndefined()
    for (const text of [hoverMarkdown(pin), hoverText(pin)]) expect(text).not.toContain("1234567")
    // Inside a secret, also below the value the schema names.
    const inner = hoverAt(ctx, data.indexOf("7 }"))!
    expect(inner.secret).toBe(true)
    expect(hoverMarkdown(inner)).not.toContain("number 7")
    // The key itself.
    expect(hoverAt(ctx, data.indexOf("key"))!.secret).toBe(true)
    expect(hoverAt(ctx, data.indexOf("name"))!.secret).toBeUndefined()
  })
})

describe("#haus version directive (spec §10)", () => {
  const message = /needs a newer version of haus/

  it("is reported as needing a newer version", () => {
    expect(() => parse("#haus 2\n{ a: 1 }")).toThrow(message)
    expect(() => parseAll("#haus 2\n{ a: 1 }")).toThrow(message)
    expect(() => parseAll("﻿#haus 2\n1")).toThrow(message)
    expect(() => parseWithLocations("#haus")).toThrow(message)
  })

  it("is reported by the stream reader too", () => {
    const reader = new StreamReader()
    expect(() => {
      reader.push("﻿#haus 2\n1,")
      reader.end()
    }).toThrow(message)
  })

  it("is still an error, and other # stay ordinary syntax errors", () => {
    expect(() => parseAll("#hello")).toThrow(/expected a value, found '#'/)
    expect(() => parseAll("1,\n#haus 2")).toThrow(/expected a value, found '#'/)
    expect(() => parseAll(" #haus 2")).toThrow(/expected a value, found '#'/)
  })
})
