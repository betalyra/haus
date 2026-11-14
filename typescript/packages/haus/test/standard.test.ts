import { describe, expect, it } from "vitest"
import { z } from "zod"
import { HausSyntaxError, HausValidationError, parsePlain, parseWith, parseWithAsync, type StandardSchemaV1 } from "../src/index.js"
import * as h from "../src/schema.js"

const order = `
// an order
{
  id: 1042,
  total: 30.30,
  status: Shipped { at: Date("2026-11-08") },
  gift: True,
  note: None,
}
`

describe("the plain view", () => {
  it("turns haus values into plain JS values", () => {
    expect(parsePlain(order)).toEqual({
      id: 1042n,
      total: "30.30",
      status: { _tag: "Shipped", at: "2026-11-08" },
      gift: true,
      note: { _tag: "None" },
    })
  })

  it("is an array for a stream", () => {
    expect(parsePlain("Ping, Pong,")).toEqual(["Ping", "Pong"])
  })
})

describe("parseWith: haus text into any Standard Schema", () => {
  const Order = z.object({
    id: z.bigint(),
    total: z.string(),
    status: z.discriminatedUnion("_tag", [
      z.object({ _tag: z.literal("Shipped"), at: z.string() }),
      z.object({ _tag: z.literal("Pending") }),
    ]),
    gift: z.boolean(),
    note: z.discriminatedUnion("_tag", [z.object({ _tag: z.literal("None") }), z.object({ _tag: z.literal("Some"), value: z.string() })]),
  })

  it("validates with Zod and returns its output type", () => {
    const o = parseWith(Order, order)
    expect(o.status._tag).toBe("Shipped")
    expect(o.total).toBe("30.30")
  })

  it("throws the schema's issues, with their paths", () => {
    const e = (() => {
      try {
        parseWith(Order, "{ id: 1, total: 1.5, status: Lost, gift: True, note: None }")
      } catch (e) {
        return e
      }
    })()
    expect(e).toBeInstanceOf(HausValidationError)
    expect((e as HausValidationError).issues[0]?.path).toEqual(["status"])
  })

  it("reports bad syntax as a syntax error", () => {
    expect(() => parseWith(Order, "{ id: }")).toThrow(HausSyntaxError)
  })

  it("asks for parseWithAsync when the schema is async", async () => {
    const Async = z.object({ id: z.bigint() }).refine(async () => true)
    expect(() => parseWith(Async, "{ id: 1 }")).toThrow("parseWithAsync")
    await expect(parseWithAsync(Async, "{ id: 1 }")).resolves.toEqual({ id: 1n })
  })
})

describe("haus schemas are Standard Schemas", () => {
  const User = h.Record({ id: h.Int, name: h.String, tags: h.Array(h.String) })
  const validate = <A>(s: StandardSchemaV1<unknown, A>, input: unknown) => s["~standard"].validate(input) as StandardSchemaV1.Result<A>

  it("validates haus text", () => {
    expect(User["~standard"].vendor).toBe("haus")
    expect(validate(User, `{ id: 1, name: "Ada", tags: ["x"] }`)).toEqual({ value: { id: 1n, name: "Ada", tags: ["x"] } })
  })

  it("returns issues with the path instead of throwing", () => {
    expect(validate(User, `{ id: 1, name: "Ada", tags: [2] }`)).toEqual({
      issues: [{ message: "expected String, found number 2", path: ["tags", 0] }],
    })
    expect(validate(User, "{ id: }").issues?.[0]?.message).toContain("1:")
    expect(validate(User, 42).issues?.[0]?.message).toContain("haus text")
  })

  it("works for optional, recursive and variant schemas too", () => {
    interface Tree { readonly children: readonly Tree[] }
    const Tree: h.Schema<Tree> = h.Recursive<Tree>("Tree", (self) => h.Record({ children: h.Array(self) }))
    expect(validate(Tree, "{ children: [{ children: [] }] }").issues).toBeUndefined()
    expect(validate(h.Optional(h.String), `"x"`)).toEqual({ value: "x" })
    expect(validate(h.Variant({ A: h.Unit }), "B").issues).toHaveLength(1)
  })
})
