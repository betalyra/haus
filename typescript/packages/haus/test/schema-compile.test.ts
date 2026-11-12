import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { compileSchemaFile, parseSchemaFile, schemaDeclarations, type StandardSchemaV1 } from "../src/index.js"
import { schemaOptions } from "../src/node.js"
import * as h from "../src/schema.js"

const examples = join(import.meta.dirname, "../../../../examples")
const read = (name: string) => readFileSync(join(examples, name), "utf8")
const compile = (name: string) => compileSchemaFile(read(name), schemaOptions(join(examples, name)))

describe("schemas from schema files", () => {
  it("decode data the way the declarations say", () => {
    const { schemas } = compile("thread.schema.haus")
    const thread = h.parse(schemas.Root!, read("thread.haus")) as { author: string; likes: number; at: Date; replies: unknown[] }
    expect(typeof thread.author).toBe("string")
    expect(typeof thread.likes).toBe("number")
    expect(thread.at).toBeInstanceOf(Date)
    expect(Array.isArray(thread.replies)).toBe(true)
  })

  it("resolve imported schema packages", () => {
    const { schemas } = compile("order.schema.haus")
    const order = h.parse(schemas.Root!, read("order.haus")) as { status: unknown }
    expect(order.status).toEqual(expect.objectContaining({ _tag: expect.any(String) }))
  })

  it("know which types are streams", () => {
    const { schemas, streams } = compile("logs.schema.haus")
    const name = [...streams][0]!
    expect(schemas[name]).toBeDefined()
  })

  it("map every kind of type", () => {
    const { schemas } = compileSchemaFile(`
      import std/time (Date, Duration)
      type Level = closed < Debug | Info >
      type Event = < Click { x: Int32, y: Int32 } | Key String | Tick >
      type Root = closed {
        level: Level,
        events: Array Event,
        price: Decimal,
        big: Int64,
        note?: Maybe String,
        tags: Map Bool,
        day: Date,
        wait: Duration,
      }
    `)
    const root = h.parse(schemas.Root!, `{
      level: Info,
      events: [Click { x: 1, y: 2 }, Key("a"), Tick, Scroll(3)],
      price: 19.90,
      big: 9007199254740993,
      note: None,
      tags: { a: True },
      day: Date("2026-11-12"),
      wait: Duration("PT48H"),
    }`) as Record<string, unknown>
    expect(root.level).toBe("Info")
    expect(root.events).toEqual([
      { _tag: "Click", x: 1, y: 2 },
      { _tag: "Key", values: ["a"] },
      { _tag: "Tick" },
      expect.objectContaining({ _tag: "@unknown", tag: "Scroll" }),
    ])
    expect(root.price).toBe("19.90")
    expect(root.big).toBe(9007199254740993n)
    expect(root.note).toBeNull()
    expect(root.tags).toEqual(new Map([["a", true]]))
    expect(root.day).toBe("2026-11-12")
    expect(root.wait).toBe("PT48H")
  })

  it("enforce ranges and closed records", () => {
    const { schemas } = compileSchemaFile(`type Root = closed { n: UInt8 }`)
    expect(() => h.parse(schemas.Root!, `{ n: 300 }`)).toThrow("out of range for UInt8")
    expect(() => h.parse(schemas.Root!, `{ n: 1, extra: 2 }`)).toThrow("unexpected field")
  })

  it("handle recursive and generic types", () => {
    const { schemas } = compileSchemaFile(`
      type List a = < Nil | Cons a (List a) >
      type Root = List Int
    `)
    expect(h.parse(schemas.Root!, "Cons(1, Cons(2, Nil))")).toEqual({
      _tag: "Cons", values: [1, { _tag: "Cons", values: [2, { _tag: "Nil" }] }],
    })
  })

  it("are Standard Schemas", () => {
    const { schemas } = compileSchemaFile(`type Root = { id: Int }`)
    const s = schemas.Root as StandardSchemaV1<unknown, unknown>
    expect(s["~standard"].validate(`{ id: "x" }`)).toEqual({ issues: [expect.objectContaining({ path: ["id"] })] })
  })
})

describe("declarations", () => {
  it("declare types and schemas", () => {
    const decl = schemaDeclarations(parseSchemaFile(`
      import std/time (Date, Instant)
      // a level
      type Level = closed < Debug | Info >
      type List a = < Nil | Cons a (List a) >
      type Root = { level: Level, n: List Int, at: Instant, when?: Maybe Date }
    `))
    expect(decl).toContain(`export type Level = "Debug" | "Info";`)
    expect(decl).toContain(`export type List<A> = { readonly _tag: "Nil" } | { readonly _tag: "Cons"; readonly values: readonly [A, List<A>] } | h$.Unknown;`)
    expect(decl).toContain(`export type Root = { readonly level: Level; readonly n: List<number>; readonly at: Date; readonly when?: string | null };`)
    expect(decl).toContain(`export declare const Root: h$.Schema<Root>;`)
    expect(decl).not.toContain("export declare const List")
  })
})
