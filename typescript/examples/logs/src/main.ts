// A log, read as a stream: each entry is decoded as soon as its comma
// arrives, so memory holds one entry, not the whole file. The same steps as
// rust/examples/logs, on the same files. Run: pnpm start
import * as Haus from "@haus-fmt/effect";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, DateTime, Effect, FileSystem, Path, Stdio, Stream } from "effect";
import { Entry } from "../../../../examples/logs.schema.haus";

/** One line per entry. Entries of kinds the schema doesn't know are "@unknown". */
const describe = (entry: Entry): string => {
  switch (entry._tag) {
    case "Log":
      return `${time(entry.at)} ${entry.level} ${entry.service}: ${entry.message}`;
    case "Request":
      return `${time(entry.at)} ${entry.method} ${entry.path} → ${entry.status} in ${entry.ms} ms`;
    case "@unknown":
      return `(skipped an entry of kind ${entry.tag})`;
  }
};

const isProblem = (entry: Entry): boolean =>
  (entry._tag === "Log" && (entry.level === "Warn" || entry.level === "Error")) ||
  (entry._tag === "Request" && entry.status >= 500);

/** `09:00:02` of `2026-11-11T09:00:02Z`. */
const time = (at: DateTime.Utc) => DateTime.formatIso(at).slice(11, 19);

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const stdio = yield* Stdio.Stdio;
  const log = yield* (yield* Path.Path).fromFileUrl(new URL("../../../../examples/logs.haus", import.meta.url));

  // 1. Read the stream entry by entry: an Effect Stream over a file (or a socket, or a fetch body).
  const problems = yield* Haus.decodeStream(Entry)(fs.stream(log)).pipe(
    Stream.tap((entry) => Console.log(describe(entry))),
    Stream.filter(isProblem),
    Stream.runCollect,
  );

  // 2. Write a stream: the problems, one entry per line.
  yield* Console.log("problems:");
  yield* Haus.encodeStream(Entry)(Stream.fromIterable(problems)).pipe(
    Stream.run(stdio.stdout({ endOnDone: false })),
  );
});

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
