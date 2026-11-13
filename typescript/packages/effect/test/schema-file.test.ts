import { HausSchemaFileError, parseSchemaFile } from "@haus-fmt/haus"
import { describe, expect, it } from "@effect/vitest"
import { BigDecimal, DateTime, Effect, Exit, Option } from "effect"
import { schemaOptions } from "@haus-fmt/haus/node"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as Haus from "../src/index.js"

const repo = (path: string) => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const read = (path: string) => readFileSync(repo(path), "utf8")
/** Parse options for a schema file of the repo; official extensions come from extensions/. */
const options = (path: string) =>
  schemaOptions(repo(path), { packages: { "@haus/money": repo("extensions/money"), "@haus/geo": repo("extensions/geo") } })
const compileFile = (path: string) => Haus.compileSchemaFile(read(path), options(path))

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

    const tour = Effect.runSync(Haus.decode(compileFile("examples/syntax-tour.schema.haus").schemas.Root!)(read("examples/syntax-tour.haus"))) as any
    expect(BigDecimal.isBigDecimal(tour.price)).toBe(true)
    expect(Option.isOption(tour.timeout)).toBe(true)
    expect(tour).not.toHaveProperty("owner")
  })

  it("maps the prelude and std modules", () => {
    const schema = `
      import std/time (Date, Instant)
      type Money = closed < Money Decimal Currency >
      type Currency = < >
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
    expect(v.price).toMatchObject({ _tag: "Money", values: [expect.anything(), "EUR"] })
    expect(v.nick).toEqual(Option.some("x"))
    expect(v.tags).toEqual({ a: 1n, b: 2n })
    expect(Exit.isFailure(decodeWith(schema.replace("small: UInt8", "small: Int8"), "Root", "{ small: 255 }"))).toBe(true)
  })

  it("Int is a bigint of any size and writes back unchanged", () => {
    const text = "340282366920938463463374607431768211457" // 2^128 + 1
    const Root = compile("type Root = Int").Root!
    const v = Effect.runSync(Haus.decode(Root)(text))
    expect(v).toBe(2n ** 128n + 1n)
    expect(Effect.runSync(Haus.encode(Root)(v))).toBe(text)
  })

  it("variants: enums, payloads, positional values, open variants", () => {
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
      type Money = closed < Money Decimal < > >
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

  it("spread: composing variants and records", () => {
    const { schemas, streams } = compileFile("examples/syntax-tour.schema.haus")
    expect(streams.has("ServerEvents")).toBe(true)
    const app = Effect.runSync(Haus.decode(schemas.AppEvent!)("Heartbeat"))
    expect(app).toEqual({ _tag: "Heartbeat" })
    const unknown = Effect.runSync(Haus.decode(schemas.ServerEvents!)("PaymentReceived { id: 1, amount: Money(1, EUR) }"))
    expect(unknown).toMatchObject({ _tag: "@unknown", tag: "PaymentReceived" })
  })

  it("open by default, closed on request; a spread type's own closed decides, not what it copies", () => {
    const schema = `
      type Status = < Pending | Done >
      type Fixed = closed < Pending | Done >
      type Base = < A >
      type ClosedBase = closed < A >
      type Both = closed < ...Base | B >
      type Some = < ...ClosedBase | B >
      type Ent = { a: Int }
      type R1 = closed { ...Ent, b: Int }
      type R2 = { b: Int, ...Ent }`
    expect(decoded(schema, "Status", "Archived")).toMatchObject({ _tag: "@unknown", tag: "Archived" })
    expect(Exit.isFailure(decodeWith(schema, "Fixed", "Archived"))).toBe(true)
    expect(decoded(schema, "Both", "A")).toBe("A")
    expect(Exit.isFailure(decodeWith(schema, "Both", "C"))).toBe(true)
    expect(decoded(schema, "Some", "C")).toMatchObject({ tag: "C" })
    expect(Exit.isFailure(decodeWith(schema, "R1", "{ a: 1, b: 2, c: 3 }"))).toBe(true)
    expect(decoded(schema, "R2", "{ a: 1, b: 2, c: 3 }")).toEqual({ b: 2n, a: 1n })
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
    expect(schemaError("type E = < A >\ntype B = < ...E | A >")).toContain("tag A appears twice (from ...E)")
    expect(schemaError("type E = { x: Int }\ntype B = < ...E >")).toContain("E is not a variant")
    expect(schemaError("type A = < X | ...B >\ntype B = < Y | ...A >")).toContain("spreads itself")
    expect(schemaError("type P a = < A a >\ntype B = < ...P >")).toContain("only a type without parameters can be spread")
    expect(schemaError("type E r = < A | ...r >")).toContain("row parameters (...r) aren't supported")
    expect(schemaError("type S = Stream Int\ntype R = { s: S }")).toContain("a stream can only be the whole file")
    expect(schemaError("import std/time (Dat)")).toContain("std/time has no type Dat")
    expect(schemaError("import other/x (A)")).toContain("unknown module other/x")
    expect(schemaError("import @haus/money (Money)")).toContain("no module resolver")
    expect(schemaError("type A = { d: Date(1) }")).toContain("expected")
    expect(schemaError("type A = { x: _ }")).toContain("open by default")
    expect(schemaError("type A = < X | ... >")).toContain("a type name after '...'")
    expect(schemaError("type A = closed < >")).toContain("needs at least one tag")
    expect(schemaError("type A = {| a: Int |}")).toContain("write closed { … }")
    expect(schemaError("type A = " + "(".repeat(500) + "Int" + ")".repeat(500))).toContain("nested deeper")
  })

  it("prints TypeScript declarations", () => {
    const path = "examples/syntax-tour.schema.haus"
    const d = Haus.schemaDeclarations(parseSchemaFile(read(path), options(path)))
    expect(d).toContain(`export type Level<C$ = {}> = Haus$.Lookup<C$, "haus-examples/syntax-tour#Level", "Debug" | "Info" | "Warn" | "Error">;`)
    expect(d).toContain(`export declare const Root: Haus$.Named<Schema$.Codec<Root>, "haus-examples/syntax-tour#Root", Root$F, `)
    expect(d).toContain(`interface Root$F extends Haus$.TypeLambda { readonly type: Root<this["C"]> }`)
    expect(d).toContain(`readonly timeout: Option$.Option<bigint>`)
    expect(d).toContain(`readonly owner?: string`)
    // Imported types are declared too, with their ids.
    expect(d).toContain(`type Money<C$ = {}> = Haus$.Lookup<C$, "@haus/money@1#Money", { readonly _tag: "Money"; readonly values: readonly [BigDecimal$.BigDecimal, Currency<C$>] }>;`)
    expect(d).toContain(`"@haus/money@1#Money"`)
    expect(d).toContain(`Haus$.Lookup<C$, "std/time#Date", string>`)
    const g = Haus.schemaDeclarations(parseSchemaFile("type List a = closed < Nil | Cons a (List a) >"))
    expect(g).toContain(`export type List<A, C$ = {}> = { readonly _tag: "Nil" } | { readonly _tag: "Cons"; readonly values: readonly [A, List<A, C$>] };`)
  })
})

describe("error locations", () => {
  it("leads to the value that failed", async () => {
    const { parseWithLocations } = await import("@haus-fmt/haus")
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
  it("std/time follows the profile, whatever the host type accepts", () => {
    const schema = `import std/time (Date, Instant, Duration)\ntype Root = { d: Date, i: Instant, p: Duration }`
    const ok = decoded(schema, "Root", `{ d: Date("2024-02-29"), i: Instant("2026-11-09T14:30:00+01:00"), p: Duration("PT1H30M") }`)
    expect(DateTime.isDateTime(ok.i)).toBe(true)
    for (const bad of [`d: Date("2026-02-29")`, `i: Instant("2016-12-31T23:59:60Z")`, `i: Instant("2026-11-09 14:30:00Z")`, `p: Duration("PT")`]) {
      const data = `{ d: Date("2024-02-29"), i: Instant("2026-11-09T14:30:00Z"), p: Duration("PT1S"), ${bad} }`
      expect(Exit.isFailure(decodeWith(schema, "Root", data))).toBe(true)
    }
  })

  it("the checker knows exactly the types of spec/std", async () => {
    const { STD_MODULES } = await import("@haus-fmt/haus")
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
