/** Code shown on the landing page. Keep in step with the README and examples. */

export const heroHaus = `
// Comments are welcome, keys don't need quotes.
{
  order: 1042,
  placed: Date("2026-11-08"),
  total: 30.30,
  status: Shipped {
    tracking: "DE-4711",
    at: Instant("2026-11-09T09:12:00Z"),
  },
  gift: True,
  note: None,
}
`;

export const compareHaus = `
{
  order: 1042,
  placed: Date("2026-11-08"),
  total: 30.30,
  status: Shipped {
    tracking: "DE-4711",
    at: Instant("2026-11-09T09:12:00Z"),
  },
  gift: True,
  note: None,
}
`;

export const compareJson = `
{
  "order": 1042,
  "placed": "2026-11-08",
  "total": "30.30",
  "status": {
    "type": "shipped",
    "tracking": "DE-4711",
    "at": "2026-11-09T09:12:00Z"
  },
  "gift": true,
  "note": null
}
`;

export const streamHaus = `
UserCreated { id: 42, email: "jan@example.com" },
PaymentReceived { id: 42, amount: Money(19.99, EUR) },
Heartbeat,
`;

export const schemaHaus = `
import std/time (Instant)

type Comment = closed < Comment {
  author: String,
  at: Instant,
  text: String,
  likes: Int,
  replies: Array Comment,
} >

type Root = Comment
`;

export const threadHaus = `
Comment {
  author: "ada",
  at: Instant("2026-11-01T09:00:00Z"),
  text: "Should haus have null?",
  likes: 0,
  replies: [
    Comment {
      author: "bob",
      at: Instant("2026-11-02T09:00:00Z"),
      text: "JSON has it, people expect it.",
      likes: 2,
      replies: [],
    },
  ],
}
`;

export const codeTs = `
import * as Haus from "@betalyra/haus-fmt-effect"
import { Effect } from "effect"
import thread from "./thread.haus"     // checked against its schema
import { Comment } from "./thread.schema.haus"

thread.author      // String        → string
thread.at          // Instant       → DateTime.Utc
thread.likes       // Int           → bigint, no size limit
thread.replies     // Array Comment → Comment[]

const program = Effect.gen(function* () {
  const liked = { ...thread, likes: thread.likes + 1n }
  return yield* Haus.encode(Comment, { style: "compact" })(liked)
})
`;

export const codeRust = `
mod thread {
    haus::include_schema!("thread"); // from thread.schema.haus
}
use thread::Comment;

let thread: Comment = haus::from_str(include_str!("thread.haus"))?;

thread.author      // String        → String
thread.likes       // Int           → haus::Int, no size limit
thread.replies     // Array Comment → Vec<Comment>

let likes = thread.likes.to_i128().unwrap_or_default() + 1;
let liked = Comment { likes: likes.into(), ..thread };
println!("{}", haus::to_string(&liked));
`;

export const codeRoc = `
import haus.Decode
import haus.Encode
import Thread

path : Path
path = "thread.haus"
thread = Decode.one(path.read_utf8!()?, Thread.decode_root)?

# author  : Str            String
# likes   : I128           Int
# replies : List(Comment)  Array Comment

liked = match thread {
    Comment(c) => Comment({ ..c, likes: c.likes + 1 })
}
Stdout.line!(Encode.to_str(Thread.encode_comment(liked)))?
`;

export const features = [
  {
    key: "write",
    file: "note.haus",
    wash: ["violet", "rose"],
    title: "Pleasant to write",
    text: "No quotes around keys, comments where you need them, trailing commas, and multi-line text that keeps its shape. Easy to write by hand, easy to read in a diff.",
    code: `{
  // keys without quotes, comments, trailing commas
  note: """
    Leave it at the door,
    the bell is broken.
    """,
}`,
  },
  {
    key: "variants",
    file: "order.schema.haus",
    wash: ["rose", "gold"],
    title: "Variants",
    text: "A value says which case it is and carries the data for that case. In your code it becomes a type **the compiler checks**. Close a variant when the list is final, or leave it open so you can add cases later.",
    code: `// closed: exactly these cases, nothing else
type Status = closed <
  | Pending
  | Shipped { tracking: String }
  | Cancelled
>

// open: new cases can be added later
type Event = < Login { user: String } | Logout >`,
  },
  {
    key: "open",
    file: "logs.haus",
    wash: ["sap", "yellow"],
    title: "Grows without breaking",
    text: "Readers skip fields they don't know and keep cases they don't know yet, so you can **add to your data at any time**. When a type must be exact, mark it closed.",
    code: `// a reader that doesn't know Deploy yet
// keeps it as an unknown value
Deploy { version: "1.4.2" },`,
  },
  {
    key: "extend",
    file: "events.schema.haus",
    wash: ["ultramarine", "violet"],
    title: "Types built from types",
    text: "Build a type from other types instead of copying them: ...UserEvent brings in every case of UserEvent. Each module defines its own events, and the app's event type combines them, still fully checked.",
    code: `// the user module's events
type UserEvent = <
  | UserCreated { id: Int }
  | UserRenamed { id: Int, to: String }
>

// all user events plus Heartbeat, nothing else
type AppEvent = closed < ...UserEvent | Heartbeat >`,
  },
  {
    key: "time",
    file: "order.haus",
    wash: ["cerulean", "sap"],
    title: "Dates and times, built in",
    text: "Date, Instant, Duration and time zones work in **every parser**, in one strict ISO 8601 format. No more guessing what a date string means.",
    code: `{
  placed: Date("2026-11-07"),
  at: Instant("2026-11-07T09:12:00Z"),
  within: Duration("PT48H"),
}`,
  },
  {
    key: "packages",
    file: "order.schema.haus",
    wash: ["sienna", "gold"],
    title: "Make it yours",
    text: "Everything beyond time comes as an extension: a schema package you install like any other dependency. Codecs map its types onto your own. We maintain official extensions for common needs, and anyone can publish their own.",
    code: `import std/time (Date)       // built in
import @haus/geo (LatLng)    // an extension
import ./common (Address)    // your own`,
  },
  {
    key: "typed",
    file: "order.haus",
    wash: ["cerulean", "ultramarine"],
    title: "Checked as you type",
    text: "A schema is optional: every haus file can be read without one. Add a schema next to your data, and your editor checks the data as you write it while your build turns the schema into real types.",
    code: `// schema: ./order.schema.haus
{ order: 1042, placed: Date("2026-11-08") }`,
  },
  {
    key: "streams",
    file: "logs.haus",
    wash: ["gold", "rose"],
    title: "Streams built in",
    text: "A file can hold many values in a row. Append a line, tail -f it, or handle each entry as soon as it arrives.",
    code: `Log { level: Info, message: "started" },
Request { path: "/orders/7", status: 200 },`,
  },
] as const;
