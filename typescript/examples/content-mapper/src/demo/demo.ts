// Live demo. The finished version is in demo-finished.ts.
import * as Haus from "@betalyra/haus-fmt-effect";
import { BigDecimal, Console, Effect } from "effect";
import { Root } from "./order.schema.haus";
import order from "./order.haus";

const text = `{ id: 1, customer: "Ada", lines: [], status: Pending }`;

const program = Effect.gen(function* () {
  yield* Effect.log(order);
});

Effect.runSync(program);
