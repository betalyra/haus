import { HausSchemaFileError, parseSchemaFile } from "@betalyra/haus-fmt"
import { describe, expect, it } from "@effect/vitest"
import { BigDecimal, DateTime, Effect, Exit, Option } from "effect"
import { readFileSync } from "node:fs"
import * as Haus from "../src/index.js"

const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8")

const compile = (text: string) => Haus.compileSchemaFile(text).schemas
const decodeWith = (text: string, name: string, data: string) => Effect.runSyncExit(Haus.decode(compile(text)[name]!)(data))
const decoded = (text: string, name: string, data: string): any => {
  const exit = decodeWith(text, name, data)
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
  return exit.value
}
const schemaError = (text: string) => {
  try {
    parseSchemaFile(text)
  } catch (e) {
    if (e instanceof HausSchemaFileError) return e.message
    throw e
  }
  return "no error"
}

describe("schema files", () => {
  it("decode the examples with their schemas", () => {
    const thread = decoded(read("examples/thread.schema.haus"), "Root", read("examples/thread.haus"))
    expect(thread._tag).toBe("Comment")
    expect(typeof thread.likes).toBe("bigint")
    expect(DateTime.isDateTime(thread.at)).toBe(true)
    expect(thread.replies[0]._tag).toBe("Comment")

    const tour = decoded(read("examples/syntax-tour.schema.haus"), "Root", read("examples/syntax-tour.haus"))
    expect(BigDecimal.isBigDecimal(tour.price)).toBe(true)
    expect(Option.isOption(tour.timeout)).toBe(true)
    expect(tour).not.toHaveProperty("owner")
  })

  it("maps the prelude and std modules", () => {
    const schema = `
      import std/time (Date, Instant)
      import std/money (Money)
      type Root = {
        name: String, n: Int, small: UInt8, f: Float64, d: Decimal, ok: Bool, raw: Bytes,
        day: Date, at: Instant, price: Money, nick: Maybe String, tags: Map Int, note?: String,
      }`
    const v = decoded(schema, "Root", `{
      name: "a", n: 12345678901234567890, small: 255, f: 1.5, d: 19.90, ok: True, raw: x"ff00",
      day: Date("2026-11-08"), at: Instant("2026-11-08T10:00:00Z"), price: Money(19.90, EUR),
      nick: Some("x"), tags: { a: 1, b: 2 },
    }`)
    expect(v.n).toBe(12345678901234567890n)
    expect(v.small).toBe(255)
    expect(BigDecimal.format(v.d)).toBe("19.9")
    expect(v.raw).toEqual(new Uint8Array([255, 0]))
    expect(v.day).toBe("2026-11-08")
    expect(v.price).toMatchObject({ _tag: "Money", currency: "EUR" })
    expect(v.nick).toEqual(Option.some("x"))
    expect(v.tags).toEqual({ a: 1n, b: 2n })
    expect(Exit.isFailure(decodeWith(schema.replace("small: UInt8", "small: Int8"), "Root", "{ small: 255 }"))).toBe(true)
  })

  it("variants: enums, payloads, positional values, open rows", () => {
    const schema = `
      type Level = closed < Debug | Info >
      type Shape = closed < Circle { r: Float64 } | Point Float64 Float64 | Empty >
      type Theme = < Light | Dark >
      type Root = { level: Level, shapes: Array Shape, theme: Theme }`
    const v = decoded(schema, "Root", `{ level: Info, shapes: [Circle { r: 1 }, Point(1, 2), Empty], theme: Sepia }`)
    expect(v.level).toBe("Info")
    expect(v.shapes).toEqual([{ _tag: "Circle", r: 1 }, { _tag: "Point", values: [1, 2] }, { _tag: "Empty" }])
    expect(v.theme).toMatchObject({ _tag: "@unknown", tag: "Sepia" })
    expect(Exit.isFailure(decodeWith(schema, "Root", `{ level: Trace, shapes: [], theme: Light }`))).toBe(true)
  })

  it("encodes back to the same text", () => {
    const schema = `
      import std/money (Money)
      type Shape = closed < Circle { r: Float64 } | Point Float64 Float64 | Empty >
      type Root = { shapes: Array Shape, price: Money, tags: Map Decimal }`
    const s = compile(schema).Root!
    const text = `{ shapes: [Circle { r: 1 }, Point(1, 2), Empty], price: Money(19.90, EUR), tags: { a: 1.50 } }`
    const v = Effect.runSync(Haus.decode(s)(text))
    expect(Effect.runSync(Haus.encode(s, { style: "compact" })(v))).toBe(text)
  })

  it("closed records reject other fields; open ones ignore them", () => {
    const schema = `type Closed = closed { a: Int }\ntype Open = { a: Int }`
    expect(Exit.isFailure(decodeWith(schema, "Closed", "{ a: 1, b: 2 }"))).toBe(true)
    expect(decoded(schema, "Open", "{ a: 1, b: 2 }")).toEqual({ a: 1n })
  })

  it("rows: composing variants and records", () => {
    const schema = read("examples/syntax-tour.schema.haus")
    const { schemas, streams } = Haus.compileSchemaFile(schema)
    expect(streams.has("ServerEvents")).toBe(true)
    const app = Effect.runSync(Haus.decode(schemas.AppEvent!)("Heartbeat"))
    expect(app).toEqual({ _tag: "Heartbeat" })
    const unknown = Effect.runSync(Haus.decode(schemas.ServerEvents!)("PaymentReceived { id: 1, amount: Money(1, EUR) }"))
    expect(unknown).toMatchObject({ _tag: "@unknown", tag: "PaymentReceived" })
  })

  it("open by default, closed on request, composed rows closed only if both parts are", () => {
    const schema = `
      type Status = < Pending | Done >
      type Fixed = closed < Pending | Done >
      type Ev r = closed < A | ...r >
      type Both = Ev (closed < B >)
      type Some = Ev < B >
      type Rec r = closed { a: Int, ...r }
      type R1 = Rec (closed { b: Int })
      type R2 = Rec { b: Int }`
    expect(decoded(schema, "Status", "Archived")).toMatchObject({ _tag: "@unknown", tag: "Archived" })
    expect(Exit.isFailure(decodeWith(schema, "Fixed", "Archived"))).toBe(true)
    expect(Exit.isFailure(decodeWith(schema, "Both", "C"))).toBe(true)
    expect(decoded(schema, "Some", "C")).toMatchObject({ tag: "C" })
    expect(Exit.isFailure(decodeWith(schema, "R1", "{ a: 1, b: 2, c: 3 }"))).toBe(true)
    expect(decoded(schema, "R2", "{ a: 1, b: 2, c: 3 }")).toEqual({ a: 1n, b: 2n })
  })

  it("generic and recursive types", () => {
    const schema = `
      type List a = closed < Nil | Cons a (List a) >
      type Tree = closed < Node { value: Int, children: Array Tree } >
      type Root = { list: List String, tree: Tree, result: Result String Int }`
    const v = decoded(schema, "Root", `{ list: Cons("a", Cons("b", Nil)), tree: Node { value: 1, children: [Node { value: 2, children: [] }] }, result: Ok(1) }`)
    expect(v.list).toEqual({ _tag: "Cons", values: ["a", { _tag: "Cons", values: ["b", { _tag: "Nil" }] }] })
    expect(v.tree.children[0].value).toBe(2n)
    expect(v.result).toEqual({ _tag: "Ok", values: [1n] })
  })

  it("reports errors with positions", () => {
    expect(schemaError("type A = B")).toBe("unknown type B at 1:10")
    expect(schemaError("type A = Date")).toContain("import std/time (Date)")
    expect(schemaError("type A = B\ntype B = A")).toContain("refers to itself without a record")
    expect(schemaError("type T a = < L a | N (T (Array a)) >")).toContain("with its own parameters")
    expect(schemaError("type A = { a: Int, a: String }")).toContain("field a appears twice")
    expect(schemaError("type A = < X | X >")).toContain("tag X appears twice")
    expect(schemaError("type A = Maybe")).toContain("needs 1 argument")
    expect(schemaError("type E r = < A | ...r >\ntype B = E < A >")).toContain("tag A appears twice after filling the row")
    expect(schemaError("type E r = < A | ...r >\ntype B = E { x: Int }")).toContain("can't be filled with a record")
    expect(schemaError("type E r = < A (E r) | ...r >")).toContain("can't be recursive")
    expect(schemaError("type S = Stream Int\ntype R = { s: S }")).toContain("a stream can only be the whole file")
    expect(schemaError("import std/time (Dat)")).toContain("std/time has no type Dat")
    expect(schemaError("import other/x (A)")).toContain("only standard modules")
    expect(schemaError("type A = { x: _ }")).toContain("open by default")
    expect(schemaError("type A = < X | ... >")).toContain("open by default")
    expect(schemaError("type A = closed < >")).toContain("needs at least one tag")
    expect(schemaError("type A = {| a: Int |}")).toContain("write closed { … }")
    expect(schemaError("type A = " + "(".repeat(500) + "Int" + ")".repeat(500))).toContain("nested deeper")
  })

  it("prints TypeScript declarations", () => {
    const d = Haus.schemaDeclarations(parseSchemaFile(read("examples/syntax-tour.schema.haus")))
    expect(d).toContain(`export type Level = "Debug" | "Info" | "Warn" | "Error";`)
    expect(d).toContain(`export declare const Root: Schema$.Codec<Root>;`)
    expect(d).toContain(`readonly timeout: Option$.Option<bigint>`)
    expect(d).toContain(`readonly owner?: string`)
    const g = Haus.schemaDeclarations(parseSchemaFile("type List a = closed < Nil | Cons a (List a) >"))
    expect(g).toContain(`export type List<A> = { readonly _tag: "Nil" } | { readonly _tag: "Cons"; readonly values: readonly [A, List<A>] };`)
  })
})

