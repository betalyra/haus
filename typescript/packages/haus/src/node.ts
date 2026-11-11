/// <reference types="node" />
/**
 * Resolving schema imports from the file system (Node):
 *
 *   import @haus/money (Money)    → node_modules/@haus/money/haus.package.haus → its schema file
 *   import ./common (Address)     → ./common.schema.haus, next to the importing file
 *
 *   const file = parseSchemaFile(text, schemaOptions(path))
 *
 * A schema package has a manifest, `haus.package.haus`, next to its schema:
 *
 *   { name: "@haus/money", version: "1.2.0", schema: "money.schema.haus" }
 *
 * The manifest gives types their identity in every language
 * (`@haus/money@1#Money`), independent of how a package manager names the
 * package. Files outside a schema package are identified by the nearest
 * package.json name and their path (`my-app/src/order#Root`).
 */
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { parse } from "./index.js"
import type { ModuleResolver, ParseSchemaOptions, ResolvedModule } from "./schema-file.js"

export const MANIFEST = "haus.package.haus"
const EXTENSION = ".schema.haus"

export interface Manifest {
  readonly name: string
  readonly version: string
  /** The package's schema file, relative to the manifest. */
  readonly schema: string
  readonly dir: string
}

const manifests = new Map<string, Manifest | undefined>()

/** Read a schema package manifest (cached). */
export function readManifest(path: string): Manifest {
  const cached = manifests.get(path)
  if (cached) return cached
  const value = parse(readFileSync(path, "utf8"))
  const field = (key: string): string => {
    const f = value.kind === "record" ? value.fields.get(key) : undefined
    if (f?.kind !== "string") throw new Error(`${path}: the manifest needs a string field ${key}`)
    return f.value
  }
  const manifest = { name: field("name"), version: field("version"), schema: field("schema"), dir: dirname(path) }
  if (!/^@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(manifest.name)) throw new Error(`${path}: name must look like @org/name, found ${manifest.name}`)
  if (!/^\d+\.\d+\.\d+/.test(manifest.version)) throw new Error(`${path}: version must be semver (1.2.0), found ${manifest.version}`)
  manifests.set(path, manifest)
  return manifest
}

const ancestors = function* (dir: string): Generator<string> {
  for (let d = dir; ; d = dirname(d)) {
    yield d
    if (dirname(d) === d) return
  }
}

const stem = (path: string) => path.replaceAll(sep, "/").replace(/\.schema\.haus$/, "")

/** The identity of a schema file (ResolvedModule.id). */
export function identify(path: string): string {
  const file = resolve(path)
  for (const dir of ancestors(dirname(file))) {
    const m = join(dir, MANIFEST)
    if (existsSync(m)) {
      const manifest = readManifest(m)
      const base = `${manifest.name}@${manifest.version.split(".")[0]}`
      const rel = relative(dir, file)
      return rel === manifest.schema ? base : `${base}/${stem(rel)}`
    }
    const pkg = join(dir, "package.json")
    if (existsSync(pkg)) {
      const name = (JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name
      if (name) return `${name}/${stem(relative(dir, file))}`
    }
  }
  // Outside any package: just the file name (put a package.json or a manifest above it for a unique id).
  return stem(basename(file))
}

const read = (path: string): ResolvedModule => {
  const key = resolve(path)
  let version: string | undefined
  for (const dir of ancestors(dirname(key))) {
    const m = join(dir, MANIFEST)
    if (existsSync(m)) {
      version = readManifest(m).version
      break
    }
  }
  return { key, id: identify(key), text: readFileSync(key, "utf8"), ...(version ? { version } : {}) }
}

export interface NodeResolverOptions {
  /** Where relative imports of the root file resolve from, if it has no key (default: the working directory). */
  readonly base?: string
  /** Package directories by name, looked up before node_modules: `{ "@haus/money": "../extensions/money" }`. */
  readonly packages?: Readonly<Record<string, string>>
}

/** Finds packages in node_modules (upwards from the importing file) and relative files. */
export function nodeResolver(options: NodeResolverOptions = {}): ModuleResolver {
  const base = options.base ?? process.cwd()
  return {
    resolve(module, from) {
      const dir = from ? dirname(from) : base
      if (module.startsWith("./") || module.startsWith("../")) {
        const path = resolve(dir, module.endsWith(EXTENSION) ? module : module + EXTENSION)
        if (!existsSync(path)) throw new Error(`file not found: ${path}`)
        return read(path)
      }
      const direct = options.packages?.[module]
      const candidates = direct !== undefined ? [join(resolve(base, direct), MANIFEST)] : []
      for (const d of ancestors(dir)) candidates.push(join(d, "node_modules", ...module.split("/"), MANIFEST))
      for (const m of candidates) {
        if (existsSync(m)) {
          const manifest = readManifest(m)
          if (manifest.name !== module) throw new Error(`${m} names the package ${manifest.name}, not ${module}`)
          return read(join(manifest.dir, manifest.schema))
        }
      }
      throw new Error(`package not found (no node_modules/${module}/${MANIFEST} above ${dir})`)
    },
  }
}

/** Options for parseSchemaFile for the schema file at `path`: its key, identity and a Node resolver. */
export function schemaOptions(path: string, options: NodeResolverOptions = {}): ParseSchemaOptions {
  const key = resolve(path)
  return { key, id: identify(key), resolver: nodeResolver({ base: dirname(key), ...options }) }
}
