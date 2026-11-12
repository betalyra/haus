import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { MAX_DEPTH, parse, parseAll, StreamReader } from "../src/index.js"
import { canonical } from "./canonical.js"
import { parseText, syntax } from "./haus.js"

describe("error messages and positions", () => {
  it.effect.each([
    ["{ ok: true }", "booleans are the variants True / False", 1, 7],
    ["{ x: null }", "use the variant None", 1, 6],
    ["{ Name: 1 }", 'quote it: "Name"', 1, 3],
    ["{\n  a: 1,\n  a: 2,\n}", "duplicate key 'a'", 3, 3],
    ["{ a: 1 b: 2 }", "expected ',' or '}'", 1, 8],
    ['"a\nb"', "line break in string", 1, 3],
    ["007", "invalid number '007'", 1, 1],
    ["Some()", "write 'Some' without parentheses", 1, 5],
    ['"""\n    a\n  b\n    """', "indented less than the closing", 3, 1],
  ] as const)("%j", ([src, message, line, column]) =>
    Effect.gen(function* () {
      const e = yield* Effect.flip(parseText(src))
      expect(e.message).toContain(message)
      expect([e.line, e.column]).toEqual([line, column])
    }))

  it.effect("stream reader reports absolute positions", () =>
    Effect.gen(function* () {
      const r = new StreamReader()
      r.push("A,\nB,\n")
      const e = yield* Effect.flip(syntax(() => r.push("{ ok: true },")))
      expect([e.line, e.column]).toEqual([3, 7])
    }))

  it.effect(`rejects nesting deeper than ${MAX_DEPTH}`, () =>
    Effect.gen(function* () {
      const nest = (n: number) => "[".repeat(n) + "]".repeat(n)
      yield* parseText(nest(MAX_DEPTH))
      const e = yield* Effect.flip(parseText(nest(MAX_DEPTH + 1)))
      expect(e.message).toContain("nesting deeper")
    }))
})

describe("StreamReader", () => {
  it("emits each value as soon as its comma arrives", () => {
    const r = new StreamReader()
    expect(r.push("UserCreated { id: 1 ")).toEqual([])
    expect(r.push("}")).toEqual([]) // a payload could still follow
    expect(r.push(",\nHeart").map(canonical)).toEqual([
      { tag: "UserCreated", args: [{ rec: { id: { num: "1" } } }] },
    ])
    expect(r.push("beat")).toEqual([])
    expect(r.end().map(canonical)).toEqual([{ tag: "Heartbeat" }])
  })

  it("does not split on commas inside strings, comments or payloads", () => {
    const r = new StreamReader()
    const out = [...r.push('"a,b", /* , */ Pair(1, 2), // ,\n"""\n  x,\n  """,'), ...r.end()]
    expect(out.map(canonical)).toEqual(["a,b", { tag: "Pair", args: [{ num: "1" }, { num: "2" }] }, "x,"])
  })

  it("reads comments between values, split anywhere", () => {
    const text = '// header, with a comma\nA { x: 1 }, // after A, [unbalanced\n/* block, with } and " and /* nested, */ */\nB(2),\n\n// before C\nC { s: "// not a comment" } /* before the comma */ ,\n// trailing comment, {'
    const whole = parseAll(text).map(canonical)
    expect(whole).toHaveLength(3)
    for (let k = 0; k <= text.length; k++) {
      const r = new StreamReader()
      const out = [...r.push(text.slice(0, k)), ...r.push(text.slice(k)), ...r.end()]
      expect(out.map(canonical)).toEqual(whole)
    }
  })
})

describe("parse", () => {
  it("accepts exactly one value", () => {
    expect(canonical(parse("{ a: 1 },"))).toEqual({ rec: { a: { num: "1" } } })
  })

  it.effect.each(["1, 2", "// empty"])("rejects %j", (src) =>
    Effect.gen(function* () {
      const e = yield* Effect.flip(syntax(() => parse(src)))
      expect(e.message).toContain("exactly one value")
    }))
})

describe("parseAll", () => {
  it("returns the top-level sequence", () => {
    expect(parseAll("A, B,").map(canonical)).toEqual([{ tag: "A" }, { tag: "B" }])
  })
})

describe("limits and stream safety", () => {
  it.effect("limits are configurable", () =>
    Effect.gen(function* () {
      const e = yield* Effect.flip(syntax(() => parseAll("123456", { maxNumberLength: 5 })))
      expect(e.message).toContain("number literal longer than 5")
      const s = yield* Effect.flip(syntax(() => parseAll('"abcdef"', { maxStringLength: 3 })))
      expect(s.message).toContain("string longer than 3")
    }))

  it.effect("requireTerminator reports a cut-off last value", () =>
    Effect.gen(function* () {
      const r = new StreamReader({ requireTerminator: true })
      expect(r.push("1000,\n100").length).toBe(1)
      const e = yield* Effect.flip(syntax(() => r.end()))
      expect(e.message).toContain("truncated")
    }))

  it.effect("maxValueLength bounds memory for a value that never ends", () =>
    Effect.gen(function* () {
      const r = new StreamReader({ maxValueLength: 100 })
      const e = yield* Effect.flip(syntax(() => r.push("[" + "1, ".repeat(100))))
      expect(e.message).toContain("value longer than 100")
    }))

  it("error columns count code points, not UTF-16 units", () => {
    // "😀" is two UTF-16 units but one column.
    try {
      parseAll('["😀", x]')
    } catch (e) {
      expect((e as { column: number }).column).toBe(7)
    }
  })
})

describe("string length limit", () => {
  it("counts characters, not UTF-16 units", () => {
    const emoji = "😀".repeat(3) // 3 characters, 6 UTF-16 units
    expect(parseAll(`"${emoji}"`, { maxStringLength: 3 }).length).toBe(1)
    expect(() => parseAll(`"${emoji}x"`, { maxStringLength: 3 })).toThrow("longer than 3 characters")
  })
})
