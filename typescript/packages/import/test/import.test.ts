import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { loadEffect, moduleFor, typesFor } from "../src/generate.ts"
import haus from "../src/vite.ts"

const examples = join(import.meta.dirname, "../../../../examples")
const runtime = pathToFileURL(join(import.meta.dirname, "../src/runtime.ts")).href
const read = (name: string) => execFileSync("cat", [join(examples, name)], { encoding: "utf8" })

/** Load generated module code as a real ES module. */
const load = async (code: string) => {
  const dir = mkdtempSync(join(tmpdir(), "haus-import-"))
  const file = join(dir, "module.mjs")
  writeFileSync(file, code)
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>
}

describe("plain target", () => {
  it("types and values of a data file without a schema agree", async () => {
    const text = read("person.haus")
    const types = typesFor(text, join(examples, "person.haus"), "plain")
    expect(types.diagnostics).toEqual([])
    expect(types.text).toContain("export default person")
    const { code, files } = moduleFor(text, join(examples, "person.haus"), "plain", runtime)
    expect(files).toEqual([])
    expect(code).not.toContain("import")
    const value = (await load(code)).default as readonly { readonly name: string }[]
    expect(value[0]?.name).toEqual(expect.any(String))
  })

  it("says that schema files need the effect target", () => {
    expect(typesFor(read("thread.schema.haus"), join(examples, "thread.schema.haus"), "plain").diagnostics[0]?.message).toContain('target: "effect"')
    expect(typesFor(read("thread.haus"), join(examples, "thread.haus"), "plain").diagnostics[0]?.message).toContain("has a schema")
    expect(() => moduleFor(read("thread.haus"), join(examples, "thread.haus"), "plain", runtime)).toThrow('target: "effect"')
  })
})

describe("effect target", async () => {
  const effect = await loadEffect()

  it("data with a schema is decoded with it", async () => {
    const { code, files } = moduleFor(read("thread.haus"), join(examples, "thread.haus"), "effect", runtime, effect)
    expect(files).toEqual([join(examples, "thread.schema.haus")])
    const thread = (await load(code)).default as { readonly likes: bigint }
    expect(typeof thread.likes).toBe("bigint")
  })

  it("schema imports are resolved when the module is generated, without absolute paths", async () => {
    const { code, files } = moduleFor(read("order.schema.haus"), join(examples, "order.schema.haus"), "effect", runtime, effect)
    expect(files.length).toBeGreaterThan(1) // the schema file and the packages it imports
    expect(code).not.toContain(examples)
    const mod = await load(code)
    expect(mod.Root).toBeDefined()
    expect(mod.Status).toBeDefined()
  })
})

describe("vite plugin", () => {
  it("loads .haus files and watches their schema files", async () => {
    const plugin = haus({ target: "effect" })
    const watched: string[] = []
    const load = plugin.load as (this: unknown, id: string) => Promise<{ code: string } | null>
    const ctx = { addWatchFile: (f: string) => watched.push(f) }
    expect(await load.call(ctx, "/x/main.ts")).toBeNull()
    const out = await load.call(ctx, `${join(examples, "thread.haus")}?import`)
    expect(out?.code).toContain('from "@haus-fmt/import/runtime"')
    expect(watched).toEqual([join(examples, "thread.schema.haus")])
  })

  it("rejects an unknown target", () => {
    expect(() => haus({ target: "zod" as never })).toThrow('"plain" or "effect"')
  })
})

describe("node loader", () => {
  it("imports .haus files at runtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "haus-node-"))
    writeFileSync(join(dir, "data.haus"), `{ name: "Ada", total: 30.30, status: Shipped }`)
    writeFileSync(join(dir, "main.mjs"), `import data from "./data.haus"; console.log(JSON.stringify(data))`)
    const register = join(import.meta.dirname, "../src/register/plain.ts")
    const out = execFileSync(process.execPath, ["--import", pathToFileURL(register).href, join(dir, "main.mjs")], { encoding: "utf8" })
    expect(JSON.parse(out)).toEqual({ name: "Ada", total: "30.30", status: "Shipped" })
  })
})
