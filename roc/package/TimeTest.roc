## The std/time profile: the same cases as the TypeScript and Rust bindings
## (typescript/packages/haus/test/std-time.test.ts).
import Time

TimeTest := [].{}

expect Time.check("Date", "2026-11-09") == Ok({})
expect Time.check("Date", "2024-02-29") == Ok({})
expect Time.check("Date", "2000-02-29") == Ok({})
expect Time.check("Date", "0000-01-01") == Ok({})
expect Time.check("Date", "9999-12-31") == Ok({})
expect Time.check("Time", "00:00:00") == Ok({})
expect Time.check("Time", "23:59:59.999999999") == Ok({})
expect Time.check("DateTime", "2026-11-09T14:30:00") == Ok({})
expect Time.check("DateTime", "2026-11-09T14:30:00.25") == Ok({})
expect Time.check("Instant", "2026-11-09T14:30:00Z") == Ok({})
expect Time.check("Instant", "2026-11-09T14:30:00+01:00") == Ok({})
expect Time.check("Instant", "2026-11-09T14:30:00.5-23:59") == Ok({})
expect Time.check("ZonedDateTime", "2027-03-29T10:00:00+01:00[Europe/Lisbon]") == Ok({})
expect Time.check("ZonedDateTime", "2027-03-29T10:00:00+01:00[Europe/Atlantis]") == Ok({})
expect Time.check("ZonedDateTime", "2027-03-29T10:00:00+05:00[Europe/Lisbon]") == Ok({})
expect Time.check("ZonedDateTime", "2026-11-09T14:30:00Z[+01:00]") == Ok({})
expect Time.check("ZonedDateTime", "2026-11-09T14:30:00-05:00[America/Port-au-Prince]") == Ok({})
expect Time.check("Duration", "PT30S") == Ok({})
expect Time.check("Duration", "P1Y2M3W4DT5H6M7.5S") == Ok({})
expect Time.check("Duration", "-PT1H") == Ok({})
expect Time.check("Duration", "P0D") == Ok({})
expect Time.check("YearMonth", "2026-11") == Ok({})
expect Time.check("TimeZone", "Europe/Lisbon") == Ok({})
expect Time.check("TimeZone", "UTC") == Ok({})
expect Time.check("TimeZone", "Etc/GMT+1") == Ok({})
expect Time.check("TimeZone", "-03:30") == Ok({})

