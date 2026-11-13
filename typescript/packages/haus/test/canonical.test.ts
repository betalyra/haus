import { describe, expect, it } from "vitest"
import { canonical, compareCodePoints, equals, hash, parse, parseAll } from "../src/index.js"

const c = (src: string) => canonical(parse(src))

describe("canonical form (spec §12)", () => {
  it("writes the spec's example", () => {
    expect(c('Order { total: 19.90, id: 0xFF, "x-y": 1e+5, p: Point(1, 2) }')).toBe(
      'Order{id:255,p:Point(1,2),total:19.90,"x-y":1e5}',
    )
  })

  it("ignores layout, comments, key order and spelling", () => {
    const a = parse('{ b: [1_000, 0b11], /* c */ a: Tag({ x: x"0B 34" }) }')
    const b = parse('{a:Tag{x:x"0b34"},b:[1000,3]}')
    expect(canonical(a)).toBe('{a:Tag{x:x"0b34"},b:[1000,3]}')
    expect(equals(a, b)).toBe(true)
  })

  it("keeps what §2 tells apart", () => {
    expect(equals(parse("1.0"), parse("1"))).toBe(false)
    expect(equals(parse("{}"), parse("{ x: None }"))).toBe(false)
    expect(equals(parse('"caf\\u{E9}"'), parse('"cafe\\u{301}"'))).toBe(false)
    expect(equals(parse("-0"), parse("0"))).toBe(false)
    expect(equals(parse("-0x0"), parse("0"))).toBe(true)
  })

  it("escapes only what it must", () => {
    expect(c('"tab\\tquote\\" \\u{41} \\u{1b} \\u{202e} café 😀"')).toBe('"tab\\tquote\\" A \\u{1B} \\u{202E} café 😀"')
    expect(c('"""\n  two\n  lines\n  """')).toBe('"two\\nlines"')
  })

  it("sorts keys by code point, not by UTF-16 unit", () => {
    // U+FFFD sorts before U+1F600 by code point; as UTF-16 units it's the other way round.
    expect(c('{ "😀": 1, "�": 2, a: 3, "Z": 4 }')).toBe('{"Z":4,a:3,"�":2,"😀":1}')
    expect(compareCodePoints("�", "😀")).toBeLessThan(0)
    expect("�" < "😀").toBe(false)
  })

  it("writes a single record payload as Tag{…}", () => {
    expect(c("[None, Some(1), Circle({ r: 1 }), Pair({ a: 1 }, 2)]")).toBe("[None,Some(1),Circle{r:1},Pair({a:1},2)]")
  })

  it("keeps a huge hex integer in hex", () => {
    const big = "0x" + "f".repeat(900)
    expect(c(big)).toBe(big)
  })
})

describe("hash (spec §12)", () => {
  it("is SHA-256 of the canonical form, as lowercase hex", async () => {
    expect(await hash(parse("{ a: 1 }"))).toBe("f09a9231c12685ac5f0b6f0b06c9154f13dc3a5b3548db5142c19bde1383f261")
    expect(await hash(parse('Order { total: 19.90, id: 0xFF, "x-y": 1e+5, p: Point(1, 2) }'))).toBe(
      "d324549b0e26394cc4f2a1fc7ac2647179da2d244c66763381c9cb63dbf8a104",
    )
  })

  it("is the same for equal values", async () => {
    const [a, b] = parseAll("{ x: 1, y: [2] }, { y: [ 2, ], x: 1 }")
    expect(await hash(a!)).toBe(await hash(b!))
  })
})
