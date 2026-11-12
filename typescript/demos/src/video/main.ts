import * as Haus from "@haus-fmt/effect";
import { Console, Effect, Match } from "effect";
import order from "./order.haus";
import { Root } from "./order.schema.haus";

const program = Effect.gen(function* () {
  yield* Console.log(order.customer, order.lines[0].product);
  const status = Match.value(order.status).pipe(
    Match.tagsExhaustive({
      Pending: () => "waiting",
      Shipped: (s) => `on its way: ${s.tracking}`,
      Cancelled: () => "cancelled",
    }),
  );
  yield* Console.log(status);

  const incoming = Haus.decode(Root)(`{ id: 7, customer: "Grace Hopper", paid: "no", status: Pending, lines: [] }`);
  const fresh = yield* incoming;
  yield* Console.log(fresh.customer, fresh.status);
});

program.pipe(
  Effect.catchTag("HausSchemaError", (e) => Console.log(`invalid order: ${e.message}`)),
  Effect.runPromise,
);
