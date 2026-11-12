/**
 * The TypeScript 7.1 content mapper. TypeScript starts this process
 * (package.json#typescript.contentMapper) and asks it, per imported `.haus`
 * file, for a virtual TypeScript module (generate.ts). The target comes from
 * the tsconfig entry:
 *
 *   "contentMappers": [{ "package": "@haus-fmt/import", "extensions": [".haus"], "options": { "target": "effect" } }]
 *
 * Syntax and schema errors become diagnostics at the right place in the file.
 */
import { HausSyntaxError } from "@haus-fmt/haus"
import { runContentMapper, stringIndexToPosition } from "ts-content-mapper"
import { loadEffect, targetOf, typesFor, type ImportOptions, type Target } from "./generate.ts"

interface Project {
  readonly target: Target
  readonly effect: Awaited<ReturnType<typeof loadEffect>> | undefined
}

runContentMapper<ImportOptions, Project>({
  diagnosticSource: "haus",
  async openProject(params) {
    const target = targetOf(params.options)
    return { project: { target, effect: target === "effect" ? await loadEffect() : undefined } }
  },
  transform(params, context) {
    const at = (offset: number) => stringIndexToPosition(params.content, offset, context.positionEncoding)
    const { target, effect } = context.project
    try {
      const { text, diagnostics } = typesFor(params.content, params.fileName, target, effect)
      return {
        text,
        extension: ".mts",
        diagnostics: diagnostics.map((d) => ({ messageText: d.message, start: at(d.offset), length: d.length, code: 91002 })),
      }
    } catch (e) {
      if (!(e instanceof HausSyntaxError)) throw e
      return {
        text: params.fileName.endsWith(".schema.haus") ? "export {};\n" : "declare const value: unknown;\nexport default value;\n",
        extension: ".mts",
        diagnostics: [{ messageText: e.reason, start: at(e.offset), length: 1, code: 91001 }],
      }
    }
  },
})
