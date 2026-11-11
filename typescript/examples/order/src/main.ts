// The same order, decoded with the schema's own types and with the app's
// codecs. The same steps as rust/examples/order, on the same files.
// Run: pnpm start
import * as Haus from "@betalyra/haus-fmt-effect";
import { BigDecimal, Console, Effect } from "effect";
import { readFileSync } from "node:fs";
import { cents, geojson, iso, jsDate, userId } from "./codecs.ts";
import { Root } from "../../../../examples/order.schema.haus";

const text = readFileSync(new URL("../../../../examples/order.haus", import.meta.url), "utf8");

/** The first line of an error: the reason, without the path below it. */
const reason = (e: Error) => e.message.split("\n")[0];

const program = Effect.gen(function* () {
  // Without codecs: Money is { _tag: "Money", values: [BigDecimal, "EUR"] }.
  const plain = yield* Haus.decode(Root)(text);
  const [amount, currency] = plain.total.values;
  yield* Console.log(`plain:  ${plain.customer.values[0]} pays ${BigDecimal.format(amount)} ${String(currency)}`);

  // With codecs: the fields have the codecs' types (hover `typed`).
  const typed = yield* Haus.decode(Root, userId, cents, geojson, jsDate, iso)(text);
  yield* Console.log(`typed:  ${typed.customer} pays ${typed.total.cents} cents, deliver to [lng, lat] [${typed.deliverTo.join(", ")}]`);
  const weekday = typed.placed.toLocaleDateString("en", { weekday: "long", timeZone: "UTC" });
  yield* Console.log(`placed: ${typed.placed.toISOString().slice(0, 10)}, a ${weekday}`);

  // Variants are tagged unions: narrow them by _tag.
  const status = typed.status;
  yield* Console.log(status._tag === "Shipped" ? `status: shipped, tracking ${status.tracking}` : "status: not on its way");

  // Encoding with the same codecs gives back the same haus text.
  yield* Console.log(yield* Haus.encode(Root, userId, cents, geojson, jsDate, iso)(typed, { style: "compact" }));

  // Codecs add rules on top of the schema's: Eur is a valid tag, but not ISO-shaped.
  const eur = text.replace("EUR", "Eur");
  yield* Haus.decode(Root)(eur).pipe(Effect.andThen(Console.log("Eur without codecs: accepted")));
  yield* Haus.decode(Root, cents, iso)(eur).pipe(Effect.catch((e) => Console.log(`Eur with codecs: ${reason(e)}`)));
  yield* Haus.decode(Root, cents)(text.replace("44.40", "44.405")).pipe(Effect.catch((e) => Console.log(`44.405 with codecs: ${reason(e)}`)));
});

Effect.runPromise(program);
