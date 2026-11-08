import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { checkData, parseSchemaFile, parseWithLocations, schemaReference } from "../src/index.js"

const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8")

/** Issues as "severity text-at-location: message". */
const issues = (schema: string, data: string, type = "Root") =>
  checkData(parseSchemaFile(schema), type, parseWithLocations(data)).map((i) => `${i.severity} ${data.slice(i.start, i.end)}: ${i.message}`)

describe("checkData", () => {
  it("accepts the examples", () => {
    for (const name of ["thread", "syntax-tour"]) {
      const found = checkData(parseSchemaFile(read(`examples/${name}.schema.haus`)), "Root", parseWithLocations(read(`examples/${name}.haus`)))
      expect(found.filter((i) => i.severity === "error")).toEqual([])
    }
  })

  it("reports errors at the wrong value", () => {
    const schema = `
      import std/money (Money)
      type Status = closed < Pending | Shipped { tracking: String } >
      type Root = { id: Int, qty: UInt8, price: Money, status: Status, tags: Array String }`
    expect(issues(schema, `{ id: "7", qty: 300, price: Money(1, Eur), status: Shiped, tags: ["a", 1] }`)).toEqual([
      `error "7": expected Int, found the string "7"`,
      `error 300: 300 is out of range for UInt8 (0 to 255)`,
      `error Eur: a currency is three capital letters (EUR, USD), found Eur`,
      `error Shiped: Shiped is not allowed here: expected one of Pending, Shipped. Did you mean Shipped?`,
      `error 1: expected String, found the number 1`,
    ])
    expect(issues(schema, `{ id: 1 }`)[0]).toBe("error {: missing fields qty, price, status, tags")
  })

  it("open types: unknown fields and tags are hints; closed ones are errors", () => {
    const schema = `
      type Line = { product: String, quantity?: UInt8 }
      type Strict = closed { product: String }
      type Theme = < Light | Dark >
      type Root = { line: Line, strict: Strict, theme: Theme }`
    expect(issues(schema, `{ line: { product: "a", quantiy: 2 }, strict: { product: "b", extra: 1 }, theme: Sepia }`)).toEqual([
      "hint quantiy: quantiy is not in the schema; a reader ignores it. Did you mean quantity?",
      "error extra: extra is not a field of this closed record.",
      "hint Sepia: Sepia is not in the schema; a reader keeps it as an unknown value.",
    ])
  })

  it("streams, positional payloads, Maybe and recursion", () => {
    const schema = `
      type Point = closed < Point Float64 Float64 >
      type Tree = closed < Node { value: Int, children: Array Tree } >
      type Item = { at: Point, tree: Tree, nick: Maybe String }
      type Root = Stream Item`
    expect(issues(schema, `{ at: Point(1, 2), tree: Node { value: 1, children: [] }, nick: None },\n{ at: Point(1), tree: Node { value: 1, children: [Node { value: "x", children: [] }] }, nick: "n" },`)).toEqual([
      "error Point(1): Point takes 2 arguments (Float64, Float64), found 1",
      `error "x": expected Int, found the string "x"`,
      `error "n": expected None or Some(…) (Maybe String), found the string "n"`,
    ])
  })
})

describe("schemaReference", () => {
  it("reads the comment at the top", () => {
    const text = `// An order.\n// schema: ./api.schema.haus#Order\n{ id: 1 }`
    const ref = schemaReference(text)!
    expect(ref).toMatchObject({ path: "./api.schema.haus", type: "Order" })
    expect(text.slice(ref.start, ref.end)).toBe("./api.schema.haus#Order")
    expect(schemaReference(`// schema: x.schema.haus\n{}`)?.type).toBe("Root")
    expect(schemaReference(`{}\n// schema: x.schema.haus`)).toBeUndefined()
  })
})
