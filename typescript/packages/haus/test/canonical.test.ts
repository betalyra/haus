import { describe, expect, it } from "vitest"
import { canonical, compare, compareCodePoints, equals, hash, hashAll, Hasher, parse, parseAll } from "../src/index.js"

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

describe("compare (spec §12)", () => {
  it("orders by the bytes of the canonical forms", () => {
    const vs = parseAll('9, 10, [], "\u{FFFD}", "😀", { b: 1, a: 2 }, { a: 2, b: 1 }, Some(1), -1')
    expect([...vs].sort(compare).map(canonical)).toEqual(['"\u{FFFD}"', '"😀"', "-1", "10", "9", "Some(1)", "[]", "{a:2,b:1}", "{a:2,b:1}"])
    expect(compare(vs[5]!, vs[6]!)).toBe(0)
    expect(compare(parse("1.0"), parse("1"))).toBe(1)
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

describe("hashAll (spec §12)", () => {
  it("hashes the canonical forms joined by commas", async () => {
    const { createHash } = await import("node:crypto")
    const values = parseAll('1, "a", Order { id: 0xFF },')
    expect(await hashAll(values)).toBe(createHash("sha256").update('1,"a",Order{id:255}').digest("hex"))
    expect(await hashAll([])).toBe(createHash("sha256").update("").digest("hex"))
  })

  it("hashes one value like hash, and tells order apart", async () => {
    expect(await hashAll(parseAll("{ a: 1 },"))).toBe(await hash(parse("{ a: 1 }")))
    expect(await hashAll(parseAll("1, 2"))).not.toBe(await hashAll(parseAll("2, 1")))
    expect(await hashAll(parseAll("1, 2"))).not.toBe(await hash(parse("[1, 2]")))
  })

  it("gives the hash of the values so far at any time", async () => {
    const values = parseAll("1, 2, 3")
    const hasher = new Hasher()
    const prefixes: string[] = []
    for (const v of values) prefixes.push(hasher.add(v).digest())
    expect(prefixes).toEqual(await Promise.all([1, 2, 3].map((n) => hashAll(values.slice(0, n)))))
  })

  it("agrees with node:crypto on texts of every length around a block", async () => {
    const { createHash } = await import("node:crypto")
    const { Sha256 } = await import("../src/sha256.js")
    for (let n = 0; n < 300; n++) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + n) & 0xff)
      const ours = new Sha256()
      ours.update(data.subarray(0, n >> 1)).update(data.subarray(n >> 1))
      expect(Buffer.from(ours.digest()).toString("hex")).toBe(createHash("sha256").update(data).digest("hex"))
    }
  })
})
