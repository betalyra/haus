import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { format, inferSchema, parseAll, parseDocument, parseWithLocations, stringify, infer, printShape } from "../src/index.js"
import { canonical } from "./canonical.js"
import { decode, fixtures, repoFile } from "./haus.js"

const files = [
  ...fixtures("valid").map(({ name, bytes }) => ({ name, bytes })),
  ...["syntax-tour.haus", "events.haus", "person.haus", "thread.haus", "filesystem.haus", "settings-ui.haus", "user-update.haus"].map((name) => ({ name, bytes: repoFile(name) })),
]

describe("format: round trip and idempotence", () => {
  it.effect.each(files)("$name", ({ bytes }) =>
    Effect.gen(function* () {
      const src = yield* decode(bytes)
      const values = parseAll(src)
      for (const out of [format(values), format(parseWithLocations(src), { source: src })]) {
        // Same data after formatting…
        expect(parseAll(out).map(canonical)).toEqual(values.map(canonical))
        // …and formatting the output again changes nothing.
        expect(format(parseWithLocations(out), { source: out })).toBe(out)
      }
    }))
})

describe("format: comments are kept", () => {
  const withComments = (src: string) => {
    const { values, comments } = parseDocument(src)
    return { out: format(values, { source: src, comments }), values, comments }
  }
  const commentTexts = (src: string) => {
    const { comments } = parseDocument(src)
    return comments.map(([s, e]) => src.slice(s, e))
  }

  it.effect.each(files)("$name", ({ bytes }) =>
    Effect.gen(function* () {
      const src = yield* decode(bytes)
      const { out, values } = withComments(src)
      expect(parseAll(out).map(canonical)).toEqual(values.map(canonical))
      expect(commentTexts(out)).toEqual(commentTexts(src))
      expect(withComments(out).out).toBe(out)
    }))

  it("places leading, trailing and dangling comments", () => {
    const src = `// header

{
  // about name
  name: "Jan", // trailing
  /* inline */ age: 3,

  tags: [
    1, // one
    // end of list
  ],
  // end of record
}
`
    expect(withComments(src).out).toBe(`// header

{
  // about name
  name: "Jan", // trailing
  /* inline */
  age: 3,

  tags: [
    1, // one
    // end of list
  ],
  // end of record
}
`)
  })

  it("keeps a block comment after an entry", () => {
    expect(withComments("{ a: 1 /* why */, b: 2 }").out).toBe("{\n  a: 1, /* why */\n  b: 2,\n}\n")
  })

  it("keeps a comment-only file", () => {
    expect(withComments("// nothing\n").out).toBe("// nothing\n")
  })
})

describe("format: pretty (default)", () => {
  const fmt = (src: string) => format(parseAll(src))

  it("puts every record and array entry on its own line, keeps positional payloads inline", () => {
    expect(fmt('Person { name: "John Doe", tags: ["a"], price: Money(7.90, EUR), empty: {}, none: [] },')).toBe(
      'Person {\n  name: "John Doe",\n  tags: [\n    "a",\n  ],\n  price: Money(7.90, EUR),\n  empty: {},\n  none: [],\n}\n',
    )
  })

  it("writes streams with a comma after every item and a blank line between multi-line items", () => {
    expect(fmt("A, B { x: 1 }, C")).toBe("A,\nB {\n  x: 1,\n},\n\nC,\n")
  })

  it("quotes keys only when needed and escapes minimally", () => {
    expect(fmt('{ "content-type": "a\\"b", ok: "\\u{202E}" }')).toBe('{\n  "content-type": "a\\"b",\n  ok: "\\u{202E}",\n}\n')
  })

  it("uses block strings for multi-line text, escaping quote runs", () => {
    const src = '{ text: "line 1\\nsay \\"\\"\\"hi\\"\\"\\"\\n" }'
    const out = fmt(src)
    expect(out).toBe('{\n  text: """\n    line 1\n    say \\"""hi\\"""\n\n    """,\n}\n')
    expect(parseAll(out).map(canonical)).toEqual(parseAll(src).map(canonical))
  })

  it("breaks a long positional payload", () => {
    expect(format(parseAll('Pair("aaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbb")'), { width: 30 })).toBe(
      'Pair(\n  "aaaaaaaaaaaaaaaaaaaa",\n  "bbbbbbbbbbbbbbbbbbbb",\n)\n',
    )
  })

  it("keeps the original spelling of numbers and strings when given the source", () => {
    const src = '{a:0xFF,b:1_000,c:"\\u{41}"}'
    expect(format(parseWithLocations(src), { source: src })).toBe('{\n  a: 0xFF,\n  b: 1_000,\n  c: "\\u{41}",\n}\n')
    expect(format(parseAll(src))).toBe('{\n  a: 255,\n  b: 1000,\n  c: "A",\n}\n')
  })
})

