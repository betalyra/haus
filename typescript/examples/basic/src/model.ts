/**
 * The domain model, written once as haus schemas. The TypeScript types are
 * inferred from them, so the schema and the types can't drift apart.
 *
 * Equivalent .schema.haus:
 *
 *   type Currency    = < EUR | USD | GBP | _ >
 *   type Money       = < Money Decimal Currency >
 *   type OrderStatus = < Pending
 *                      | Paid      { at: Instant }
 *                      | Shipped   { at: Instant, tracking: Maybe String }
 *                      | Cancelled { reason: String } >
 *   type LineItem    = { sku: String, quantity: Int, price: Money }
 *   type Order       = { id: Int, placedOn: Date, customer: Customer,
 *                        items: Array LineItem, status: OrderStatus,
 *                        note: Maybe String }
 *   type ShopEvent   = < OrderPlaced { orderId: Int, total: Money }
 *                      | OrderShipped { orderId: Int, at: Instant } | _ >
 */
import * as h from "@haus-fmt/haus/schema"

export const Currency = h.OpenVariant({ EUR: h.Unit, USD: h.Unit, GBP: h.Unit })

export const Money = h.Variant({ Money: h.Tuple(h.Decimal, Currency) })
export type Money = h.Infer<typeof Money>
//   { _tag: "Money"; values: [string, { _tag: "EUR" } | … | h.Unknown] }

export const OrderStatus = h.Variant({
  Pending: h.Unit,
  Paid: h.Record({ at: h.Instant }),
  Shipped: h.Record({ at: h.Instant, tracking: h.Maybe(h.String) }),
  Cancelled: h.Record({ reason: h.String }),
})
export type OrderStatus = h.Infer<typeof OrderStatus>
//   | { _tag: "Pending" }
//   | { _tag: "Paid"; at: Date }
//   | { _tag: "Shipped"; at: Date; tracking: string | undefined }
//   | { _tag: "Cancelled"; reason: string }

export const Customer = h.Record({ name: h.String, email: h.String })

export const LineItem = h.Record({ sku: h.String, quantity: h.Int, price: Money })
export type LineItem = h.Infer<typeof LineItem>

export const Order = h.Record({
  id: h.Int,
  placedOn: h.Date,
  customer: Customer,
  items: h.Array(LineItem),
  status: OrderStatus,
  note: h.Maybe(h.String),
})
export type Order = h.Infer<typeof Order>

export const ShopEvent = h.OpenVariant({
  OrderPlaced: h.Record({ orderId: h.Int, total: Money }),
  OrderShipped: h.Record({ orderId: h.Int, at: h.Instant }),
})
export type ShopEvent = h.Infer<typeof ShopEvent>
