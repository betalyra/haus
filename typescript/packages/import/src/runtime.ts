/**
 * What generated `.haus` modules run, in Node or in a browser bundle. It has
 * no file system access: a schema file's imports were resolved when the
 * module was generated (generate.ts) and travel with it.
 */
import { parseSchemaFile, parseWithLocations, type ResolvedModule } from "@haus-fmt/haus"
import * as Haus from "@haus-fmt/effect"
import { Effect } from "effect"

/** Imported schema files by `from \0 module`, as the resolver saw them when the module was generated. */
export type Modules = Readonly<Record<string, ResolvedModule>>

/** Build the Effect schemas of a schema file, its imports answered from `modules`. */
export function compiled(text: string, modules: Modules, key: string, id: string): Haus.CompiledSchemaFile {
  return Haus.fromSchemaFile(parseSchemaFile(text, {
    key,
    id,
    resolver: {
      resolve(module, from) {
        const found = modules[`${from ?? ""}\0${module}`]
        if (!found) throw new Error(`schema import ${module} was not resolved when this module was generated`)
        return found
      },
    },
  }))
}

/** A data file's value decoded with its schema; throws with the position of the first error. */
export function decodeData(text: string, schema: Haus.CompiledSchemaFile, typeName: string, fileName: string): unknown {
  const root = schema.schemas[typeName]
  if (!root) throw new Error(`${fileName}: its schema file has no type ${typeName}`)
  const values = parseWithLocations(text)
  const decode = Haus.decodeValue(root)
  const decoded = values.map((value) =>
    Effect.runSync(
      decode(value).pipe(
        Effect.mapError((e) => {
          const at = Haus.locateIssue(value, e.path ?? [])
          const before = text.slice(0, at.start ?? 0).split("\n")
          return new Error(`${fileName}:${before.length}:${before.at(-1)!.length + 1}: ${e.message}`)
        }),
      ),
    ))
  if (schema.streams.has(typeName)) return decoded
  if (decoded.length !== 1) throw new Error(`${fileName}: expected exactly one value, found ${decoded.length}`)
  return decoded[0]
}
