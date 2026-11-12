import logsData from "../../../../examples/logs.haus?raw";
import logsSchema from "../../../../examples/logs.schema.haus?raw";
import { heroHaus, schemaHaus, threadHaus } from "@/content/samples";

export interface Preset {
  readonly name: string;
  readonly data: string;
  readonly schema: string;
}

const trim = (s: string) => s.trim() + "\n";

/** Simple ones first, each showing one idea; then the bigger examples of the repo. */
export const presets: readonly Preset[] = [
  {
    name: "Hello, haus",
    data: trim(`
// Keys without quotes, comments where you need them,
// and a comma after the last item is fine.
{
  name: "Ada",
  born: 1815,
  languages: ["English", "French"],
}`),
    schema: "",
  },
  {
    name: "Tags and variants",
    data: trim(`
// A tag says which case a value is, and can carry data.
{
  status: Done,
  shape: Circle { radius: 2.5 },
  point: Point(1, 2),
  // No null: a missing value is None, a present one Some(…).
  note: None,
  nickname: Some("Ada"),
  done: True,
}`),
    schema: "",
  },
  {
    name: "Dates and exact numbers",
    data: trim(`
{
  placed: Date("2026-11-12"),
  at: Instant("2026-11-12T09:30:00Z"),
  within: Duration("PT48H"),
  // Decimals stay exact: 19.90 is never 19.899999…
  total: 19.90,
  // Big integers too.
  id: 9007199254740993,
}`),
    schema: "",
  },
  {
    name: "A stream of values",
    data: trim(`
// A file can hold many values, each followed by a comma.
// Append a line and the file is still valid.
UserCreated { id: 1, name: "Ada" },
UserRenamed { id: 1, to: "Ada Lovelace" },
Heartbeat,`),
    schema: "",
  },
  {
    name: "Checked by a schema",
    data: trim(`
// The schema says age is an Int: fix it and the error goes away.
{
  name: "Ada",
  age: "36",
}`),
    schema: trim(`
type Root = {
  name: String,
  age: Int,
}`),
  },
  {
    name: "Variants: open and closed",
    data: trim(`
// Paused isn't in the schema: fine for the open Event,
// but try it in status, which is closed.
{
  status: Shipped { tracking: "DE-4711" },
  events: [Login { user: "ada" }, Logout, Paused],
}`),
    schema: trim(`
// closed: exactly these cases
type Status = closed <
  | Pending
  | Shipped { tracking: String }
  | Cancelled
>

// open: new cases can come later
type Event = < Login { user: String } | Logout >

type Root = { status: Status, events: Array Event }`),
  },
  { name: "An order", data: trim(heroHaus), schema: "" },
  { name: "A comment thread, with a schema", data: trim(threadHaus), schema: trim(schemaHaus) },
  { name: "A log stream, with a schema", data: trim(logsData), schema: trim(logsSchema) },
];