describe("error locations", () => {
  it("leads to the value that failed", async () => {
    const { parseWithLocations } = await import("@betalyra/haus-fmt")
    const schema = `type Root = { items: Array < Point Int Int | Box { size: Int } > , m: Maybe Int }`
    const cases: [string, string][] = [
      [`{ items: [Point(1, "x")], m: None }`, `"x"`],
      [`{ items: [Box { size: "big" }], m: None }`, `"big"`],
      [`{ items: [], m: Some("no") }`, `"no"`],
    ]
    for (const [data, bad] of cases) {
      const exit = decodeWith(schema, "Root", data)
      if (Exit.isSuccess(exit)) throw new Error("expected failure")
      const error = (exit.cause as any).reasons?.[0]?.error ?? (exit.cause as any).failures?.[0] ?? (exit.cause as any).error
      const [value] = parseWithLocations(data)
      const at = Haus.locateIssue(value!, error.path ?? [])
      expect(data.slice(at.start, at.end)).toBe(bad)
    }
  })
})

describe("standard modules", () => {
  it("the checker knows exactly the types of spec/std", async () => {
    const { STD_MODULES } = await import("@betalyra/haus-fmt")
    for (const [module, names] of Object.entries(STD_MODULES)) {
      const file = parseSchemaFile(read(`spec/${module}.schema.haus`))
      expect(file.definitions.map((d) => d.name)).toEqual(names)
    }
  })
})

describe("decodeStream from an Effect Stream", () => {
  it.effect("decodes chunks and passes source errors through", () =>
    Effect.gen(function* () {
      const { Stream, Data } = yield* Effect.promise(() => import("effect"))
      const Item = compile("type Item = { n: Int }").Item!
      const chunks = Stream.fromIterable(["{ n: 1 },\n{ n", ": 2 },\n"]).pipe(Stream.map((s) => new TextEncoder().encode(s)))
      const items = yield* Stream.runCollect(Haus.decodeStream(Item)(chunks))
      expect([...items]).toEqual([{ n: 1n }, { n: 2n }])

      class ReadError extends Data.TaggedError("ReadError")<{}> {}
      const failing = Stream.concat(Stream.make("{ n: 1 },"), Stream.fail(new ReadError()))
      const error = yield* Effect.flip(Stream.runCollect(Haus.decodeStream(Item)(failing)))
      expect(error).toBeInstanceOf(ReadError)
    }))
})
