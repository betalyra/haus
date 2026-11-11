# The std/time profile

Which strings each type of [`std/time`](time.schema.haus) accepts (spec §13.2).
Every schema binding checks exactly these rules: they are built-in rules, like
the range of `UInt8`. A parser does not check them (§13.1).

The profile is a strict subset of RFC 3339, RFC 9557 and ISO 8601 durations,
close to what JavaScript's Temporal and java.time parse. There is one spelling
for each value, and nothing depends on a registry.

## Types

| Type | Form | Example |
|---|---|---|
| `Date` | `YYYY-MM-DD` | `Date("2026-11-09")` |
| `Time` | `hh:mm:ss`, optional fraction of 1–9 digits | `Time("14:30:00.250")` |
| `DateTime` | `Date` `T` `Time`, no offset | `DateTime("2026-11-09T14:30:00")` |
| `Instant` | `DateTime` and an offset | `Instant("2026-11-09T14:30:00Z")` |
| `ZonedDateTime` | `Instant` and one zone in brackets | `ZonedDateTime("2027-03-29T10:00:00+01:00[Europe/Lisbon]")` |
| `Duration` | `-`? `P` [n`Y`] [n`M`] [n`W`] [n`D`] [`T` [n`H`] [n`M`] [n[.f]`S`]] | `Duration("PT1H30M")` |
| `YearMonth` | `YYYY-MM` | `YearMonth("2026-11")` |
| `TimeZone` | a zone name or an offset | `TimeZone("Europe/Lisbon")`, `TimeZone("+01:00")` |

## Rules

| Rule | Accepted | Rejected |
|---|---|---|
| Year | `0000`–`9999`, exactly 4 digits | `+12026-11-09`, `-0001-01-01` |
| Day | the day exists in the proleptic Gregorian calendar | `2026-02-29`, `1900-02-29`, `2026-04-31` |
| Month | `01`–`12` | `2026-13-01`, `2026-00-10` |
| Hour, minute, second | `00`–`23`, `00`–`59`, `00`–`59`; seconds required | `14:30`, `24:00:00`, `12:60:00` |
| Leap seconds | — | `23:59:60` |
| Fraction | 1–9 digits (nanoseconds), on seconds only | `12:00:00.1234567890`, `PT1.5H` |
| Separators | upper-case `T` and `Z` | `t`, `z`, a space instead of `T` |
| Offset | `Z` or `±hh:mm`, up to `±23:59` | `-00:00` (write `Z`), `+24:00`, `+0100` |
| Zone | an IANA name by its syntax: parts of `A–Z a–z 0–9 . _ + -` separated by `/`, the first starting with a letter, no `.` or `..` parts; or an offset `±hh:mm` | `[!Europe/Lisbon]`, `[Europe/../etc]` |
| RFC 9557 tags | exactly one zone | `[Europe/Lisbon][u-ca=iso8601]`, other calendars |
| Duration | at least one component; `T` followed by at least one; years, months and weeks below 2³²; days and time together below 2⁵³ seconds | `P`, `PT`, `P1DT`, `+PT1H`, `p1d` |
| Other ISO 8601 forms | — | week dates (`2026-W45-1`), ordinal dates (`2026-313`), the basic format (`20261109`), intervals (`…/…`), repetitions (`R5/…`) |

## What is not checked

Nothing that depends on a registry:

- whether a zone name exists in the tz database (`Europe/Atlantis` is valid);
- whether the offset of a `ZonedDateTime` matches its zone at that time. When
  the tz database changes, a stored `…+01:00[Europe/Lisbon]` may stop matching;
  it stays valid, and the application decides what to do (like Temporal's
  `offset: "reject" | "prefer" | "use" | "ignore"`);
- leap seconds, which only a registry could tell apart from seconds that never
  existed (and which end by 2035).

## Values

- `Instant` is a point on the timeline: `…T14:30:00+01:00` and `…T13:30:00Z`
  are the same instant, and `.250` and `.25` the same fraction.
- `Duration` compares component by component: `PT90M` and `PT1H30M` are
  different durations. Months have no fixed length, so durations have no total
  order.
- The other types compare by their fields (`Date` by year, month and day).

The TypeScript implementation's tests
([`std-time.test.ts`](../../typescript/packages/haus/test/std-time.test.ts))
cover every row above; language-neutral test vectors and a Lean reference
model are planned.
