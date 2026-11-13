import { describe, expect, it } from "@effect/vitest"
import { parse, parseAll, parseWithLocations } from "@haus-fmt/haus"
import { Equal, HashMap, HashSet, Option } from "effect"
import * as Haus from "../src/index.js"

describe("haus equality and order as Effect instances", () => {
  it("compares as spec §2 does, also where structural equality doesn't", () => {
    const [a, b] = parseAll("{ x: 0xFF, y: Tag({ z: 1 }) }, { y: Tag { z: 1 }, x: 255 }")
    expect(Haus.ValueEquivalence(a!, b!)).toBe(true)
    const located = parseWithLocations("  { x: 255, y: Tag { z: 1 } }")[0]!
    expect(Equal.equals(located, a)).toBe(false) // locations differ
    expect(Haus.ValueEquivalence(located, a!)).toBe(true)
    expect(Equal.equals(Haus.key(located), Haus.key(a!))).toBe(true)
    expect(Haus.ValueEquivalence(parse("1.0"), parse("1"))).toBe(false)
  })

  it("makes haus values keys of HashMap and HashSet", () => {
    const set = HashSet.make(Haus.key(parseWithLocations("  0xFF")[0]!), Haus.key(parse("255")), Haus.key(parse("255.0")))
    expect(HashSet.size(set)).toBe(2)
    const map = HashMap.make([Haus.key(parse("Point(1, 2)")), "here"])
    expect(Option.getOrNull(HashMap.get(map, Haus.key(parse("Point( 0x1, 2, )"))))).toBe("here")
  })

  it("orders by the canonical bytes", () => {
    const vs = parseAll("9, 10, [], Some(1), { b: 1, a: 2 }")
    expect([...vs].sort(Haus.ValueOrder).map((v) => Haus.key(v).canonical)).toEqual(["10", "9", "Some(1)", "[]", "{a:2,b:1}"])
  })
})
