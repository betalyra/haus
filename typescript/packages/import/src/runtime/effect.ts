/**
 * What generated `.haus` modules of the Effect target run, in Node or in a
 * browser bundle. It has no file system access: a schema file's imports were
 * resolved when the module was generated and travel with it.
 */
import { parseSchemaFile, parseWithLocations } from "@haus-fmt/haus"
import * as Haus from "@haus-fmt/effect"
import { Effect } from "effect"
import { located, resolverOf, type Modules } from "./shared.js"

export type { Modules }

/** Build the Effect schemas of a schema file, its imports answered from `modules`. */
export function compiled(text: string, modules: Modules, key: string, id: string): Haus.CompiledSchemaFile {
  return Haus.fromSchemaFile(parseSchemaFile(text, { key, id, resolver: resolverOf(modules) }))
}

/** A data file's value decoded with its schema; throws with the position of the first error. */
export function decodeData(text: string, schema: Haus.CompiledSchemaFile, typeName: string, fileName: string): unknown {
  const root = schema.schemas[typeName]
  if (!root) throw new Error(`${fileName}: its schema file has no type ${typeName}`)
  const decode = Haus.decodeValue(root)
  const decoded = parseWithLocations(text).map((value) =>
    Effect.runSync(decode(value).pipe(Effect.mapError((e) => located(text, fileName, Haus.locateIssue(value, e.path ?? []).start, e.message)))))
  if (schema.streams.has(typeName)) return decoded
  if (decoded.length !== 1) throw new Error(`${fileName}: expected exactly one value, found ${decoded.length}`)
  return decoded[0]
}
