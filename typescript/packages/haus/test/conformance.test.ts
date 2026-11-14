import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { suiteJson } from "./suite-json.js"
import { canonical, hash, hashAll, Hasher, HausSyntaxError } from "../src/index.js"
import { fixtures, parseBytes, repoFile, streamBytes } from "./haus.js"

const chunkSizes = (bytes: Uint8Array) => [1, 2, 3, 7, 64, Math.max(bytes.length, 1)]

describe("valid", () => {
  const valid = fixtures("valid")

  it.effect.each(valid)("$name: parseAll", ({ bytes, expected }) =>
    Effect.gen(function* () {
      const values = yield* parseBytes(bytes)
      expect(values.map(suiteJson)).toEqual(expected)
    }))

  it.effect.each(valid)("$name: canonical form", ({ bytes, canonical: expected }) =>
    Effect.gen(function* () {
      const values = yield* parseBytes(bytes)
      expect(values.map((v) => canonical(v) + "\n").join("")).toBe(expected)
    }))

  it.effect.each(valid)("$name: hashAll", ({ bytes, hash: expected }) =>
    Effect.gen(function* () {
      const values = yield* parseBytes(bytes)
      expect(yield* Effect.promise(() => hashAll(values))).toBe(expected)
      // A file of one value hashes like the value.
      if (values.length === 1) expect(yield* Effect.promise(() => hash(values[0]!))).toBe(expected)
    }))

  it.effect.each(valid)("$name: hashing while reading", ({ bytes, hash: expected }) =>
    Effect.gen(function* () {
      const values = yield* streamBytes(bytes, 3)
      const hasher = new Hasher()
      for (const v of values) hasher.add(v)
      expect(hasher.digest()).toBe(expected)
    }))

  it.effect.each(valid)("$name: stream, any chunking", ({ bytes, expected }) =>
    Effect.forEach(chunkSizes(bytes), (size) =>
      Effect.gen(function* () {
        const values = yield* streamBytes(bytes, size)
        expect(values.map(suiteJson), `chunk size ${size}`).toEqual(expected)
      })))
})

describe("invalid", () => {
  const invalid = fixtures("invalid")

  // Effect.flip: the test fails if parsing succeeds; an unexpected exception
  // (not a syntax or UTF-8 error) is a defect and fails it too.
  it.effect.each(invalid)("$name: parseAll rejects", ({ bytes }) => Effect.flip(parseBytes(bytes)))

  it.effect.each(invalid)("$name: stream rejects", ({ bytes }) =>
    Effect.forEach([1, 5, Math.max(bytes.length, 1)], (size) => Effect.flip(streamBytes(bytes, size))))

  // With a byte order mark in front, the stream reader reports the error where the whole-text parser does (S18).
  it.effect.each(invalid)("$name: stream positions after a byte order mark", ({ bytes }) =>
    Effect.gen(function* () {
      const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes])
      const whole = yield* Effect.flip(parseBytes(withBom))
      if (!(whole instanceof HausSyntaxError)) return
      yield* Effect.forEach([1, 5, withBom.length], (size) =>
        Effect.gen(function* () {
          const e = yield* Effect.flip(streamBytes(withBom, size))
          expect(e instanceof HausSyntaxError && [e.line, e.column], `chunk size ${size}`).toEqual([whole.line, whole.column])
        }))
    }))
})

describe("repository examples", () => {
  it.effect.each(["syntax-tour.haus", "events.haus"])("%s parses", (file) =>
    Effect.gen(function* () {
      const values = yield* parseBytes(repoFile(file))
      expect(values.length).toBeGreaterThan(0)
    }))
})
