import { describe, expect, it } from "vitest"
import { parseAll } from "../src/index.js"
import { plainDeclarations, toPlain } from "../src/plain.js"

describe("plain view", () => {
  it("types a field with an integer beyond ±2^53 as bigint, for every value", () => {
    const text = `{ id: 9007199254740993, n: 1, total: 19.90 },\n{ id: 1, n: 2, total: 5.00 },`
    const [a, b] = toPlain(parseAll(text)) as Array<Record<string, unknown>>
    expect(a).toEqual({ id: 9007199254740993n, n: 1, total: "19.90" })
    expect(b).toEqual({ id: 1n, n: 2, total: "5.00" })
    const types = plainDeclarations(text)
    expect(types).toContain("id: bigint")
    expect(types).toContain("n: number")
    expect(types).toContain("total: string")
  })
})
