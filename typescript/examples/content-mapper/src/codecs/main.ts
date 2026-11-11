// The same order, decoded without codecs (the schema's own types) and with
// the app's codecs (its host types). Run: pnpm codecs
import * as Haus from "@betalyra/haus-fmt-effect";
import { BigDecimal, Console, Effect } from "effect";
import { readFileSync } from "node:fs";
import order from "./order.haus";
import { appCodecs, cents, geojson, iso, userId } from "./codecs.ts";
import { Root } from "./order.schema.haus";

const text = readFileSync(new URL("./order.haus", import.meta.url), "utf8");

const program = Effect.gen(function* () {
  // Without codecs: Money is { _tag: "Money", values: [BigDecimal, "EUR"] }.
  const plain = yield* Haus.decode(Root)(text);
  const [amount, currency] = plain.total.values;
  yield* Console.log(`plain:  ${plain.customer.values[0]} pays ${BigDecimal.format(amount)} ${String(currency)}`);

  // With codecs: the types follow (hover `typed`).
  const typed = yield* Haus.decode(Root, userId, cents, geojson, iso)(text);
  yield* Console.log(`typed:  ${typed.customer} pays ${typed.total.cents} cents, deliver to [lng, lat] ${typed.deliverTo}`);

  // A group works the same; data imports convert after the fact.
  const all = yield* Haus.decode(Root, appCodecs)(text);
  const converted = yield* Haus.convert(Root, appCodecs)(order);
  yield* Console.log(`placed: ${all.placed.toDateString()}, same after convert: ${converted.total.cents === all.total.cents}`);

  // Encoding with the same codecs gives back the same haus text.
  yield* Console.log(yield* Haus.encode(Root, appCodecs)(all, { style: "compact" }));

  // Codecs add rules on top of the schema's: Eur is a valid tag, but not ISO-shaped.
  const eur = text.replace("EUR", "Eur");
  yield* Haus.decode(Root)(eur).pipe(Effect.andThen(Console.log("Eur without codecs: accepted")));
  yield* Haus.decode(Root, iso)(eur).pipe(Effect.catch((e) => Console.log(`Eur with iso: ${e.message.split("\n")[0]}`)));
});

Effect.runPromise(program);
