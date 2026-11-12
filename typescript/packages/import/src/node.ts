/**
 * The Node loader: `.haus` imports at runtime, without a bundler.
 *
 *   node --import @haus-fmt/import/register main.ts           (target "plain")
 *   node --import @haus-fmt/import/register/effect main.ts    (target "effect")
 *
 * or, with options, from your own register file: `await register({ target: "effect" })`.
 * Use the same target as in tsconfig.json, so the types match the values.
 */
import { readFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"
import { backend, moduleFor, targetOf, type ImportOptions } from "./generate.js"

export async function register(options: ImportOptions = {}): Promise<void> {
  const b = await backend(targetOf(options))
  const importRuntime = (path: string) => import.meta.resolve(`./${path}.js`)
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith("file:") || !url.endsWith(".haus")) return nextLoad(url, context)
      const path = fileURLToPath(url)
      const { code } = moduleFor(readFileSync(path, "utf8"), path, b, importRuntime)
      return { format: "module", source: code, shortCircuit: true }
    },
  })
}
