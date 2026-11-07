/**
 * The same order model as examples/basic, written as Effect schemas.
 * haus variants map to TaggedStruct, closed sets of tags to Literals, and
 * open variants to Haus.OpenUnion.
 */
import * as Haus from "@haus-fmt/effect"
import { Schema } from "effect"

/** Open: unknown currencies (CHF, BTC, …) decode as Haus.Unknown instead of failing. */
export const Currency = Haus.OpenUnion([Schema.Literals(["EUR", "USD", "GBP"])])

/**
 * `Money(19.99, EUR)`: Haus.Positional lets positional args fill the fields in
 * declaration order (opt-in, so reordering fields can't silently swap values).
 * Exact BigDecimal amount.
 */
export const Money = Haus.Positional(Schema.TaggedStruct("Money", { amount: Schema.BigDecimal, currency: Currency }))
export type Money = typeof Money.Type

export const OrderStatus = Schema.Union([
  Schema.TaggedStruct("Pending", {}),
  Schema.TaggedStruct("Paid", { at: Schema.DateTimeUtc }),
  Schema.TaggedStruct("Shipped", { at: Schema.DateTimeUtc, tracking: Schema.Option(Schema.String) }),
  Schema.TaggedStruct("Cancelled", { reason: Schema.String }),
])
export type OrderStatus = typeof OrderStatus.Type

export const LineItem = Schema.Struct({
  sku: Schema.String,
  quantity: Schema.Int.check(Schema.isGreaterThan(0)),
  price: Money,
})

export const Order = Schema.Struct({
  id: Schema.Int,
  placedOn: Haus.Date, // Date("2026-11-07"), kept as the ISO string
  customer: Schema.Struct({ name: Schema.String, email: Schema.String }),
  items: Schema.Array(LineItem),
  status: OrderStatus,
  note: Schema.OptionFromOptionalKey(Schema.String), // missing field → Option.none()
})
export type Order = typeof Order.Type

export const ShopEvent = Haus.OpenUnion([
  Schema.TaggedStruct("OrderPlaced", { orderId: Schema.Int, total: Money }),
  Schema.TaggedStruct("OrderShipped", { orderId: Schema.Int, at: Schema.DateTimeUtc }),
])
