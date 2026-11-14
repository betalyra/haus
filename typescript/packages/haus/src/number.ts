/**
 * Number literals as values (spec §2, §3): the normalized text the parser
 * gives every number, and the checks a number built in code passes before it
 * is written (spec §9.8: the same limits as when parsing).
 */
import { HausSyntaxError, START } from "./errors.js"
import { DEFAULT_LIMITS, Parser, type Limits } from "./parser.js"

/** A normalized literal that is a whole number: digits with an optional `-` (`-0` included). */
export const INTEGER = /^-?\d+$/

/**
 * A normalized literal, exactly as the parser writes one: no `_`, `+`, `E`,
 * hex or binary, and no leading zeros in the exponent. `1e5`, `-0`, `19.90`.
 */
const NORMALIZED = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e(?:0|-?[1-9]\d*))?$/

/**
 * The normalized text of a number literal (`1_000` → "1000", `0xFF` → "255",
 * `1E+05` → "1e5"), or undefined when `text` is not exactly one number
 * literal within `limits`.
 */
export const normalizeNumber = (text: string, limits: Limits = DEFAULT_LIMITS): string | undefined => {
  if (NORMALIZED.test(text)) return text
  try {
    return new Parser(text, START, limits).parseNumberLiteral()
  } catch (e) {
    if (e instanceof HausSyntaxError) return undefined
    throw e
  }
}

/** log₁₆ 10: a whole number of d decimal digits has at least ⌊(d − 1) · this⌋ + 1 hex digits. */
const HEX_PER_DECIMAL = Math.log(10) / Math.log(16)

/**
 * The length of the shortest literal of a normalized number. A long whole
 * number can be written in hex (as the writer does beyond the number limit,
 * spec §12), so a value parsed from a hex literal always fits again.
 */
const shortestLength = (text: string, max: number): number => {
  if (text.length <= max || !INTEGER.test(text)) return text.length
  const sign = text.startsWith("-") ? 1 : 0
  const digits = text.length - sign
  const atLeast = sign + 2 + Math.floor((digits - 1) * HEX_PER_DECIMAL) + 1
  if (atLeast > max) return atLeast // too long either way: no need to convert it
  return Math.min(text.length, sign + 2 + BigInt(text.slice(sign)).toString(16).length)
}

/**
 * Why the normalized number `text` is outside `limits` (spec §9.8), or
 * undefined: an exponent larger than `maxExponent`, or no literal of it that
 * fits in `maxNumberLength` characters. A number the parser produced within
 * `limits` is always within them.
 */
export const numberLimitIssue = (text: string, limits: Limits): string | undefined => {
  const exponent = /e-?(\d+)$/.exec(text)?.[1]
  if (exponent !== undefined && (exponent.length > 15 || Number(exponent) > limits.maxExponent)) return `exponent larger than ${limits.maxExponent}`
  if (shortestLength(text, limits.maxNumberLength) > limits.maxNumberLength) return `number literal longer than ${limits.maxNumberLength} characters`
  return undefined
}
