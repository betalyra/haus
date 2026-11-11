import { describe, expect, it } from "vitest"
import { completeAt, parseSchemaFile } from "../src/index.js"

const schema = parseSchemaFile(`
  import std/time (Date)
  type Money = closed < Money Decimal Currency >
  type Currency = closed < EUR | USD >
  type Status = closed < Pending | Shipped { tracking: String } | Cancelled >
  type Line = { product: String, quantity: UInt8, price: Money, gift?: Bool }
  type Root = { id: Int, lines: Array Line, status: Status, note?: Maybe String, tags: Map String, day?: Date }
`)

/** Labels offered at the | in `text`. */
const at = (text: string) => {
  const offset = text.indexOf("|")
  return completeAt(schema, "Root", text.replace("|", ""), offset).map((c) => c.label)
}

describe("completeAt", () => {
  it("field names, without the ones already written", () => {
    expect(at(`{ |`)).toEqual(["id", "lines", "status", "note?", "tags", "day?"])
    expect(at(`{ id: 1, |`)).toEqual(["lines", "status", "note?", "tags", "day?"])
    expect(at(`{ id: 1, sta|`)).toEqual(["lines", "status", "note?", "tags", "day?"])
    expect(at(`{ id: 1, lines: [{ product: "a", |`)).toEqual(["quantity", "price", "gift?"])
  })

  it("values for the type at the cursor", () => {
    expect(at(`{ status: |`)).toEqual(["Pending", "Shipped {…}", "Cancelled"])
    expect(at(`{ status: Sh|`)).toEqual(["Pending", "Shipped {…}", "Cancelled"])
    expect(at(`{ note: |`)).toEqual(["None", "Some(…)"])
    expect(at(`{ note: Some(|`)).toEqual(['"…"'])
    expect(at(`{ lines: [{ gift: |`)).toEqual(["True", "False"])
    expect(at(`{ lines: [{ price: |`)).toEqual(["Money(…)"])
    expect(at(`{ lines: [{ price: Money(1, |`)).toEqual(["EUR", "USD"])
    expect(at(`{ day: |`)).toEqual(["Date(…)"])
    expect(at(`{ lines: [{ product: "x" }, |`)).toEqual(["{…}"])
  })

  it("inside variant payloads, past strings and comments", () => {
    expect(at(`{ status: Shipped { |`)).toEqual(["tracking"])
    expect(at(`{ note: "a, b: { [", // id: x\n status: |`)).toEqual(["Pending", "Shipped {…}", "Cancelled"])
    expect(at(`{ note: "unfinished |`)).toEqual([])
    expect(at(`{ // a comment |`)).toEqual([])
  })

  it("snippets fill in required fields", () => {
    const text = `{ status: `
    const shipped = completeAt(schema, "Root", text, text.length).find((c) => c.label === "Shipped {…}")
    expect(shipped?.insertText).toBe("Shipped { tracking: $1 }")
  })
})