describe("format: compact (one item per line)", () => {
  it.effect.each(files)("$name round-trips with one item per line", ({ bytes }) =>
    Effect.gen(function* () {
      const values = parseAll(yield* decode(bytes))
      const out = format(values, { style: "compact" })
      expect(parseAll(out).map(canonical)).toEqual(values.map(canonical))
      expect(format(parseAll(out), { style: "compact" })).toBe(out)
      expect(out.split("\n").filter(Boolean)).toHaveLength(values.length)
    }))

  it("writes each item on one readable line", () => {
    expect(format(parseAll('Person { name: "John Doe", age: 30, type: Engineer }, Person { name: "Jane", text: """\n  a\n  b\n  """ }'), { style: "compact" })).toBe(
      'Person { name: "John Doe", age: 30, type: Engineer },\nPerson { name: "Jane", text: "a\\nb" },\n',
    )
  })

  it("stringify", () => {
    expect(stringify(parseAll('{ a: [1, 2], b: Some("y"), c: {} }')[0]!, { style: "compact" })).toBe('{ a: [1, 2], b: Some("y"), c: {} }')
  })
})

describe("infer", () => {
  it("unifies variants seen at the same position", () => {
    const values = parseAll('Person { name: "John", age: 30, type: Engineer }, Person { name: "Jane", age: 28, type: Designer }')
    const { root } = infer(values)
    expect(printShape(root)).toBe("< Person { name: String, age: Int, type: < Engineer | Designer > } >")
  })

  it("handles deep nesting and names std/time types", () => {
    const values = parseAll(`
      A { jobs: [Job { from: Date("2020-01-01"), to: None, pay: Money(1.50, EUR), role: Dev { langs: [Rust] } }] },
      A { jobs: [Job { from: Date("2021-01-01"), to: Some(Date("2022-01-01")), pay: Money(2, GBP), role: Ops { oncall: True } }] },
    `)
    expect(printShape(infer(values).root, { width: 200 })).toBe(
      "< A { jobs: Array < Job { from: Date, to: Maybe Date, pay: < Money Decimal < EUR | GBP > >, role: < Dev { langs: Array < Rust > } | Ops { oncall: Bool } > } > } >",
    )
  })

  it("marks fields missing somewhere as optional, detects Bool, Maybe and Decimal", () => {
    const values = parseAll("{ a: 1, ok: True, n: None }, { a: 1.5, ok: False, n: Some(2), extra: [\"x\"] }")
    expect(printShape(infer(values).root)).toBe("{ a: Decimal, ok: Bool, n: Maybe Int, extra?: Array String }")
  })

  it("maps every value to the shape of its position", () => {
    const values = parseAll("{ type: Engineer }, { type: Designer }")
    const { shapeOf } = infer(values)
    const first = values[0]!
    const type = first.kind === "record" ? first.fields.get("type")! : first
    expect(printShape(shapeOf.get(type)!)).toBe("< Engineer | Designer >")
  })

  it("writes a schema document", () => {
    expect(inferSchema(parseAll("A, B"))).toContain("type Root = Stream Item")
  })
})
