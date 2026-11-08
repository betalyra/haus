/**
 * The schema-driven view of .haus files, with Effect:
 *
 *   import { Order } from "./order.schema.haus"   // an Effect schema, typed
 *   import orders from "./orders.haus"            // typed by its schema, and checked against it
 *
 * A data file's schema is named in a comment at its top
 * (`// schema: ./api.schema.haus#Order`), or else it is the schema file next
 * to it with its type `Root` (`orders.haus` → `orders.schema.haus`). Data
 * files without one keep the types inferred from their data (plain.ts).
 */
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { checkData, HausSyntaxError, parseSchemaFile, parseWithLocations, schemaReference } from "@betalyra/haus-fmt"
import * as Haus from "@betalyra/haus-fmt-effect"
import { Effect } from "effect"

export interface Diagnostic {
  readonly message: string
  readonly offset: number
  readonly length: number
}

/** The schema of a data file: the file and the type that describes the whole file. */
export interface SchemaLink {
  readonly path: string
  readonly type: string
  /** Where a `// schema:` comment names it. */
  readonly offset: number
}

/** The schema for a data file, if it has one: named in a comment, or the `.schema.haus` file next to it. */
export function schemaFor(dataFile: string, text: string): SchemaLink | undefined {
  if (dataFile.endsWith(".schema.haus")) return undefined
  const ref = schemaReference(text)
  if (ref) return { path: resolve(dirname(dataFile), ref.path), type: ref.type, offset: ref.start }
  const path = dataFile.replace(/\.haus$/, ".schema.haus")
  return existsSync(path) ? { path, type: "Root", offset: 0 } : undefined
}

/**
 * Where the declarations import Effect's types from: `effect` when the file's
 * project has it, otherwise the copy this package uses (by absolute path).
 */
export function effectSpecifier(fileName: string): string {
  for (let dir = dirname(fileName); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", "effect", "package.json"))) return "effect"
    if (dirname(dir) === dir) break
  }
  return fileURLToPath(import.meta.resolve("effect"))
}

const compiled = new Map<string, Haus.CompiledSchemaFile>()

/** Compile a schema file (cached by its text). */
function compile(text: string): Haus.CompiledSchemaFile {
  let c = compiled.get(text)
  if (!c) {
    if (compiled.size > 64) compiled.clear()
    c = Haus.compileSchemaFile(text)
    compiled.set(text, c)
  }
  return c
}

/** Declarations for a `.schema.haus` file: its types and their Effect schemas. */
export function schemaModule(text: string, fileName: string): string {
  return Haus.schemaDeclarations(parseSchemaFile(text), { effect: effectSpecifier(fileName) })
}

const identifier = (fileName: string) => {
  const stem = basename(fileName).replace(/\.haus$/, "")
  const camel = stem.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))
  return /^[A-Za-z_$]/.test(camel) && !RESERVED.has(camel) ? camel : `_${camel}`
}
const RESERVED = new Set(["default", "class", "function", "var", "let", "const", "new", "delete", "enum", "export", "import", "in", "this", "void", "with", "yield", "await"])

/** Declarations for a data file with a schema, plus where the data doesn't match it. */
export function dataModule(text: string, fileName: string, link: SchemaLink): { text: string; diagnostics: Diagnostic[] } {
  const name = identifier(fileName)
  const schemaName = basename(link.path)
  const fallback = (message: string) => ({
    text: `declare const ${name}: unknown;\nexport default ${name};\n`,
    diagnostics: [{ message, offset: link.offset, length: 1 }],
  })
  if (!existsSync(link.path)) return fallback(`schema file not found: ${link.path}`)
  let file
  try {
    file = parseSchemaFile(readFileSync(link.path, "utf8"))
  } catch (e) {
    if (e instanceof HausSyntaxError) return fallback(`${schemaName}: ${e.message}`)
    throw e
  }
  const definition = file.definition(link.type)
  if (!definition || definition.params.length > 0) return fallback(`${schemaName} has no type ${link.type} (without parameters) to describe the whole file`)
  const values = parseWithLocations(text)
  const specifier = relative(dirname(fileName), link.path).replaceAll("\\", "/")
  const type = definition.template.stream ? `ReadonlyArray<${link.type}>` : link.type
  const doc = Haus.definitionDoc(definition, `${basename(fileName)}, checked against ${schemaName}:\n\n`)
  const diagnostics = checkData(file, link.type, values)
    .filter((i) => i.severity === "error")
    .map((i) => ({ message: `${i.message} (${schemaName}: ${link.type})`, offset: i.start, length: i.end - i.start }))
  return {
    text: `import type { ${link.type} } from ${JSON.stringify(specifier.startsWith(".") ? specifier : `./${specifier}`)};\n${doc}declare const ${name}: ${type};\nexport default ${name};\n`,
    diagnostics,
  }
}

// ── runtime (the Node loader) ────────────────────────────────

/** The decoded value of a data file, checked against its schema; throws with the position of the first error. */
export function decodeData(text: string, schemaText: string, typeName: string, fileName: string): unknown {
  const { schemas, streams } = compile(schemaText)
  const root = schemas[typeName]
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
  if (streams.has(typeName)) return decoded
  if (decoded.length !== 1) throw new Error(`${fileName}: expected exactly one value, found ${decoded.length}`)
  return decoded[0]
}

/** Module source for a `.schema.haus` file: its Effect schemas as named exports. */
export function schemaModuleSource(text: string): string {
  const names = parseSchemaFile(text).definitions.filter((d) => d.params.length === 0).map((d) => d.name)
  const effect = import.meta.resolve("@betalyra/haus-fmt-effect")
  return `import { compileSchemaFile } from ${JSON.stringify(effect)};\n` +
    `const { schemas } = compileSchemaFile(${JSON.stringify(text)});\n` +
    names.map((n) => `export const ${n} = schemas[${JSON.stringify(n)}];\n`).join("")
}

/** Module source for a data file with a schema file. */
export function dataModuleSource(text: string, fileName: string, link: SchemaLink): string {
  return `import { decodeData } from ${JSON.stringify(import.meta.url)};\n` +
    `export default decodeData(${JSON.stringify(text)}, ${JSON.stringify(readFileSync(link.path, "utf8"))}, ${JSON.stringify(link.type)}, ${JSON.stringify(basename(fileName))});\n`
}
