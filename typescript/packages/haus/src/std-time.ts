/**
 * The std/time profile (spec/std/time.md): which strings each std/time type
 * accepts. A strict subset of RFC 3339 / RFC 9557 and ISO 8601 durations,
 * the same for every binding:
 *
 *   Date           2026-11-09                    the day must exist (Gregorian)
 *   Time           14:30:00, 14:30:00.250        seconds required, 1–9 fraction digits
 *   DateTime       2026-11-09T14:30:00           no offset
 *   Instant        2026-11-09T14:30:00Z          offset Z or ±HH:MM (not -00:00)
 *   ZonedDateTime  …+01:00[Europe/Lisbon]        offset and one zone; the zone is not looked up
 *   Duration       P1Y2M3W4DT5H6M7.5S, -PT30M    fraction only on seconds; no zero components (zero is PT0S)
 *   YearMonth      2026-11
 *   TimeZone       Europe/Lisbon, +01:00         IANA name syntax or an offset
 *
 * Rejected everywhere: lower-case t/z, a space instead of T, leap seconds
 * (:60), 24:00, years outside 0000–9999, week and ordinal dates, the basic
 * format without separators, and calendar or other RFC 9557 tags.
 *
 * Nothing here depends on a registry: whether a zone exists, or whether an
 * offset matches its zone at that time, is up to the application.
 */

export const STD_TIME_TYPES = ["Date", "Time", "DateTime", "Instant", "ZonedDateTime", "Duration", "YearMonth", "TimeZone"] as const
export type StdTimeType = (typeof STD_TIME_TYPES)[number]

const isLeap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
const daysIn = (y: number, m: number) => (m === 2 ? (isLeap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31)

const DATE = String.raw`(\d{4})-(\d{2})-(\d{2})`
const TIME = String.raw`(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?`
const OFFSET = String.raw`(Z|[+-]\d{2}:\d{2})`

const date = (y: string, m: string, d: string): string | undefined => {
  const month = Number(m)
  if (month < 1 || month > 12) return `month ${m} doesn't exist`
  const day = Number(d)
  const max = daysIn(Number(y), month)
  if (day < 1 || day > max) return `${y}-${m} has no day ${d}${month === 2 && day === 29 ? ` (${y} is not a leap year)` : ""}`
  return undefined
}

const time = (h: string, min: string, s: string): string | undefined => {
  if (Number(h) > 23) return h === "24" ? "24:00 is not allowed; write 00:00 of the next day" : `hour ${h} doesn't exist`
  if (Number(min) > 59) return `minute ${min} doesn't exist`
  if (s === "60") return "leap seconds (:60) are not allowed"
  if (Number(s) > 59) return `second ${s} doesn't exist`
  return undefined
}

const offset = (o: string): string | undefined => {
  if (o === "Z") return undefined
  if (o === "-00:00") return "-00:00 is not allowed; write Z"
  const [h, m] = o.slice(1).split(":").map(Number) as [number, number]
  if (h > 23 || m > 59) return `offset ${o} is out of range (±23:59 at most)`
  return undefined
}

/** IANA zone name syntax (Area/Location), not looked up in the tz database. */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9._+-]*(\/[A-Za-z0-9._+-]+)*$/
const zone = (z: string): string | undefined => {
  if (/^[+-]\d{2}:\d{2}$/.test(z)) return offset(z)
  if (z.length > 255 || !ZONE_NAME.test(z) || z.split("/").some((p) => p === "." || p === "..")) {
    return `${JSON.stringify(z)} is not an IANA zone name (like Europe/Lisbon) or an offset (like +01:00)`
  }
  return undefined
}

const first = (...checks: ReadonlyArray<() => string | undefined>): string | undefined => {
  for (const c of checks) {
    const r = c()
    if (r !== undefined) return r
  }
  return undefined
}

const shapes: Record<StdTimeType, { readonly re: RegExp; readonly example: string; readonly check: (m: RegExpExecArray) => string | undefined }> = {
  Date: { re: new RegExp(`^${DATE}$`), example: "2026-11-09", check: (m) => date(m[1]!, m[2]!, m[3]!) },
  Time: { re: new RegExp(`^${TIME}$`), example: "14:30:00", check: (m) => time(m[1]!, m[2]!, m[3]!) },
  DateTime: {
    re: new RegExp(`^${DATE}T${TIME}$`),
    example: "2026-11-09T14:30:00",
    check: (m) => first(() => date(m[1]!, m[2]!, m[3]!), () => time(m[4]!, m[5]!, m[6]!)),
  },
  Instant: {
    re: new RegExp(`^${DATE}T${TIME}${OFFSET}$`),
    example: "2026-11-09T14:30:00Z",
    check: (m) => first(() => date(m[1]!, m[2]!, m[3]!), () => time(m[4]!, m[5]!, m[6]!), () => offset(m[8]!)),
  },
  ZonedDateTime: {
    re: new RegExp(String.raw`^${DATE}T${TIME}${OFFSET}\[([^\]]*)\]$`),
    example: "2026-11-09T14:30:00+01:00[Europe/Lisbon]",
    check: (m) => first(() => date(m[1]!, m[2]!, m[3]!), () => time(m[4]!, m[5]!, m[6]!), () => offset(m[8]!), () => zone(m[9]!)),
  },
  Duration: {
    re: /^-?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d{1,9}))?S)?)?$/,
    example: "PT1H30M",
    check: (m) => {
      const [, y, mo, w, d, h, min, s, f] = m
      if ([y, mo, w, d, h, min, s].every((x) => x === undefined)) return "a duration needs at least one component, like PT0S"
      if (m[0].endsWith("T")) return "T must be followed by hours, minutes or seconds"
      const padded = [y, mo, w, d, h, min, s].find((x) => x !== undefined && x.length > 1 && x.startsWith("0"))
      if (padded !== undefined) return `${padded} has a leading zero`
      const others = [y, mo, w, d, h, min].filter((x) => x !== undefined)
      const zeroSeconds = s === "0" && !/[1-9]/.test(f ?? "")
      if (others.includes("0") || (zeroSeconds && others.length > 0)) return "a duration leaves out components that are zero (zero is PT0S)"
      if (m[0].startsWith("-") && !/[1-9]/.test(m[0])) return "a zero duration has no sign"
      for (const x of [y, mo, w]) if (x !== undefined && Number(x) >= 2 ** 32) return `${x} is too large (years, months and weeks stay below 2^32)`
      const seconds = Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0)
      if (seconds >= 2 ** 53) return "days and time together must stay below 2^53 seconds"
      return undefined
    },
  },
  YearMonth: { re: /^(\d{4})-(\d{2})$/, example: "2026-11", check: (m) => (Number(m[2]) < 1 || Number(m[2]) > 12 ? `month ${m[2]} doesn't exist` : undefined) },
  TimeZone: { re: /^(.*)$/s, example: "Europe/Lisbon", check: (m) => zone(m[1]!) },
}

/** Why `text` is not a valid value of the std/time type `type`, or undefined if it is. */
export function checkStdTime(type: StdTimeType, text: string): string | undefined {
  const shape = shapes[type]
  const m = shape.re.exec(text)
  if (!m) return `${JSON.stringify(text)} is not a ${type}; write it like ${shape.example}`
  const reason = shape.check(m)
  return reason === undefined ? undefined : `${JSON.stringify(text)} is not a valid ${type}: ${reason}`
}

export const isStdTimeType = (name: string): name is StdTimeType => (STD_TIME_TYPES as readonly string[]).includes(name)
