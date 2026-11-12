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
 *   "plain"   haus schemas (Standard Schemas) from @haus-fmt/haus; no other dependencies
 *   "effect"  Effect schemas from @haus-fmt/effect
 *
 * Data files without a schema are plain values in both targets; data files
 * with a schema are decoded with it.
 */
import { parseSchemaFile, schemaDeclarations } from "@haus-fmt/haus"
import { schemaOptions } from "@haus-fmt/haus/node"
import { parsePlain, plainDeclarations } from "@haus-fmt/haus/plain"
import { dataModule, dataModuleSource, schemaFor, schemaModuleSource, specifier, type Diagnostic } from "./schemas.js"

export type Target = "plain" | "effect"

export interface ImportOptions {
  /** What `.haus` imports become. Default "plain". */
  readonly target?: Target
}

export type { Diagnostic }

export const targetOf = (options: { readonly target?: unknown } | undefined): Target => {
  const t = options?.target ?? "plain"
  if (t !== "plain" && t !== "effect") throw new Error(`@haus-fmt/import: target must be "plain" or "effect", found ${JSON.stringify(t)}`)
  return t
}

/** What differs between the targets. */
export interface Backend {
  readonly target: Target
  /** Declarations for a `.schema.haus` file: its types and schemas. */
  readonly schemaTypes: (text: string, fileName: string) => string
  /** The runtime generated modules import (runtime/plain.ts or runtime/effect.ts), as `@haus-fmt/import/runtime/<target>`. */
  readonly runtime: string
}

const plain: Backend = {
  target: "plain",
  schemaTypes: (text, fileName) =>
    schemaDeclarations(parseSchemaFile(text, schemaOptions(fileName)), { haus: specifier(fileName, "@haus-fmt/haus/schema") }),
  runtime: "runtime/plain",
}

/** The backend for a target. The Effect one is loaded only when a project asks for it, so plain projects need no Effect. */
export async function backend(target: Target): Promise<Backend> {
  if (target === "plain") return plain
  const { effectSchemaTypes } = await import("./effect.js")
  return { target, schemaTypes: effectSchemaTypes, runtime: "runtime/effect" }
}

/** TypeScript declarations for an imported `.haus` file, with diagnostics for the file. */
export function typesFor(text: string, fileName: string, b: Backend): { text: string; diagnostics: Diagnostic[] } {
  if (fileName.endsWith(".schema.haus")) return { text: b.schemaTypes(text, fileName), diagnostics: [] }
  const link = schemaFor(fileName, text)
  if (link) return dataModule(text, fileName, link)
  return { text: plainDeclarations(text, fileName), diagnostics: [] }
}

/**
 * JavaScript for an imported `.haus` file, and the files it was built from
 * (to watch). `importRuntime` turns `runtime/<target>` into the specifier the
 * module imports it by.
 */
export function moduleFor(text: string, fileName: string, b: Backend, importRuntime: (path: string) => string): { code: string; files: string[] } {
  const runtime = importRuntime(b.runtime)
  if (fileName.endsWith(".schema.haus")) return schemaModuleSource(fileName, runtime)
  const link = schemaFor(fileName, text)
  if (link) return dataModuleSource(text, fileName, link, runtime)
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
