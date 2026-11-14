/**
 * A value that must not end up in logs (spec §15, `Secret a`): an API key, a
 * password. Printing, logging, inspecting or converting it to JSON shows
 * `<redacted>`; `expose()` gives the value out.
 *
 *   const key = new Secret("sk-123")      // or Secret.make("sk-123"), to encode
 *   String(key)                           // "<redacted>"
 *   JSON.stringify({ key })               // {"key":"<redacted>"}
 *   key.expose()                          // "sk-123"
 *
 * The data is the same as without `Secret`: the value is written in full, as
 * the receiver needs it. Only the host side hides it.
 */
export class Secret<A> {
  /** A private field: not an enumerable property, so `Object.entries`, spreads and structured logging don't see it. */
  readonly #value: A

  constructor(value: A) {
    this.#value = value
  }

  /** A secret holding `value` (for encoding). */
  static make<A>(value: A): Secret<A> {
    return new Secret(value)
  }

  /** Whether `u` is a Secret. */
  static is(u: unknown): u is Secret<unknown> {
    return u instanceof Secret
  }

  /** The hidden value. The only way to get it. */
  expose(): A {
    return this.#value
  }

  toString(): string {
    return "<redacted>"
  }

  toJSON(): string {
    return "<redacted>"
  }

  get [Symbol.toStringTag](): string {
    return "Secret"
  }

  [Symbol.toPrimitive](): string {
    return "<redacted>"
  }

  /** Node's `util.inspect` and `console.log`. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "Secret(<redacted>)"
  }
}
