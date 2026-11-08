/**
 * TypeScript 7.1 content mapper for .haus files. TypeScript starts this
 * process (package.json#typescript.contentMapper) and asks it, per imported
 * .haus file, for a virtual TypeScript module:
 *
 * - `x.schema.haus`: the schema's types and their Effect schemas (effect.ts);
 * - `x.haus` with a schema (a `// schema:` comment, or `x.schema.haus` next
 *   to it): typed by that schema, checked against it;
 * - any other `x.haus`: the type inferred from its data (plain.ts).
 *
 * Syntax and schema errors become diagnostics at the right place in the file.
 */
import { HausSyntaxError } from "@betalyra/haus-fmt"
import { runContentMapper, stringIndexToPosition } from "ts-content-mapper"
import { dataModule, schemaFor, schemaModule } from "./effect.ts"
import { declarations } from "./plain.ts"

runContentMapper({
  diagnosticSource: "haus",
  transform(params, context) {
    const at = (offset: number) => stringIndexToPosition(params.content, offset, context.positionEncoding)
    try {
      if (params.fileName.endsWith(".schema.haus")) return { text: schemaModule(params.content, params.fileName), extension: ".mts" }
      const link = schemaFor(params.fileName, params.content)
      if (link) {
        const { text, diagnostics } = dataModule(params.content, params.fileName, link)
        return {
          text,
          extension: ".mts",
          diagnostics: diagnostics.map((d) => ({ messageText: d.message, start: at(d.offset), length: d.length, code: 91002 })),
        }
      }
      return { text: declarations(params.content, params.fileName), extension: ".mts" }
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
