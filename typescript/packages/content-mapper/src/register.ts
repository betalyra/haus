/**
 * Node loader for .haus imports, the runtime half of the content mapper:
 *
 *   node --import @betalyra/haus-fmt-content-mapper/register main.ts
 *
 * - `x.schema.haus` exports its types' Effect schemas;
 * - `x.haus` with a schema (a `// schema:` comment, or `x.schema.haus` next
 *   to it) is decoded with it (a mismatch throws, with the position);
 * - any other `x.haus` yields the values the content mapper typed (plain.ts).
 */
import { readFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"
import { dataModuleSource, schemaFor, schemaModuleSource } from "./effect.ts"
import { moduleSource } from "./plain.ts"

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".haus")) return nextLoad(url, context)
    const path = fileURLToPath(url)
    const text = readFileSync(path, "utf8")
    const link = schemaFor(path, text)
    const source = path.endsWith(".schema.haus") ? schemaModuleSource(text, path)
      : link ? dataModuleSource(text, path, link)
      : moduleSource(text)
    return { format: "module", source, shortCircuit: true }
  },
})
