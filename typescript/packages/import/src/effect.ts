/**
 * The Effect target's declarations for a `.schema.haus` file: its types and
 * their Effect schemas. Loaded only when a project uses the Effect target.
 */
import { parseSchemaFile } from "@haus-fmt/haus"
import { schemaOptions } from "@haus-fmt/haus/node"
import * as Haus from "@haus-fmt/effect"
import { specifier } from "./schemas.js"

export function effectSchemaTypes(text: string, fileName: string): string {
  return Haus.schemaDeclarations(parseSchemaFile(text, schemaOptions(fileName)), {
    effect: specifier(fileName, "effect"),
    haus: specifier(fileName, "@haus-fmt/effect"),
  })
}