expect match Time.check("Date", "2026-02-30") {
	Ok(_) => False
	Err(e) => e.contains("2026-02 has no day 30")
}
expect match Time.check("Date", "2026-02-29") {
	Ok(_) => False
	Err(e) => e.contains("2026 is not a leap year")
}
expect match Time.check("Date", "1900-02-29") {
	Ok(_) => False
	Err(e) => e.contains("1900 is not a leap year")
}
expect match Time.check("Date", "2026-13-01") {
	Ok(_) => False
	Err(e) => e.contains("month 13 doesn't exist")
}
expect match Time.check("Date", "2026-00-10") {
	Ok(_) => False
	Err(e) => e.contains("month 00 doesn't exist")
}
expect match Time.check("Date", "20261109") {
	Ok(_) => False
	Err(e) => e.contains("write it like 2026-11-09")
}
expect match Time.check("Date", "+12026-11-09") {
	Ok(_) => False
	Err(e) => e.contains("write it like")
}
expect match Time.check("Date", "2026-W45-1") {
	Ok(_) => False
	Err(e) => e.contains("write it like")
}
expect match Time.check("Date", "2026-313") {
	Ok(_) => False
	Err(e) => e.contains("write it like")
}
expect match Time.check("Time", "14:30") {
	Ok(_) => False
	Err(e) => e.contains("write it like 14:30:00")
}
expect match Time.check("Time", "24:00:00") {
	Ok(_) => False
	Err(e) => e.contains("24:00 is not allowed")
}
expect match Time.check("Time", "23:59:60") {
	Ok(_) => False
	Err(e) => e.contains("leap seconds (:60) are not allowed")
}
expect match Time.check("Time", "12:60:00") {
	Ok(_) => False
	Err(e) => e.contains("minute 60 doesn't exist")
}
expect match Time.check("Time", "12:00:00.1234567890") {
	Ok(_) => False
	Err(e) => e.contains("write it like")
}
expect match Time.check("DateTime", "2026-11-09t14:30:00") {
	Ok(_) => False
	Err(e) => e.contains("write it like")
}
expect match Time.check("DateTime", "2026-11-09 14:30:00") {
	Ok(_) => False
	Err(e) => e.contains("write it like")
}
expect match Time.check("DateTime", "2026-11-09T14:30:00Z") {
	Ok(_) => False
	Err(e) => e.contains("write it like")
}
expect match Time.check("Instant", "2026-11-09T14:30:00") {
	Ok(_) => False
	Err(e) => e.contains("write it like 2026-11-09T14:30:00Z")
}
expect match Time.check("Instant", "2026-11-09T14:30:00z") {
	Ok(_) => False
	Err(e) => e.contains("write it like")
}
expect match Time.check("Instant", "2026-11-09T14:30:00-00:00") {
	Ok(_) => False
	Err(e) => e.contains("-00:00 is not allowed; write Z")
}
expect match Time.check("Instant", "2026-11-09T14:30:00+24:00") {
	Ok(_) => False
	Err(e) => e.contains("offset +24:00 is out of range")
}
expect match Time.check("Instant", "2016-12-31T23:59:60Z") {
	Ok(_) => False
	Err(e) => e.contains("leap seconds")
}
expect match Time.check("ZonedDateTime", "2027-03-29T10:00:00[Europe/Lisbon]") {
	Ok(_) => False
	Err(e) => e.contains("write it like")
}
expect match Time.check("ZonedDateTime", "2027-03-29T10:00:00+01:00") {
	Ok(_) => False
	Err(e) => e.contains("write it like")
}
expect match Time.check("ZonedDateTime", "2027-03-29T10:00:00+01:00[!Europe/Lisbon]") {
	Ok(_) => False
	Err(e) => e.contains("not an IANA zone name")
}
expect match Time.check("ZonedDateTime", "2027-03-29T10:00:00+01:00[Europe/Lisbon][u-ca=iso8601]") {
	Ok(_) => False
	Err(e) => e.contains("write it like")
}
expect match Time.check("ZonedDateTime", "2027-03-29T10:00:00+01:00[Europe/../etc]") {
	Ok(_) => False
	Err(e) => e.contains("not an IANA zone name")
}
expect match Time.check("Duration", "P") {
	Ok(_) => False
	Err(e) => e.contains("at least one component")
}
expect match Time.check("Duration", "PT") {
	Ok(_) => False
	Err(e) => e.contains("at least one component")
}
expect match Time.check("Duration", "P1DT") {
	Ok(_) => False
	Err(e) => e.contains("T must be followed")
}
expect match Time.check("Duration", "+PT1H") {
	Ok(_) => False
	Err(e) => e.contains("write it like")
}
expect match Time.check("Duration", "PT1.5H") {
	Ok(_) => False
	Err(e) => e.contains("write it like")
}
expect match Time.check("Duration", "p1d") {
	Ok(_) => False
	Err(e) => e.contains("write it like")
}
expect match Time.check("Duration", "P4294967296Y") {
	Ok(_) => False
	Err(e) => e.contains("too large")
}
expect match Time.check("Duration", "P104249991375D") {
	Ok(_) => False
	Err(e) => e.contains("below 2^53 seconds")
}
expect match Time.check("YearMonth", "2026-13") {
	Ok(_) => False
	Err(e) => e.contains("month 13 doesn't exist")
}
expect match Time.check("YearMonth", "2026-1") {
	Ok(_) => False
	Err(e) => e.contains("write it like")
}
expect match Time.check("TimeZone", "europe lisbon") {
	Ok(_) => False
	Err(e) => e.contains("not an IANA zone name")
}
expect match Time.check("TimeZone", "/Lisbon") {
	Ok(_) => False
	Err(e) => e.contains("not an IANA zone name")
}

# The duration bounds are exact, whatever the number of digits.
expect Time.check("Duration", "P4294967295Y") == Ok({})
expect Time.check("Duration", "PT9007199254740991S") == Ok({})
expect Time.check("Duration", "P104249991374D") == Ok({})
expect match Time.check("Duration", "PT9007199254740992S") {
	Ok(_) => False
	Err(e) => e.contains("below 2^53 seconds")
}
expect match Time.check("Duration", "P${"9".repeat(400)}Y") {
	Ok(_) => False
	Err(e) => e.contains("too large")
}
expect match Time.check("Duration", "PT${"9".repeat(400)}S") {
	Ok(_) => False
	Err(e) => e.contains("below 2^53 seconds")
}
expect match Time.check("TimeZone", "a".repeat(256)) {
	Ok(_) => False
	Err(e) => e.contains("not an IANA zone name")
}
expect match Time.check("TimeZone", "Europe//Lisbon") {
	Ok(_) => False
	Err(e) => e.contains("not an IANA zone name")
}
