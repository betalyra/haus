/**
 * One generator for every way a `.haus` file is imported, so that the types
 * TypeScript sees and the values the program gets always agree:
 *
 *   typescript.ts  the content mapper: TypeScript declarations (typesFor)
 *   node.ts        the Node loader: JavaScript (moduleFor)
 *   vite.ts        the Vite plugin: JavaScript (moduleFor)
 *
 * The target decides what schemas become:
 *
 *   "plain"   data → plain JS values (the plain view of @haus-fmt/haus); no dependencies
 *   "effect"  `.schema.haus` → Effect schemas; data with a schema is decoded with it
 *
 * Data files without a schema are plain in both targets.
 */
import { plainDeclarations, parsePlain } from "@haus-fmt/haus/plain"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { schemaReference } from "@haus-fmt/haus"

export type Target = "plain" | "effect"

export interface ImportOptions {
  /** What `.haus` imports become. Default "plain". */
  readonly target?: Target
}

export const targetOf = (options: { readonly target?: unknown } | undefined): Target => {
  const t = options?.target ?? "plain"
  if (t !== "plain" && t !== "effect") throw new Error(`@haus-fmt/import: target must be "plain" or "effect", found ${JSON.stringify(t)}`)
  return t
}

export interface Diagnostic {
  readonly message: string
  readonly offset: number
  readonly length: number
}

/** The schema of a data file, without loading Effect: named in a comment, or the `.schema.haus` file next to it. */
export function schemaPathFor(dataFile: string, text: string): string | undefined {
  if (dataFile.endsWith(".schema.haus")) return undefined
  const ref = schemaReference(text)
  if (ref) return resolve(dirname(dataFile), ref.path)
  const path = dataFile.replace(/\.haus$/, ".schema.haus")
  return existsSync(path) ? path : undefined
}

const NEEDS_EFFECT = 'schema files need { target: "effect" } (schemas for the plain target are not built yet)'

type EffectModule = typeof import("./effect.ts")

/** Load the Effect side only when a project asks for it, so plain projects need no Effect. */
export const loadEffect = (): Promise<EffectModule> => import("./effect.ts")

/** TypeScript declarations for an imported `.haus` file, with diagnostics for the file. */
export function typesFor(text: string, fileName: string, target: Target, effect?: EffectModule): { text: string; diagnostics: Diagnostic[] } {
  if (target === "effect" && effect) {
    if (fileName.endsWith(".schema.haus")) return { text: effect.schemaModule(text, fileName), diagnostics: [] }
    const link = effect.schemaFor(fileName, text)
    if (link) return effect.dataModule(text, fileName, link)
  } else if (fileName.endsWith(".schema.haus")) {
    return { text: "export {};\n", diagnostics: [{ message: NEEDS_EFFECT, offset: 0, length: 1 }] }
  } else if (schemaPathFor(fileName, text)) {
    return { text: plainDeclarations(text, fileName), diagnostics: [{ message: `this file has a schema, but ${NEEDS_EFFECT}`, offset: 0, length: 1 }] }
  }
  return { text: plainDeclarations(text, fileName), diagnostics: [] }
}

/**
 * JavaScript for an imported `.haus` file, and the files it was built from
 * (to watch). `runtime` is how the module imports @haus-fmt/import/runtime.
 */
export function moduleFor(text: string, fileName: string, target: Target, runtime: string, effect?: EffectModule): { code: string; files: string[] } {
  if (target === "effect" && effect) {
    if (fileName.endsWith(".schema.haus")) return effect.schemaModuleSource(fileName, runtime)
    const link = effect.schemaFor(fileName, text)
    if (link) return effect.dataModuleSource(text, fileName, link, runtime)
  } else if (fileName.endsWith(".schema.haus") || schemaPathFor(fileName, text)) {
    throw new Error(`${fileName}: ${NEEDS_EFFECT}`)
  }
  return { code: `export default ${js(parsePlain(text))};\n`, files: [] }
}

/** A plain value as a JavaScript expression. */
function js(x: unknown): string {
  if (x === null) return "null"
  if (x instanceof Uint8Array) return `new Uint8Array([${x.join(",")}])`
  if (Array.isArray(x)) return `[${x.map(js).join(",")}]`
  if (typeof x === "object") {
    return `{${Object.entries(x as Record<string, unknown>).map(([k, v]) => `${k === "__proto__" ? '["__proto__"]' : JSON.stringify(k)}:${js(v)}`).join(",")}}`
  }
  return JSON.stringify(x)
}
