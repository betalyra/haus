/**
 * What generated `.haus` modules of the plain target run, in Node or in a
 * browser bundle: haus schemas (Standard Schemas), no other dependencies and
 * no file system. A schema file's imports were resolved when the module was
 * generated and travel with it.
 */
import { fromSchemaFile, parseSchemaFile, parseWithLocations, type CompiledSchemaFile, type Value } from "@haus-fmt/haus"
import * as h from "@haus-fmt/haus/schema"
import { located, resolverOf, type Modules } from "./shared.js"

export type { Modules }

/** Build the schemas of a schema file, its imports answered from `modules`. */
export function compiled(text: string, modules: Modules, key: string, id: string): CompiledSchemaFile {
  return fromSchemaFile(parseSchemaFile(text, { key, id, resolver: resolverOf(modules) }))
}

/** The place of a decode error's path inside a parsed value. */
function locate(value: Value, path: readonly (string | number)[]): number | undefined {
  let at: Value | undefined = value
  for (const seg of path) {
    if (!at) break
    if (at.kind === "record") at = at.fields.get(String(seg))
    else if (at.kind === "array") at = typeof seg === "number" ? at.items[seg] : undefined
    else if (at.kind === "variant") at = typeof seg === "number" ? at.args[seg] : at.args[0]?.kind === "record" ? at.args[0].fields.get(seg) : undefined
    else at = undefined
    if (at?.start === undefined) break
    value = at
  }
  return value.start
}

/** A data file's value decoded with its schema; throws with the position of the first error. */
export function decodeData(text: string, schema: CompiledSchemaFile, typeName: string, fileName: string): unknown {
  const root = schema.schemas[typeName]
  if (!root) throw new Error(`${fileName}: its schema file has no type ${typeName}`)
  const decoded = parseWithLocations(text).map((value) => {
    try {
      return h.decode(root, value)
    } catch (e) {
      if (!(e instanceof h.HausDecodeError)) throw e
      throw located(text, fileName, locate(value, e.path), e.message)
    }
  })
  if (schema.streams.has(typeName)) return decoded
  if (decoded.length !== 1) throw new Error(`${fileName}: expected exactly one value, found ${decoded.length}`)
  return decoded[0]
}
