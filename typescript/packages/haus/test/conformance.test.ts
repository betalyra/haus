import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { canonical } from "./canonical.js"
import { fixtures, parseBytes, repoFile, streamBytes } from "./haus.js"

const chunkSizes = (bytes: Uint8Array) => [1, 2, 3, 7, 64, Math.max(bytes.length, 1)]

describe("valid", () => {
  const valid = fixtures("valid")

  it.effect.each(valid)("$name: parseAll", ({ bytes, expected }) =>
    Effect.gen(function* () {
      const values = yield* parseBytes(bytes)
      expect(values.map(canonical)).toEqual(expected)
    }))

  it.effect.each(valid)("$name: stream, any chunking", ({ bytes, expected }) =>
    Effect.forEach(chunkSizes(bytes), (size) =>
      Effect.gen(function* () {
        const values = yield* streamBytes(bytes, size)
        expect(values.map(canonical), `chunk size ${size}`).toEqual(expected)
      })))
})

describe("invalid", () => {
  const invalid = fixtures("invalid")

  // Effect.flip: the test fails if parsing succeeds; an unexpected exception
  // (not a syntax or UTF-8 error) is a defect and fails it too.
  it.effect.each(invalid)("$name: parseAll rejects", ({ bytes }) => Effect.flip(parseBytes(bytes)))

  it.effect.each(invalid)("$name: stream rejects", ({ bytes }) =>
    Effect.forEach([1, 5, Math.max(bytes.length, 1)], (size) => Effect.flip(streamBytes(bytes, size))))
})

describe("repository examples", () => {
  it.effect.each(["syntax-tour.haus", "events.haus"])("%s parses", (file) =>
    Effect.gen(function* () {
      const values = yield* parseBytes(repoFile(file))
      expect(values.length).toBeGreaterThan(0)
    }))
})
