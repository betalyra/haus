import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { backend, moduleFor, typesFor } from "../src/generate.js"
import haus from "../src/vite.js"

const examples = join(import.meta.dirname, "../../../../examples")
const at = (name: string) => join(examples, name)
const read = (name: string) => readFileSync(at(name), "utf8")
const runtimeOf = (path: string) => pathToFileURL(join(import.meta.dirname, `../src/${path}.ts`)).href

/** Load generated module code as a real ES module. */
const load = async (code: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "haus-import-")), "module.mjs")
  writeFileSync(file, code)
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>
}

describe("plain target", async () => {
  const plain = await backend("plain")

  it("data without a schema: plain values, typed by the data", async () => {
    const types = typesFor(read("person.haus"), at("person.haus"), plain)
    expect(types.diagnostics).toEqual([])
    expect(types.text).toContain("export default person")
    const { code, files } = moduleFor(read("person.haus"), at("person.haus"), plain, runtimeOf)
    expect(files).toEqual([])
    expect(code).not.toContain("import")
    const value = (await load(code)).default as readonly { readonly name: string }[]
    expect(value[0]?.name).toEqual(expect.any(String))
  })

  it("schema files: types and haus schemas (Standard Schemas)", async () => {
    const types = typesFor(read("thread.schema.haus"), at("thread.schema.haus"), plain)
    expect(types.text).toContain("export declare const Comment: h$.Schema<Comment>")
    expect(types.text).not.toContain("effect")
    const { code } = moduleFor(read("thread.schema.haus"), at("thread.schema.haus"), plain, runtimeOf)
    expect(code).not.toContain("effect")
    const { Comment } = (await load(code)) as { Comment: { "~standard": { vendor: string } } }
    expect(Comment["~standard"].vendor).toBe("haus")
  })

  it("data with a schema: decoded with it", async () => {
    const { code } = moduleFor(read("thread.haus"), at("thread.haus"), plain, runtimeOf)
    const thread = (await load(code)).default as { readonly likes: bigint; readonly at: string }
    expect(typeof thread.likes).toBe("bigint")
    expect(thread.at).toBe("2026-11-01T09:00:00Z") // std/time values keep their text
  })

  it("data that doesn't match its schema fails with its position", async () => {
    const dir = mkdtempSync(join(tmpdir(), "haus-bad-"))
    writeFileSync(join(dir, "x.schema.haus"), "type Root = { n: Int }")
    writeFileSync(join(dir, "x.haus"), `{\n  n: "one",\n}`)
    const { code } = moduleFor(readFileSync(join(dir, "x.haus"), "utf8"), join(dir, "x.haus"), plain, runtimeOf)
    await expect(load(code)).rejects.toThrow(/x\.haus:2:6: expected Int/)
  })
})

describe("effect target", async () => {
  const effect = await backend("effect")

  it("data with a schema is decoded with Effect", async () => {
    const { code, files } = moduleFor(read("thread.haus"), at("thread.haus"), effect, runtimeOf)
    expect(files).toEqual([at("thread.schema.haus")])
    const thread = (await load(code)).default as { readonly likes: bigint }
    expect(typeof thread.likes).toBe("bigint")
  })

  it("schema imports are resolved when the module is generated, without absolute paths", async () => {
    const { code, files } = moduleFor(read("order.schema.haus"), at("order.schema.haus"), effect, runtimeOf)
    expect(files.length).toBeGreaterThan(1) // the schema file and the packages it imports
    expect(code).not.toContain(examples)
    const mod = await load(code)
    expect(mod.Root).toBeDefined()
    expect(mod.Status).toBeDefined()
  })
})

describe("Secret, Any and attributes", async () => {
  const SECRET = "hunter2-ZQXJ9WVK"
  const schema = `type Root = { name: String, @deprecated("use token") key?: Secret String, token?: Secret String, extra: Any }`
  /** A schema file and a data file in a fresh directory. */
  const files = (data: string) => {
    const dir = mkdtempSync(join(tmpdir(), "haus-secret-"))
    writeFileSync(join(dir, "x.schema.haus"), schema)
    writeFileSync(join(dir, "x.haus"), data)
    return { schema: join(dir, "x.schema.haus"), data: join(dir, "x.haus") }
  }
  const good = `{ name: "a", key: "${SECRET}", extra: Order { id: 1 } }`
  const bad = `{\n  name: "a",\n  key: 98765432,\n  extra: 1,\n}`

  for (const target of ["plain", "effect"] as const) {
    it(`${target}: declarations, decoding and errors without the value`, async () => {
      const b = await backend(target)
      const { schema: schemaPath, data } = files(good)
      const types = typesFor(schema, schemaPath, b).text
      expect(types).toContain(target === "plain" ? "key?: h$.Secret<string>" : "key?: Redacted$.Redacted<string>")
      expect(types).toContain(target === "plain" ? "readonly extra: h$.Value" : "readonly extra: Haus$.Value")
      expect(types).toContain("/** @deprecated use token */ readonly key?:")

      const root = (await load(moduleFor(good, data, b, runtimeOf).code)).default as { key: unknown; extra: { kind: string } }
      expect(String(root.key)).toBe("<redacted>")
      expect(JSON.stringify(root)).not.toContain(SECRET)
      expect(root.extra.kind).toBe("variant")

      const wrong = files(bad)
      const diagnostics = typesFor(bad, wrong.data, b).diagnostics
      expect(diagnostics.map((d) => d.message)).toEqual(["expected String (a Secret: the value is not shown) (x.schema.haus: Root)"])
      const failed = await load(moduleFor(bad, wrong.data, b, runtimeOf).code).then(() => "loaded", (e: Error) => e.message)
      expect(failed).toMatch(/^x\.haus:3:\d+: expected String \(a Secret: the value is not shown\)/)
      expect(failed).not.toContain("98765432")
    })
  }
})

describe("vite plugin", () => {
  it("loads .haus files and watches their schema files", async () => {
    const plugin = haus({ target: "effect" })
    const watched: string[] = []
    const loadHook = plugin.load as (this: unknown, id: string) => Promise<{ code: string } | null>
    const ctx = { addWatchFile: (f: string) => watched.push(f) }
    expect(await loadHook.call(ctx, "/x/main.ts")).toBeNull()
    const out = await loadHook.call(ctx, `${at("thread.haus")}?import`)
    expect(out?.code).toContain('from "@haus-fmt/import/runtime/effect"')
    expect(watched).toEqual([at("thread.schema.haus")])
  })

  it("rejects an unknown target", () => {
    expect(() => haus({ target: "zod" as never })).toThrow('"plain" or "effect"')
  })
})

describe("node loader (built)", () => {
  it("imports .haus files at runtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "haus-node-"))
    writeFileSync(join(dir, "data.haus"), `{ name: "Ada", total: 30.30, status: Shipped }`)
    writeFileSync(join(dir, "main.mjs"), `import data from "./data.haus"; console.log(JSON.stringify(data))`)
    const register = join(import.meta.dirname, "../dist/register/plain.js")
    const out = execFileSync(process.execPath, ["--import", pathToFileURL(register).href, join(dir, "main.mjs")], { encoding: "utf8" })
    expect(JSON.parse(out)).toEqual({ name: "Ada", total: "30.30", status: "Shipped" })
  })
})
