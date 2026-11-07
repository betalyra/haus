/**
 * The haus data model, exactly as written in the source. No schema has been
 * applied: numbers are kept as exact literal text, and variants are generic.
 */
export type Value = HNumber | HString | HArray | HRecord | HVariant

/**
 * Source positions, only set when parsing with `{ locations: true }` (editor
 * tooling). Offsets are UTF-16 indexes into the parsed text, `end` exclusive.
 */
export interface Located {
  readonly start?: number
  readonly end?: number
}

export interface HNumber extends Located {
  readonly kind: "number"
  /**
   * Exact literal, digit separators removed. Hex/binary literals are
   * converted to decimal integers. Example: "19.90", "-1e10", "255".
   */
  readonly text: string
}

export interface HString extends Located {
  readonly kind: "string"
  readonly value: string
}

export interface HArray extends Located {
  readonly kind: "array"
  readonly items: readonly Value[]
}

export interface HRecord extends Located {
  readonly kind: "record"
  /** Fields in source order. */
  readonly fields: ReadonlyMap<string, Value>
  /** With `{ locations: true }`: where each key starts and ends. */
  readonly keySpans?: ReadonlyMap<string, readonly [start: number, end: number]>
}

export interface HVariant extends Located {
  readonly kind: "variant"
  readonly tag: string
  /** Empty for a bare tag. `Tag { ... }` has a single record arg. */
  readonly args: readonly Value[]
}

export const num = (text: string): HNumber => ({ kind: "number", text })
export const str = (value: string): HString => ({ kind: "string", value })
export const arr = (items: readonly Value[]): HArray => ({ kind: "array", items })
export const rec = (fields: ReadonlyMap<string, Value>): HRecord => ({ kind: "record", fields })
export const variant = (tag: string, args: readonly Value[] = []): HVariant => ({
  kind: "variant",
  tag,
  args,
})
