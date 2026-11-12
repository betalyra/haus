import type { ModuleResolver, ResolvedModule } from "@haus-fmt/haus"

/** Imported schema files by `from \0 module`, as the resolver saw them when the module was generated. */
export type Modules = Readonly<Record<string, ResolvedModule>>

export const resolverOf = (modules: Modules): ModuleResolver => ({
  resolve(module, from) {
    const found = modules[`${from ?? ""}\0${module}`]
    if (!found) throw new Error(`schema import ${module} was not resolved when this module was generated`)
    return found
  },
})

/** An error at a place in a data file: `orders.haus:3:7: …`. */
export const located = (text: string, fileName: string, offset: number | undefined, message: string): Error => {
  const before = text.slice(0, offset ?? 0).split("\n")
  return new Error(`${fileName}:${before.length}:${before.at(-1)!.length + 1}: ${message}`)
}
