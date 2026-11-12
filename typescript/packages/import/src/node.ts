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
import { loadEffect, moduleFor, targetOf, type ImportOptions } from "./generate.ts"

export async function register(options: ImportOptions = {}): Promise<void> {
  const target = targetOf(options)
  const effect = target === "effect" ? await loadEffect() : undefined
  const runtime = import.meta.resolve("./runtime.ts")
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith("file:") || !url.endsWith(".haus")) return nextLoad(url, context)
      const path = fileURLToPath(url)
      const { code } = moduleFor(readFileSync(path, "utf8"), path, target, runtime, effect)
      return { format: "module", source: code, shortCircuit: true }
    },
  })
}
