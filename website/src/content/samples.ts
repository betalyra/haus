/** Code shown on the landing page. Keep in step with the README and examples. */

/** "This is haus.": a home, device by device (Showcase.astro). */
export const homeSteps = [
  `
[
  { room: "Kitchen", device: Light { brightness: 80 } },
]
`,
  `
[
  { room: "Kitchen", device: Light { brightness: 80 } },
  { room: "Living room", device: Thermostat { target: 21.5 } },
]
`,
  `
[
  { room: "Kitchen", device: Light { brightness: 80 } },
  { room: "Living room", device: Thermostat { target: 21.5 } },
  { room: "Hall", device: Lock { locked: True } },
]
`,
  `
[
  { room: "Kitchen", device: Light { brightness: 80 }, wakeUp: Time("07:00:00") },
  { room: "Living room", device: Thermostat { target: 21.5 } },
  { room: "Hall", device: Lock { locked: True } },
]
`,
];

/** An order, for the playground's presets. */
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
import * as Haus from "@haus-fmt/effect"
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

export const codeTsPlain = `
import * as h from "@haus-fmt/haus/schema"
import thread from "./thread.haus"     // checked against its schema
import { Comment } from "./thread.schema.haus"

thread.author      // String        → string
thread.at          // Instant       → Date
thread.likes       // Int           → bigint, no size limit
thread.replies     // Array Comment → Comment[]

const liked = { ...thread, likes: thread.likes + 1n }
console.log(h.stringify(Comment, liked))
`;

export const codePython = `
import haus
from haus import Record, Variant

thread = haus.parse(open("thread.haus").read())

match thread:
    case Variant("Comment", (Record(c),)):
        c["author"]    # String(value='ada')
        c["likes"]     # Number(text='0'), exact
        c["replies"]   # Array of Comment variants
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
    title: "Write it like a note",
    text: "Comments, keys without quotes, trailing commas, text blocks that keep their shape.",
    code: `{
  // keys without quotes, comments, trailing commas
  note: """
    Leave it at the door,
    the bell is broken.
    """,
}`,
  },
  {
    key: "cases",
    file: "payments.haus",
    wash: ["rose", "gold"],
    title: "Each case has its own data",
    text: "`Card { last4 }` or `PayPal { email }`: one value, never a pile of maybe-set fields.",
    code: `[
  Card { last4: "4242" },
  PayPal { email: "ada@example.com" },
  Invoice { dueIn: Duration("P30D") },
]`,
  },
  {
    key: "nonull",
    file: "people.haus",
    wash: ["sap", "yellow"],
    title: "No null",
    text: "A field is there or it isn't. `None` when \"nothing\" is a real answer.",
    code: `[
  { name: "Ada", nickname: Some("Countess") },
  { name: "Alan", nickname: None },   // has none
  { name: "Grace" },                  // not given
]`,
  },
  {
    key: "exact",
    file: "invoice.haus",
    wash: ["gold", "sienna"],
    title: "Exact by default",
    text: "`19.90` stays `19.90`. Dates, times and money are types, not strings.",
    code: `{
  total: Money(19.90, EUR),
  due: Date("2027-03-15"),
  views: 123_456_789_012_345_678_901,
}`,
  },
  {
    key: "grow",
    file: "team.schema.haus",
    wash: ["cerulean", "ultramarine"],
    title: "Add without breaking",
    text: "New fields and cases reach old readers safely. `closed` when every case must be handled.",
    code: `// open: new ways to reach people can come later
type Contact = < Email String | Slack { user: String } >

// closed: exactly these, nothing else
type Status = closed < Available | Away >`,
  },
  {
    key: "streams",
    file: "pages.haus",
    wash: ["cerulean", "sap"],
    title: "Every file is a stream",
    text: "Append, `tail -f`, read entries as they arrive.",
    code: `Paged { to: "Ada", at: Instant("2026-11-12T03:14:00Z") },
Acknowledged { by: "Ada" },
Escalated { to: "Grace" },`,
  },
] as const;
