/** Effect wrappers around the (plain, throwing) parser API for use in tests. */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Data, Effect, identity, Stream } from "effect"
import { HausSyntaxError, parseAll, parseStream, type Value } from "../src/index.js"

export class InvalidUtf8 extends Data.TaggedError("InvalidUtf8")<{ readonly cause: unknown }> {}

export type Rejection = HausSyntaxError | InvalidUtf8

/** Expected rejections fail the effect. Anything else is a bug and dies. */
const classify = (e: unknown): Effect.Effect<never, Rejection> =>
  e instanceof HausSyntaxError ? Effect.fail(e)
  : e instanceof TypeError && (e as { code?: string }).code === "ERR_ENCODING_INVALID_ENCODED_DATA"
    ? Effect.fail(new InvalidUtf8({ cause: e }))
  : Effect.die(e)

/** Run a throwing parser call, failing with HausSyntaxError. */
export const syntax = <A>(f: () => A): Effect.Effect<A, HausSyntaxError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(f())
    } catch (e) {
      return e instanceof HausSyntaxError ? Effect.fail(e) : Effect.die(e)
    }
  })

export const decode = (bytes: Uint8Array): Effect.Effect<string, InvalidUtf8> =>
  Effect.try({
    // ignoreBOM: the parser skips a byte order mark; the decoder must not remove one too.
    try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    catch: (cause) => new InvalidUtf8({ cause }),
  })

export const parseText = (text: string) => syntax(() => parseAll(text))

export const parseBytes = (bytes: Uint8Array) => decode(bytes).pipe(Effect.flatMap(parseText))

/** Parse through the streaming API, feeding `size`-byte chunks. */
export const streamBytes = (bytes: Uint8Array, size: number): Effect.Effect<Value[], Rejection> =>
  Stream.fromAsyncIterable(parseStream(chunks(bytes, size)), identity).pipe(
    Stream.runCollect,
    Effect.catch(classify),
  )

function* chunks(bytes: Uint8Array, size: number) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size)
}

// ── conformance fixtures (read synchronously: test names are needed at collection time)

const SUITE = join(import.meta.dirname, "../../../../test-suite")

export interface Fixture {
  readonly name: string
  readonly bytes: Uint8Array
  readonly expected: unknown
  /** valid/NAME.canonical: the canonical form of each value, one per line. */
  readonly canonical: string | undefined
  /** valid/NAME.hash: hashAll of the file's values (64 hex digits). */
  readonly hash: string | undefined
}

export const fixtures = (kind: "valid" | "invalid"): Fixture[] =>
  readdirSync(join(SUITE, kind))
    .filter((f) => f.endsWith(".haus"))
    .sort()
    .map((file) => {
      const name = file.slice(0, -".haus".length)
      const json = join(SUITE, kind, `${name}.json`)
      return {
        name,
        bytes: readFileSync(join(SUITE, kind, file)),
        expected: kind === "valid" ? JSON.parse(readFileSync(json, "utf8")) : undefined,
        canonical: kind === "valid" ? readFileSync(join(SUITE, kind, `${name}.canonical`), "utf8") : undefined,
        hash: kind === "valid" ? readFileSync(join(SUITE, kind, `${name}.hash`), "utf8").trim() : undefined,
      }
    })

export const repoFile = (name: string) => readFileSync(join(import.meta.dirname, "../../../../examples", name))
