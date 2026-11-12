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
import { checkData, HausSyntaxError, parseSchemaFile, parseWithLocations, schemaReference, type ParseSchemaOptions, type ResolvedModule } from "@haus-fmt/haus"
import { schemaOptions } from "@haus-fmt/haus/node"
import * as Haus from "@haus-fmt/effect"

import type { Diagnostic } from "./generate.ts"

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
 * Where the declarations import a package's types from: its name when the
 * file's project has it, otherwise the copy this package uses (by absolute path).
 */
function specifier(fileName: string, pkg: string): string {
  for (let dir = dirname(fileName); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", ...pkg.split("/"), "package.json"))) return pkg
    if (dirname(dir) === dir) break
  }
  return fileURLToPath(import.meta.resolve(pkg))
}

const effectSpecifier = (fileName: string): string => specifier(fileName, "effect")

/** Declarations for a `.schema.haus` file: its types and their Effect schemas (imports resolved from its place). */
export function schemaModule(text: string, fileName: string): string {
  return Haus.schemaDeclarations(parseSchemaFile(text, schemaOptions(fileName)), {
    effect: effectSpecifier(fileName),
    haus: specifier(fileName, "@haus-fmt/effect"),
  })
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
    file = parseSchemaFile(readFileSync(link.path, "utf8"), schemaOptions(link.path))
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

// ── runtime ──────────────────────────────────────────────────

/**
 * Parse options for a schema file that also record every import the
 * resolver finds, under short keys (no absolute paths end up in a bundle).
 * The recorded modules let runtime.ts rebuild the schema without a file system.
 */
function recording(path: string): { options: ParseSchemaOptions; modules: Record<string, ResolvedModule>; readonly files: string[] } {
  const base = schemaOptions(path)
  const short = new Map<string, string>()
  const real = new Map<string, string>()
  const shorten = (key: string) => {
    let k = short.get(key)
    if (k === undefined) {
      k = `m${short.size}`
      short.set(key, k)
      real.set(k, key)
    }
    return k
  }
  const modules: Record<string, ResolvedModule> = {}
  const root = shorten(base.key!)
  return {
    modules,
    options: {
      key: root,
      id: base.id!,
      resolver: {
        resolve(module, from) {
          const found = base.resolver!.resolve(module, from === undefined ? undefined : real.get(from))
          const resolved = { ...found, key: shorten(found.key) }
          modules[`${from ?? ""}\0${module}`] = resolved
          return resolved
        },
      },
    },
    get files() {
      return [...short.keys()]
    },
  }
}

/** The JS expression that rebuilds a schema file's Effect schemas at runtime, and the files it was built from. */
function compiledExpression(schemaPath: string, runtime: string): { code: string; files: string[] } {
  const text = readFileSync(schemaPath, "utf8")
  const r = recording(schemaPath)
  parseSchemaFile(text, r.options) // resolves (and records) every import, and reports errors now
  return {
    code: `import { compiled, decodeData } from ${JSON.stringify(runtime)};\n` +
      `const schema = compiled(${JSON.stringify(text)}, ${JSON.stringify(r.modules)}, ${JSON.stringify(r.options.key)}, ${JSON.stringify(r.options.id)});\n`,
    files: r.files,
  }
}

/** Module source for a `.schema.haus` file: its Effect schemas as named exports. */
export function schemaModuleSource(path: string, runtime: string): { code: string; files: string[] } {
  const { code, files } = compiledExpression(path, runtime)
  const names = parseSchemaFile(readFileSync(path, "utf8"), schemaOptions(path)).definitions.filter((d) => d.params.length === 0).map((d) => d.name)
  return { code: code + names.map((n) => `export const ${n} = schema.schemas[${JSON.stringify(n)}];\n`).join(""), files }
}

/** Module source for a data file with a schema: decoded with it when the module loads. */
export function dataModuleSource(text: string, fileName: string, link: SchemaLink, runtime: string): { code: string; files: string[] } {
  const { code, files } = compiledExpression(link.path, runtime)
  return {
    code: code + `export default decodeData(${JSON.stringify(text)}, schema, ${JSON.stringify(link.type)}, ${JSON.stringify(basename(fileName))});\n`,
    files,
  }
}
