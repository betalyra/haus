// Codecs: the application chooses host types for named haus types. Each one
// is an ordinary Effect schema built on the type's base schema, so the
// schema's rules always run first and the haus text never changes.
import * as Haus from "@haus-fmt/effect";
import * as money from "@haus/money/money.schema.haus";
import * as geo from "@haus/geo/geo.schema.haus";
import { BigDecimal, Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";
import * as Order from "../../../../examples/order.schema.haus";

/** The @haus/money/iso profile: a currency is three letters A–Z. */
export const iso = Haus.codec(money.Currency, (base) =>
  base.pipe(
    Schema.check(
      Schema.makeFilter((c: string | Haus.Unknown) =>
        (typeof c === "string" && /^[A-Z]{3}$/.test(c)) || "a currency is three letters A–Z (ISO 4217)"),
    ),
  ));

/** 4440n → "44.40": cents as a haus Decimal with two places. */
const centsText = (cents: bigint): string => {
  const digits = (cents < 0n ? -cents : cents).toString().padStart(3, "0");
  return `${cents < 0n ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
};

/** Integer cents, as payment APIs want them; more than 2 decimal places is an error. */
export const Cents = Schema.Struct({ cents: Schema.BigInt, currency: Schema.String });
export const cents = Haus.codec(money.Money, (base) =>
  base.pipe(
    Schema.decodeTo(Cents, SchemaTransformation.transformEffect({
      // The amount is the Decimal's exact text ("44.40"); BigDecimal does the arithmetic.
      decode: ({ values: [amount, currency] }) => {
        const value = BigDecimal.fromStringUnsafe(amount);
        return BigDecimal.normalize(value).scale > 2
          ? Effect.fail(new SchemaIssue.InvalidValue({ message: `${amount} has more than 2 decimal places` }))
          : Effect.succeed({ cents: BigDecimal.scale(value, 2).value, currency: typeof currency === "string" ? currency : currency.tag });
      },
      encode: ({ cents, currency }) => Effect.succeed({ _tag: "Money" as const, values: [centsText(cents), currency] as const }),
    })),
  ));

/** GeoJSON and Turf order: [longitude, latitude]. The swap happens here, once. */
export const geojson = Haus.codec(geo.LatLng, (base) =>
  base.pipe(
    Schema.decodeTo(Schema.Tuple([Schema.Number, Schema.Number]), SchemaTransformation.transform({
      decode: ({ values: [lat, lng] }) => [lng, lat] as const,
      encode: ([lng, lat]) => ({ _tag: "LatLng" as const, values: [lat, lng] as const }),
    })),
  ));

/** The app's own type: UserId("usr_ada") ↔ "usr_ada" & Brand<"UserId">. */
export const UserId = Schema.String.pipe(Schema.brand("UserId"));
export const userId = Haus.codec(Order.UserId, (base) =>
  base.pipe(
    Schema.decodeTo(UserId, SchemaTransformation.transform({
      decode: ({ values: [id] }) => id,
      encode: (id) => ({ _tag: "UserId" as const, values: [id] as const }),
    })),
  ));

/** std/time types take codecs too: Date("2026-11-09") ↔ a JS Date at midnight UTC. */
export const jsDate = Haus.codec(Haus.Date, (base) =>
  base.pipe(
    Schema.decodeTo(Schema.instanceOf(globalThis.Date), SchemaTransformation.transform({
      decode: (s) => new globalThis.Date(`${s}T00:00:00Z`),
      encode: (d) => d.toISOString().slice(0, 10),
    })),
  ));

/** All of the app's codecs, as one. A group may contain codecs for types a schema doesn't use. */
export const appCodecs = Haus.codecs(iso, cents, geojson, userId, jsDate);
