import { describe, expect, it } from "vitest"
import { checkData, HausSchemaFileError, parseSchemaFile, parseWithLocations, type ModuleResolver } from "../src/index.js"

/** An in-memory resolver: files by key, packages by name. */
const memory = (files: Record<string, string>, packages: Record<string, { key: string; id: string; version: string }> = {}): ModuleResolver => ({
  resolve(module, from) {
    const pkg = packages[module]
    if (pkg) return { ...pkg, text: files[pkg.key]! }
    if (module.startsWith("./")) {
      const key = module.slice(2)
      if (files[key] === undefined) throw new Error(`file not found: ${key} (from ${from})`)
      return { key, id: `app/${key}`, text: files[key]! }
    }
    throw new Error("package not found")
  },
})

const money = `
  // Money(19.99, EUR)
  type Money = closed < Money Decimal Currency >
  type Currency = < >`

const resolver = memory(
  { money, common: "type Address = { street: String, city: City }\ntype City = String", order: "import ./common (Address)\ntype Order = { to: Address }" },
  { "@haus/money": { key: "money", id: "@haus/money@1", version: "1.2.0" } },
)

const schemaError = (text: string, r: ModuleResolver | null = resolver): string => {
  try {
    parseSchemaFile(text, r ? { resolver: r, id: "app/root" } : {})
  } catch (e) {
    if (e instanceof HausSchemaFileError) return e.message
    throw e
  }
  throw new Error("no error")
}

describe("imports", () => {
  it("imports types from packages and files, with ids", () => {
    const file = parseSchemaFile(`
      import @haus/money (Money)
      import ./common (Address)
      type Root = { total: Money, to: Address }`, { resolver, id: "app/root" })
    expect(file.definitions.map((d) => d.id)).toEqual(["app/root#Root"])
    expect(file.imported.get("Money")?.id).toBe("@haus/money@1#Money")
    expect(file.imported.get("Address")?.id).toBe("app/common#Address")
    expect(file.definition("Money")?.module).toBe("@haus/money@1")
    const values = parseWithLocations(`{ total: Money(19.99, EUR), to: { street: "Rua A", city: "Lisboa" } }`)
    expect(checkData(file, "Root", values).filter((i) => i.severity === "error")).toEqual([])
    const wrong = parseWithLocations(`{ total: Money(19.99), to: { street: 1, city: "Lisboa" } }`)
    expect(checkData(file, "Root", wrong).filter((i) => i.severity === "error").map((i) => i.message)).toHaveLength(2)
  })

  it("keeps types of different files apart, even with the same name", () => {
    const r = memory({ a: "type T = Int\ntype A = { t: T }", b: "type T = String\ntype B = { t: T }" })
    const file = parseSchemaFile("import ./a (A)\nimport ./b (B)\ntype Root = { a: A, b: B }", { resolver: r })
    const ok = parseWithLocations(`{ a: { t: 1 }, b: { t: "x" } }`)
    expect(checkData(file, "Root", ok).filter((i) => i.severity === "error")).toEqual([])
  })

  it("imports a file only once (diamonds) and resolves files from the importing file", () => {
    const file = parseSchemaFile("import ./order (Order)\nimport ./common (Address)\ntype Root = { o: Order, a: Address }", { resolver, id: "app/root" })
    expect(file.imported.get("Address")?.id).toBe("app/common#Address")
  })

  it("checks a major version in the import", () => {
    expect(() => parseSchemaFile("import @haus/money@1 (Money)\ntype Root = Money", { resolver })).not.toThrow()
    expect(schemaError("import @haus/money@2 (Money)\ntype Root = Money")).toContain("wants major version 2, but version 1.2.0 was found")
  })

  it("reports what can't be imported", () => {
    expect(schemaError("import @haus/money (Monee)")).toContain("@haus/money has no type Monee (it has Money, Currency)")
    expect(schemaError("import @haus/nope (X)")).toContain("can't import @haus/nope: package not found")
    expect(schemaError("import ./missing (X)")).toContain("can't import ./missing: file not found")
    expect(schemaError("import @haus/money (Money)", null)).toContain("no module resolver")
    expect(schemaError("import @haus/money (Money)\ntype Money = Int")).toContain("type Money is already imported")
    expect(schemaError("import @haus/money (Money)\nimport @haus/money (Money)")).toContain("Money is imported twice")
  })

  it("points errors in an imported file at the import, with their place there", () => {
    const r = memory({ bad: "type A = { x: Nope }" })
    expect(schemaError("import ./bad (A)", r)).toBe("./bad (1:15): unknown type Nope at 1:1")
  })

  it("rejects import cycles", () => {
    const r = memory({ a: "import ./b (B)\ntype A = { b: Maybe B }", b: "import ./a (A)\ntype B = { a: Maybe A }" })
    expect(schemaError("import ./a (A)", r)).toContain("import cycle")
  })

  it("std/money moved to @haus/money", () => {
    expect(schemaError("import std/money (Money)")).toContain("std/money is no longer a standard module; it is the package @haus/money: import @haus/money (Money)")
    expect(schemaError("type Root = { price: Money }")).toContain("import it with: import @haus/money (Money)")
  })
})
