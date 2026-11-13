/**
 * haus equality (spec §2) and order (§12) as Effect instances.
 *
 * Effect's default `Equal.equals` compares plain objects structurally. On
 * values from `parse` that agrees with haus equality, but not on values
 * that carry source locations (`parseWithLocations`, `parseDocument`): the
 * same value at two places differs. These instances compare canonical
 * forms, so they ignore locations, and add an order.
 *
 *   Haus.ValueEquivalence(parseWithLocations(src)[0], parse("255"))
 *   values.sort(Haus.ValueOrder)                            // deterministic
 *   HashSet.make(Haus.key(a), Haus.key(b))                  // haus values as keys
 */
import { canonical, compare, type Value } from "@haus-fmt/haus"
import { Equal, Equivalence, Hash, type Order } from "effect"

/** Equality of haus values (spec §2): the same canonical form. */
export const ValueEquivalence: Equivalence.Equivalence<Value> = Equivalence.make((a, b) => canonical(a) === canonical(b))

/**
 * Orders haus values by the bytes of their canonical forms (spec §12): a
 * total order consistent with `ValueEquivalence`. Not numeric order: `10`
 * sorts before `9`.
 */
export const ValueOrder: Order.Order<Value> = compare

/**
 * A haus value usable as a key of Effect's `HashMap` and `HashSet`, and with
 * `Equal.equals`: equal (spec §2) when the values are. The canonical form is
 * computed once, when the key is made.
 */
export class HausKey implements Equal.Equal {
  /** The value's canonical form (spec §12). */
  readonly canonical: string

  constructor(readonly value: Value) {
    this.canonical = canonical(value)
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof HausKey && this.canonical === that.canonical
  }

  [Hash.symbol](): number {
    return Hash.string(this.canonical)
  }
}

/** Wraps a haus value as a key for `HashMap`, `HashSet` and `Equal.equals`. */
export const key = (value: Value): HausKey => new HausKey(value)
