// The quickstart: data typed by its schema, decoding, encoding and errors.
// The same steps as rust/examples/quickstart, on the same files. Run: pnpm start
import * as Haus from "@haus-fmt/effect";
import { Console, Effect } from "effect";
// A data file is a module, typed (and checked) by the schema next to it.
import thread from "../../../../examples/thread.haus";
// A schema file exports its types and their schemas.
import { Comment } from "../../../../examples/thread.schema.haus";

const likes = (c: Comment): bigint => c.replies.reduce((sum, reply) => sum + likes(reply), c.likes);
const depth = (c: Comment): number => 1 + Math.max(0, ...c.replies.map(depth));

const reply = `Comment { author: "me", at: Instant("2026-11-16T09:00:00Z"), text: "+1", likes: 0, replies: [] }`;

const program = Effect.gen(function* () {
  // 1. The thread, as typed data: Int is bigint, Instant is DateTime.Utc.
  yield* Console.log(`thread by ${thread.author}: ${depth(thread)} levels, ${likes(thread)} likes`);

  // 2. Decode haus text with the schema, change it, encode it back.
  const decoded = yield* Haus.decode(Comment)(reply);
  const liked = { ...decoded, likes: decoded.likes + 1n };
  yield* Console.log(yield* Haus.encode(Comment, { style: "compact" })(liked));

  // 3. A value that doesn't match the schema is an error that says where.
  const error = yield* Effect.flip(Haus.decode(Comment)(reply.replace("likes: 0", `likes: "lots"`)));
  yield* Console.log(`error: ${error.message}`);
});

Effect.runPromise(program);
