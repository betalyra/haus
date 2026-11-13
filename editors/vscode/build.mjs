// Bundles the extension client and the language server into dist/.
// The server includes the haus parser straight from the TypeScript sources.
import * as esbuild from "esbuild"
import { fileURLToPath } from "node:url"

const haus = fileURLToPath(new URL("../../typescript/packages/haus/src/index.ts", import.meta.url))
const hausNode = fileURLToPath(new URL("../../typescript/packages/haus/src/node.ts", import.meta.url))
// --production (run by `vsce package` / `vsce publish`) minifies and drops source maps.
const production = process.argv.includes("--production")
const options = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  minify: production,
  sourcemap: !production,
  external: ["vscode"],
  alias: { "@haus-fmt/haus/node": hausNode, "@haus-fmt/haus": haus },
  logLevel: "info",
}
const builds = [
  { ...options, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js" },
  { ...options, entryPoints: ["src/server.ts"], outfile: "dist/server.js" },
]
if (process.argv.includes("--watch")) {
  for (const b of builds) await (await esbuild.context(b)).watch()
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)))
}
