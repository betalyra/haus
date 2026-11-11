/**
 * Codecs: the application's choice of a host type for a named haus type.
 *
 *   import * as money from "@haus/money/money.schema.haus"
 *
 *   const cents = Haus.codec(money.Money, (base) =>
 *     base.pipe(Schema.decodeTo(Cents, SchemaTransformation.transform({ decode: toCents, encode: fromCents }))))
 *
 *   const order = yield* Haus.decode(Root, cents)(text)   // order.total: Cents
 *   const plain = yield* Haus.decode(Root)(text)          // order.total: { _tag: "Money", values: [BigDecimal, …] }
 *
 * A codec is an ordinary Effect schema built from the type's base schema
 * (what haus decodes without codecs). It runs after the base, so it can add
 * checks and change the type, but data that the schema rejects stays
 * rejected, and the haus text never changes. Codecs find their type by its
 * id (`@haus/money@1#Money`), the same in every language.
 */
import type { Schema } from "effect"

// ── type-level plumbing ──────────────────────────────────────

/**
 * A type family: the type of a schema-file type for a map of codec types by
 * id (`{ "@haus/money@1#Money": Cents }`). Generated declarations define
 * one per type; `Kind` applies it.
 */
export interface TypeLambda {
  readonly C: unknown
  readonly type: unknown
}

export type Kind<F extends TypeLambda, C> = (F & { readonly C: C })["type"]

/** The codec's type for `Id` in the map `C`, else the generic type `D`. Used by generated declarations. */
export type Lookup<C, Id extends string, D> = Id extends keyof C ? C[Id] : D

/**
 * Phantom type information of a named type's schema (never present at
 * runtime): its id, its type family and the ids of the named types it
 * contains, which codecs may replace.
 */
export interface NamedInfo<Id extends string, F extends TypeLambda, Ids extends string> {
  readonly "~haus.id"?: Id
  readonly "~haus.family"?: F
  readonly "~haus.ids"?: Ids
}

/** A named type's schema: the Effect schema plus its phantom type information. */
export type Named<S extends Schema.Top, Id extends string, F extends TypeLambda = never, Ids extends string = Id> = S & NamedInfo<Id, F, Ids>

// ── codecs ───────────────────────────────────────────────────

export const CodecTypeId: unique symbol = Symbol.for("@betalyra/haus-fmt-effect/Codec")

export interface CodecEntry {
  readonly id: string
  readonly apply: (base: Schema.Top) => Schema.Top
}

/**
 * Host types for named types: `M` maps ids to the types codecs produce.
 * `Target` is the id of a single codec (checked against the schema it is
 * used with); groups have `never`.
 */
export interface Codec<M = {}, Target extends string = string> {
  readonly [CodecTypeId]: ReadonlyArray<CodecEntry>
  readonly "~haus.map"?: M
  readonly "~haus.target"?: Target
}

export type AnyCodec = Codec<any, any>

export const isCodec = (u: unknown): u is AnyCodec => typeof u === "object" && u !== null && CodecTypeId in u

/** Ids of named schemas, registered when they are built (schema files, std/time). */
const ids = new WeakMap<object, string>()

/** @internal */
export const setId = <S extends object>(schema: S, id: string): S => {
  ids.set(schema, id)
  return schema
}

/** The id of a named type's schema (`@haus/money@1#Money`, `std/time#Date`), if it has one. */
export const idOf = (schema: Schema.Top): string | undefined => ids.get(schema)

type IdOf<S> = S extends { readonly "~haus.id"?: infer Id } ? (NonNullable<Id> extends infer I extends string ? I : string) : string

/**
 * A codec for the named type `target`: `f` builds the host type's schema
 * from the type's base schema. It must keep the encoded side (build on
 * `base`, e.g. with `Schema.decodeTo`, `Schema.check`, `Schema.brand`).
 */
export const codec = <S extends Schema.Top, T extends Schema.Codec<any, S["Encoded"], any, any>>(
  target: S,
  f: (base: S) => T,
): Codec<{ readonly [K in IdOf<S>]: T["Type"] }, IdOf<S>> => {
  const id = idOf(target)
  if (id === undefined) {
    throw new Error("Haus.codec: the target must be a named type's schema (from a .schema.haus file, or Haus.Date & co.)")
  }
  return { [CodecTypeId]: [{ id, apply: f as unknown as (base: Schema.Top) => Schema.Top }] }
}

type Merge<C extends ReadonlyArray<AnyCodec>> = C extends readonly [infer H, ...infer R extends ReadonlyArray<AnyCodec>]
  ? (H extends Codec<infer M, any> ? M : {}) & Merge<R>
  : {}

/** The map of host types by id for a list of codecs. */
export type CodecMap<C extends ReadonlyArray<AnyCodec>> = Merge<C>

/**
 * Several codecs as one (e.g. all of a library's codecs). Unlike a single
 * codec, a group may contain codecs for types a schema doesn't use.
 */
export const codecs = <const C extends ReadonlyArray<AnyCodec>>(...members: C): Codec<CodecMap<C>, never> => ({
  [CodecTypeId]: members.flatMap((c) => c[CodecTypeId]),
})

/** The entries of a list of codecs, by id; two codecs for one type are an error. */
export const entries = (list: ReadonlyArray<AnyCodec>): ReadonlyMap<string, CodecEntry> => {
  const byId = new Map<string, CodecEntry>()
  for (const c of list) {
    for (const e of c[CodecTypeId]) {
      if (byId.has(e.id)) throw new Error(`Haus: two codecs for ${e.id}`)
      byId.set(e.id, e)
    }
  }
  return byId
}

/** Shown when a codec is passed for a type the schema doesn't contain. */
export interface NotInSchema<Id extends string> {
  readonly "~haus.error": `the schema contains no type ${Id}`
}

type IdsOf<S> = S extends { readonly "~haus.ids"?: infer Ids } ? (NonNullable<Ids> extends infer I extends string ? I : never) : never

/** Each single codec must target a type the schema contains; groups may contain others. */
export type Checked<S, C extends ReadonlyArray<AnyCodec>> = {
  readonly [K in keyof C]: C[K] extends Codec<any, infer Target>
    ? [Target] extends [never] ? C[K] : Target extends IdsOf<S> ? C[K] : NotInSchema<Target>
    : C[K]
}

/** The decoded type of `S` with the codecs `C`. */
export type Decoded<S extends Schema.Top, C extends ReadonlyArray<AnyCodec>> = C extends readonly []
  ? S["Type"]
  : S extends { readonly "~haus.family"?: infer F }
    ? NonNullable<F> extends infer G extends TypeLambda ? ([G] extends [never] ? S["Type"] : Kind<G, CodecMap<C>>) : S["Type"]
  : S["Type"]
