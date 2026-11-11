// .haus files imported like modules, via the haus content mapper
// (tsconfig.json#contentMappers, TypeScript 7.1):
// - a .schema.haus file exports its types and their Effect schemas;
// - a data file with a .schema.haus next to it is typed by the schema's Root
//   and checked against it (thread.haus, syntax-tour.haus);
// - other data files get types inferred from their data (person.haus).

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  BigDecimal,
  BigInt,
  Console,
  DateTime,
  Effect,
  FileSystem,
  Match,
  Option,
  Path,
  Stream,
} from "effect";
import * as Haus from "@betalyra/haus-fmt-effect";
import people from "./data/person.haus";
import tour from "./data/syntax-tour.haus";
import { ServerEvents } from "./data/syntax-tour.schema.haus";
import thread from "./data/thread.haus";
import { Comment } from "./data/thread.schema.haus";

// thread.haus is typed by thread.schema.haus: a Comment's replies are Comments.
/** All likes in a thread (Int → bigint). */
const likes = (c: Comment): bigint =>
  BigInt.sumAll([c.likes, ...c.replies.map(likes)]);
/** Levels of the deepest reply chain. */
const depth = (c: Comment): number => 1 + Math.max(0, ...c.replies.map(depth));

const threadSummary = Console.log(
  `thread "${thread.text}" (${DateTime.formatIso(thread.at)}): ${depth(thread)} levels, ${likes(thread)} likes`,
);

/** Comment is also an Effect schema: decode and encode any haus text with it. */
const replyRoundTrip = Effect.gen(function* () {
  const reply = yield* Haus.decode(Comment)(
    `Comment { author: "me", at: Instant("2026-11-08T10:00:00Z"), text: "+1", likes: 0, replies: [] }`,
  );
  const liked = { ...reply, likes: reply.likes + 1n };
  yield* Console.log(
    `encoded back: ${yield* Haus.encode(Comment, { style: "compact" })(liked)}`,
  );

  // Invalid input fails with a typed error.
  const message = yield* Haus.decode(Comment)(
    `Comment { author: "me", likes: "lots" }`,
  ).pipe(
    Effect.map(() => "decoded?!"),
    Effect.catchTag("HausSchemaError", (e) =>
      Effect.succeed(`rejected: ${e.message.replace(/\s+/g, " ")}`),
    ),
  );
  yield* Console.log(message);
});

/** events.haus, streamed and decoded with ServerEvents = Stream (UserEvent _): other tags arrive as Unknown. */
const describeEvent = Match.type<ServerEvents>().pipe(
  Match.tagsExhaustive({
    UserCreated: (e) => `user ${e.id} created: ${e.email}`,
    UserRenamed: (e) => `user ${e.id} renamed: ${e.from} → ${e.to}`,
    "@unknown": (e) => `(skipped ${e.tag})`,
  }),
);
const events = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* path.fromFileUrl(
    new URL("./data/events.haus", import.meta.url),
  );
  yield* Haus.decodeStream(ServerEvents)(fs.stream(file)).pipe(
    Stream.runForEach((event) => Console.log(`  ${describeEvent(event)}`)),
  );
});

/** syntax-tour.haus: exact decimals, Maybe → Option, variants composed from rows. */
const tourSummary = Effect.gen(function* () {
  const heartbeats = tour.events.filter((e) => e._tag === "Heartbeat").length;
  const timeout = Option.match(tour.timeout, {
    onNone: () => "none",
    onSome: (s) => `${s}s`,
  });
  yield* Console.log(
    `${tour.name} costs ${BigDecimal.format(tour.price)}, timeout ${timeout}, ${heartbeats} heartbeat(s)`,
  );
});

/** person.haus has no schema: its type is inferred from the data (decimals as exact strings). */
const peopleSummary = Effect.forEach(people, (person) =>
  Console.log(
    `${person.name}: ${person.profession._tag}, earns ${person.salary.values[0]} ${person.salary.values[1]}`,
  ),
);

const program = Effect.gen(function* () {
  yield* threadSummary;
  yield* replyRoundTrip;
  yield* Console.log("events.haus:");
  yield* events;
  yield* tourSummary;
  yield* peopleSummary;
});

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
