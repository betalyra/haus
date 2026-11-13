/**
 * The canonical form, equality and hashing (spec §12): one exact text per
 * value, the same in every binding. Equal values (§2) have identical
 * canonical forms, so `hash` is the same whatever the layout, comments, key
 * order or spelling of the document the value came from.
 *
 *   canonical(parse('Order { total: 19.90, id: 0xFF, "x-y": 1e+5 }'))
 *   // 'Order{id:255,total:19.90,"x-y":1e5}'
 */
import { numberText, quote, toHex } from "./format.js"
import type { Value } from "./value.js"

const BARE_KEY = /^[a-z_][A-Za-z0-9_]*$/

/**
 * Orders strings by code point, which is the order of their UTF-8 bytes.
 * JavaScript's `<` compares UTF-16 units, which puts U+10000 and above
 * before U+E000–U+FFFF.
 */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]()
  const ib = b[Symbol.iterator]()
  for (;;) {
    const x = ia.next()
    const y = ib.next()
    if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1
    const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!
    if (d !== 0) return d
  }
}

function write(v: Value): string {
  switch (v.kind) {
    case "number":
      return numberText(v.text)
    case "string":
      return quote(v.value)
    case "bytes":
      return `x"${toHex(v.bytes)}"`
    case "array":
      return `[${v.items.map(write).join(",")}]`
    case "record":
      return record(v.fields)
    case "variant": {
      if (v.args.length === 0) return v.tag
      const only = v.args.length === 1 ? v.args[0]! : undefined
      if (only?.kind === "record") return v.tag + record(only.fields)
      return `${v.tag}(${v.args.map(write).join(",")})`
    }
  }
}

function record(fields: ReadonlyMap<string, Value>): string {
  const keys = [...fields.keys()].sort(compareCodePoints)
  return `{${keys.map((k) => `${BARE_KEY.test(k) ? k : quote(k)}:${write(fields.get(k)!)}`).join(",")}}`
}

/** The canonical form of a value (spec §12). */
export function canonical(value: Value): string {
  return write(value)
}

/** Whether two values are equal (spec §2): the same canonical form. */
export function equals(a: Value, b: Value): boolean {
  return canonical(a) === canonical(b)
}

/**
 * The SHA-256 digest of the canonical form, as 64 lowercase hex digits
 * (spec §12). Uses Web Crypto, so it is asynchronous.
 */
export async function hash(value: Value): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)))
  return toHex(new Uint8Array(digest))
}
