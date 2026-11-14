/**
 * Hostile inputs and broken schemas through the Effect adapter: everything
 * must end quickly, with an error where one is due.
 */
import { describe, expect, it } from "vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { arr, type Value } from "@haus-fmt/haus"
import * as Haus from "../src/index.js"

interface TA { readonly _tag: "A"; readonly a: ReadonlyArray<TA | TB> }
interface TB { readonly _tag: "B"; readonly a: ReadonlyArray<TA | TB>; readonly b: string }
const TA: Schema.Codec<TA> = Schema.TaggedStruct("A", { a: Schema.Array(Schema.suspend(() => Schema.Union([TB, TA]))) })
const TB: Schema.Codec<TB> = Schema.TaggedStruct("B", { a: Schema.Array(Schema.suspend(() => Schema.Union([TB, TA]))), b: Schema.String })

describe("recursive schemas", () => {
  it("tagged recursive unions decode in linear time up to the depth limit", () => {
    const text = "A { a: [".repeat(127) + `B { a: [], b: "x" }` + "] }".repeat(127)
    const start = performance.now()
    const tree = Effect.runSync(Haus.decode(TA)(text))
    expect(performance.now() - start).toBeLessThan(1000)
    expect(tree._tag).toBe("A")
  })

  it("recursive values are limited only by the nesting depth (spec §9.9)", () => {
    const { schemas } = Haus.compileSchemaFile(
      "type Ints = < Nil | Cons Int Ints >\ntype Tree = { children: Array Tree }\ntype Chain = { next: Maybe (Array (Maybe Chain)) }",
    )
    const ints = "Cons(1, ".repeat(255) + "Nil" + ")".repeat(255)
    const tree = "{ children: [".repeat(127) + "{ children: [] }" + "] }".repeat(127)
    // Three levels of the value per Chain, and more schema wrappers than that.
    const chain = "{ next: Some([Some ".repeat(84) + "{ next: None }" + "]) }".repeat(84)
    for (const [schema, text] of [[schemas.Ints!, ints], [schemas.Tree!, tree], [schemas.Chain!, chain]] as const) {
      const decoded = Effect.runSync(Haus.decode(schema)(text))
      expect(Effect.runSync(Haus.encode(schema)(decoded, { style: "compact" }))).toBe(text)
    }
  })

  it("recursive unions whose members can't be told apart are rejected up front", () => {
    // Effect tries union members in turn: with recursion that is exponential.
    interface A { readonly a: ReadonlyArray<A | B> }
    interface B { readonly a: ReadonlyArray<A | B>; readonly b: string }
    const A: Schema.Codec<A> = Schema.Struct({ a: Schema.Array(Schema.suspend(() => Schema.Union([B, A]))) })
    const B: Schema.Codec<B> = Schema.Struct({ a: Schema.Array(Schema.suspend(() => Schema.Union([B, A]))), b: Schema.String })
    expect(() => Haus.decode(A)).toThrow("can't be told apart")
    expect(() => Haus.encode(A)).toThrow("can't be told apart")
  })

  it("ambiguous unions without recursion are allowed (bounded by the schema)", () => {
    const S = Schema.Union([Schema.Struct({ x: Schema.Number }), Schema.Struct({ y: Schema.String })])
    expect(Effect.runSync(Haus.decode(S)("{ y: \"a\" }"))).toEqual({ y: "a" })
  })
})

describe("values built in code", () => {
  it("a cyclic Value fails instead of looping", () => {
    const cyclic = arr([]) as { kind: "array"; items: Value[] }
    cyclic.items.push(cyclic)
    const exit = Effect.runSyncExit(Haus.decodeValue(Schema.Array(Schema.Unknown))(cyclic))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("nested deeper than 256")
  })

  it("a cyclic object fails when encoding instead of looping", () => {
    const node: { _tag: "A"; a: TA[] } = { _tag: "A", a: [] }
    node.a.push(node)
    const exit = Effect.runSyncExit(Haus.encode(TA)(node))
    // Effect's own encoder or ours stops it: either way it ends, as an error.
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
