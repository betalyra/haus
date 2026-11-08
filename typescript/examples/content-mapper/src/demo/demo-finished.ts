// The finished demo (demo.ts starts empty): order.haus is typed and checked by order.schema.haus.
// Try: hover `order`, change `quantity: 2` to `quantity: 300` in order.haus,
// or add a tag to Status in the schema.
import * as Haus from "@betalyra/haus-fmt-effect";
import { BigDecimal, Console, Effect, Match } from "effect";
import order from "./order.haus";
import { Root, type Line, type Status } from "./order.schema.haus";

const lineTotal = (line: Line) =>
  BigDecimal.multiply(
    line.price.amount,
    BigDecimal.fromNumberUnsafe(line.quantity),
  );

const describe = Match.type<Status>().pipe(
  Match.tagsExhaustive({
    Pending: () => "pending",
    Shipped: (s) => `shipped (${s.tracking})`,
    Cancelled: () => "cancelled",
  }),
);

const program = Effect.gen(function* () {
  order.lines[0].quantity;
  const total = BigDecimal.sumAll(order.lines.map(lineTotal));
  yield* Console.log(
    `Order ${order.id} for ${order.customer}: ${BigDecimal.format(total)} EUR, ${describe(order.status)}`,
  );

  // The schema is an Effect schema too: write the cancelled order back as haus.
  const cancelled: Root = {
    ...order,
    status: { _tag: "Cancelled" },
    note: "customer asked",
  };
  yield* Console.log(yield* Haus.encode(Root)(cancelled));
});

Effect.runSync(program);
