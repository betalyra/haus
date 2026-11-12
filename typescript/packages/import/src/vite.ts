/**
 * The Vite plugin: `.haus` imports in Vite projects (dev server and build).
 *
 *   // vite.config.ts
 *   import haus from "@haus-fmt/import/vite"
 *   export default { plugins: [haus({ target: "effect" })] }
 *
 * Use the same target as in tsconfig.json, so the types match the values.
 * Plain data is baked into the bundle as JS values, so no haus parser ships to
 * the browser. With "effect", schema files and data with a schema are decoded
 * when the module loads; their schema imports are resolved at build time.
 */
import type { Plugin } from "vite"
import { readFileSync } from "node:fs"
import { loadEffect, moduleFor, targetOf, type ImportOptions } from "./generate.ts"

export default function haus(options: ImportOptions = {}): Plugin {
  const target = targetOf(options)
  const effect = target === "effect" ? loadEffect() : undefined
  return {
    name: "haus",
    enforce: "pre",
    async load(id) {
      const path = id.split("?")[0]!
      if (!path.endsWith(".haus")) return null
      const { code, files } = moduleFor(readFileSync(path, "utf8"), path, target, "@haus-fmt/import/runtime", await effect)
      for (const f of files) this.addWatchFile(f)
      return { code, map: null }
    },
  }
}
