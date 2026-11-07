import { createReadStream, readFileSync } from "node:fs"
import { HausSyntaxError } from "@betalyra/haus-fmt"
import * as h from "@betalyra/haus-fmt/schema"
import { Order, OrderStatus, ShopEvent, type Money } from "./model.ts"

const data = (file: string) => new URL(`../data/${file}`, import.meta.url)

const money = ({ values: [amount, currency] }: Money) =>
  `${amount} ${currency._tag === "@unknown" ? currency.tag : currency._tag}`

/** Exhaustive: adding a case to OrderStatus makes this fail to compile. */
const describeStatus = (s: h.Infer<typeof OrderStatus>): string => {
  switch (s._tag) {
    case "Pending": return "pending"
    case "Paid": return `paid on ${s.at.toISOString()}`
    case "Shipped": return `shipped on ${s.at.toISOString()} (tracking: ${s.tracking ?? "none"})`
    case "Cancelled": return `cancelled: ${s.reason}`
  }
}

// ── 1. Decode a document into typed values ───────────────────

console.log("── 1. order.haus → Order")
const order: Order = h.parse(Order, readFileSync(data("order.haus"), "utf8"))
console.log(`order #${order.id} placed ${order.placedOn} by ${order.customer.name}`)
for (const item of order.items) console.log(`  ${item.quantity} × ${item.sku} @ ${money(item.price)}`)
console.log(`  status: ${describeStatus(order.status)}`)
console.log(`  note:   ${order.note ?? "(none)"}`)

// ── 2. Decode a stream, value by value ───────────────────────

console.log("\n── 2. events.haus → stream of ShopEvent")
for await (const event of h.decodeStream(ShopEvent, createReadStream(data("events.haus"), { highWaterMark: 16 }))) {
  switch (event._tag) {
    case "OrderPlaced":
      console.log(`  order ${event.orderId} placed, total ${money(event.total)}`)
      break
    case "OrderShipped":
      console.log(`  order ${event.orderId} shipped at ${event.at.toISOString()}`)
      break
    case "@unknown":
      console.log(`  (ignoring unknown event ${event.tag})`)
      break
  }
}

// ── 3. Input that doesn't match the schema ───────────────────

console.log("\n── 3. failures")
const valid = readFileSync(data("order.haus"), "utf8")
const broken: [string, string][] = [
  ["quantity is a string", valid.replace("quantity: 2", 'quantity: "2"')],
  ["required field missing", valid.replace('email: "ada@example.com",', "")],
  ["unknown status tag", valid.replace("status: Shipped", "status: Lost")],
  ["price as float literal", valid.replace("Money(7.90, EUR)", "Money(7.9e0, EUR)")],
  ["impossible date", valid.replace("2026-11-07", "2026-02-30")],
  ["Money with one argument", valid.replace("Money(14.50, EUR)", "Money(14.50)")],
  ["syntax error", valid.replace("id: 1042,", "id: 1042")],
]
for (const [label, text] of broken) {
  try {
    h.parse(Order, text)
    console.log(`  ${label}: unexpectedly OK`)
  } catch (e) {
    if (e instanceof h.HausDecodeError || e instanceof HausSyntaxError) console.log(`  ${label}:\n    ${e.name}: ${e.message}`)
    else throw e
  }
}

// ── 4. Encode typed values back to haus ──────────────────────

console.log("\n── 4. encode")
const updated: Order = { ...order, status: { _tag: "Cancelled", reason: "customer request" }, note: "refund issued" }
console.log(h.stringify(Order, updated))
