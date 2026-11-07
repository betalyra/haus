/** Where a chunk of text starts within the whole input. */
export interface Origin {
  /** Absolute offset (UTF-16 code units). */
  readonly offset: number
  /** 1-based line. */
  readonly line: number
  /** 1-based column, in Unicode code points. */
  readonly column: number
}

export const START: Origin = { offset: 0, line: 1, column: 1 }

export class HausSyntaxError extends Error {
  override readonly name = "HausSyntaxError"

  constructor(
    /** Message without position. */
    readonly reason: string,
    readonly offset: number,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${reason} at ${line}:${column}`)
  }
}

/**
 * Position of `pos` within `text`, given that `text` starts at `origin`.
 * Columns count Unicode code points (spec), so a surrogate pair is one column.
 */
export function locate(text: string, pos: number, origin: Origin): Origin {
  let line = origin.line
  let column = origin.column
  for (let i = 0; i < pos && i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 10) {
      line++
      column = 1
    } else if (c < 0xdc00 || c > 0xdfff) {
      column++
    }
  }
  return { offset: origin.offset + pos, line, column }
}
