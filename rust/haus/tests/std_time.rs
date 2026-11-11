//! The std/time profile (spec/std/time.md): the same cases as the TypeScript
//! binding (typescript/packages/haus/test/std-time.test.ts).

use haus::time::check;

const VALID: &[(&str, &str)] = &[
    ("Date", "2026-11-09"),
    ("Date", "2024-02-29"),
    ("Date", "2000-02-29"),
    ("Date", "0000-01-01"),
    ("Date", "9999-12-31"),
    ("Time", "00:00:00"),
    ("Time", "23:59:59.999999999"),
    ("DateTime", "2026-11-09T14:30:00"),
    ("DateTime", "2026-11-09T14:30:00.25"),
    ("Instant", "2026-11-09T14:30:00Z"),
    ("Instant", "2026-11-09T14:30:00+01:00"),
    ("Instant", "2026-11-09T14:30:00.5-23:59"),
    ("ZonedDateTime", "2027-03-29T10:00:00+01:00[Europe/Lisbon]"),
    ("ZonedDateTime", "2027-03-29T10:00:00+01:00[Europe/Atlantis]"), // syntax only: the zone is not looked up
    ("ZonedDateTime", "2027-03-29T10:00:00+05:00[Europe/Lisbon]"),   // an offset that doesn't match the zone is valid
    ("ZonedDateTime", "2026-11-09T14:30:00Z[+01:00]"),
    ("ZonedDateTime", "2026-11-09T14:30:00-05:00[America/Port-au-Prince]"),
    ("Duration", "PT30S"),
    ("Duration", "P1Y2M3W4DT5H6M7.5S"),
    ("Duration", "-PT1H"),
    ("Duration", "P0D"),
    ("YearMonth", "2026-11"),
    ("TimeZone", "Europe/Lisbon"),
    ("TimeZone", "UTC"),
    ("TimeZone", "Etc/GMT+1"),
    ("TimeZone", "-03:30"),
];

const INVALID: &[(&str, &str, &str)] = &[
    ("Date", "2026-02-30", "2026-02 has no day 30"),
    ("Date", "2026-02-29", "2026 is not a leap year"),
    ("Date", "1900-02-29", "1900 is not a leap year"),
    ("Date", "2026-13-01", "month 13 doesn't exist"),
    ("Date", "2026-00-10", "month 00 doesn't exist"),
    ("Date", "20261109", "write it like 2026-11-09"),
    ("Date", "+12026-11-09", "write it like"),
    ("Date", "2026-W45-1", "write it like"),
    ("Date", "2026-313", "write it like"),
    ("Time", "14:30", "write it like 14:30:00"),
    ("Time", "24:00:00", "24:00 is not allowed"),
    ("Time", "23:59:60", "leap seconds (:60) are not allowed"),
    ("Time", "12:60:00", "minute 60 doesn't exist"),
    ("Time", "12:00:00.1234567890", "write it like"),
    ("DateTime", "2026-11-09t14:30:00", "write it like"),
    ("DateTime", "2026-11-09 14:30:00", "write it like"),
    ("DateTime", "2026-11-09T14:30:00Z", "write it like"),
    ("Instant", "2026-11-09T14:30:00", "write it like 2026-11-09T14:30:00Z"),
    ("Instant", "2026-11-09T14:30:00z", "write it like"),
    ("Instant", "2026-11-09T14:30:00-00:00", "-00:00 is not allowed; write Z"),
    ("Instant", "2026-11-09T14:30:00+24:00", "offset +24:00 is out of range"),
    ("Instant", "2016-12-31T23:59:60Z", "leap seconds"),
    ("ZonedDateTime", "2027-03-29T10:00:00[Europe/Lisbon]", "write it like"),
    ("ZonedDateTime", "2027-03-29T10:00:00+01:00", "write it like"),
    ("ZonedDateTime", "2027-03-29T10:00:00+01:00[!Europe/Lisbon]", "not an IANA zone name"),
    ("ZonedDateTime", "2027-03-29T10:00:00+01:00[Europe/Lisbon][u-ca=iso8601]", "write it like"),
    ("ZonedDateTime", "2027-03-29T10:00:00+01:00[Europe/../etc]", "not an IANA zone name"),
    ("Duration", "P", "at least one component"),
    ("Duration", "PT", "at least one component"),
    ("Duration", "P1DT", "T must be followed"),
    ("Duration", "+PT1H", "write it like"),
    ("Duration", "PT1.5H", "write it like"),
    ("Duration", "p1d", "write it like"),
    ("Duration", "P4294967296Y", "too large"),
    ("Duration", "P104249991375D", "below 2^53 seconds"),
    ("YearMonth", "2026-13", "month 13 doesn't exist"),
    ("YearMonth", "2026-1", "write it like"),
    ("TimeZone", "europe lisbon", "not an IANA zone name"),
    ("TimeZone", "/Lisbon", "not an IANA zone name"),
];

#[test]
fn accepts() {
    for (ty, text) in VALID {
        assert_eq!(check(ty, text), Ok(()), "{ty} {text}");
    }
}

#[test]
fn rejects() {
    for (ty, text, reason) in INVALID {
        let got = check(ty, text).expect_err(&format!("accepted {ty} {text}"));
        assert!(got.contains(reason), "{ty} {text}: {got}");
    }
}

#[test]
fn decodes_through_the_tag() {
    use haus::{from_str, time::Date};
    assert_eq!(from_str::<Date>(r#"Date("2024-02-29")"#).unwrap().as_str(), "2024-02-29");
    let e = from_str::<Date>(r#"Date("2026-02-30")"#).unwrap_err().to_string();
    assert_eq!(e, r#"(Date)[0]: "2026-02-30" is not a valid Date: 2026-02 has no day 30"#);
    assert!(from_str::<Date>(r#"Instant("2026-02-03T00:00:00Z")"#).is_err());
}
