"""The std/time profile (spec/std/time.md): the rules row by row, as in the
Lean model (spec/lean/Haus/Time/Check.lean) and the TypeScript tests."""

from __future__ import annotations

from pathlib import Path

import pytest

import haus
from haus import Record, String, Variant
from haus._time import STD_TIME_TYPES, check

SUITE = Path(__file__).resolve().parents[2] / "test-suite"

VALID: list[tuple[str, str]] = [
    # Types
    ("Date", "2026-11-09"),
    ("Time", "14:30:00.250"),
    ("DateTime", "2026-11-09T14:30:00"),
    ("Instant", "2026-11-09T14:30:00Z"),
    ("ZonedDateTime", "2027-03-29T10:00:00+01:00[Europe/Lisbon]"),
    ("Duration", "PT1H30M"),
    ("YearMonth", "2026-11"),
    ("TimeZone", "Europe/Lisbon"),
    ("TimeZone", "+01:00"),
    # Year, day
    ("Date", "0000-01-01"),
    ("Date", "9999-12-31"),
    ("Date", "2024-02-29"),
    ("Date", "2000-02-29"),
    ("Date", "0000-02-29"),
    ("Date", "2026-01-31"),
    ("Date", "2026-04-30"),
    # Times
    ("Time", "00:00:00"),
    ("Time", "23:59:59"),
    ("Time", "23:59:59.999999999"),
    ("Time", "12:00:00.123456789"),
    ("DateTime", "2026-11-09T14:30:00.25"),
    # Offsets
    ("Instant", "2026-11-09T14:30:00+01:00"),
    ("Instant", "2026-11-09T14:30:00+00:00"),
    ("Instant", "2026-11-09T14:30:00-23:59"),
    ("Instant", "2026-11-09T14:30:00.5-23:59"),
    # Zones: syntax only, never looked up; the offset needn't match the zone
    ("ZonedDateTime", "2027-03-29T10:00:00+01:00[Europe/Atlantis]"),
    ("ZonedDateTime", "2027-03-29T10:00:00+05:00[Europe/Lisbon]"),
    ("ZonedDateTime", "2026-11-09T14:30:00Z[+01:00]"),
    ("ZonedDateTime", "2026-11-09T14:30:00-05:00[America/Port-au-Prince]"),
    ("TimeZone", "UTC"),
    ("TimeZone", "Z"),
    ("TimeZone", "Etc/GMT+1"),
    ("TimeZone", "Etc/GMT+5"),
    ("TimeZone", "-03:30"),
    ("TimeZone", "America/Argentina/Buenos_Aires"),
    ("TimeZone", "a/..."),
    ("TimeZone", "a/.x"),
    ("TimeZone", "a" * 255),
    # Durations
    ("Duration", "PT30S"),
    ("Duration", "P1M"),
    ("Duration", "PT1M"),
    ("Duration", "P1Y2M3W4DT5H6M7.5S"),
    ("Duration", "-P1Y2M3W4DT5H6M7.5S"),
    ("Duration", "-PT1H"),
    ("Duration", "PT0S"),
    ("Duration", "PT0.000S"),
    ("Duration", "P1DT0.5S"),
    ("Duration", "PT0.5S"),
    ("Duration", "PT0.05S"),
    ("Duration", "PT1.5S"),
    ("Duration", "-PT0.001S"),
    ("Duration", "-P10D"),
    ("Duration", "P4294967295Y"),
    ("Duration", "P4294967295M"),
    ("Duration", "P4294967295W"),
    ("Duration", "PT9007199254740991S"),
    ("Duration", "PT9007199254740991.999999999S"),
    ("Duration", "P104249991374D"),
    ("Duration", "P104249991374DT27391S"),
    ("Duration", "P104249991374DT27391.999999999S"),
    ("Duration", "PT150119987579016M"),
    ("Duration", "PT2501999792983H"),
]

INVALID: list[tuple[str, str, str]] = [
    # Year
    ("Date", "+12026-11-09", "write it like"),
    ("Date", "-0001-01-01", "write it like"),
    ("Date", "12026-11-09", "write it like"),
    # Day: the proleptic Gregorian calendar
    ("Date", "2026-02-29", "2026 is not a leap year"),
    ("Date", "1900-02-29", "1900 is not a leap year"),
    ("Date", "2100-02-29", "2100 is not a leap year"),
    ("Date", "2024-02-30", "2024-02 has no day 30"),
    ("Date", "2026-02-30", "2026-02 has no day 30"),
    ("Date", "2026-04-31", "2026-04 has no day 31"),
    ("Date", "2026-06-31", "has no day 31"),
    ("Date", "2026-09-31", "has no day 31"),
    ("Date", "2026-11-31", "has no day 31"),
    ("Date", "2026-01-32", "has no day 32"),
    ("Date", "2026-01-00", "has no day 00"),
    # Month
    ("Date", "2026-13-01", "month 13 doesn't exist"),
    ("Date", "2026-00-10", "month 00 doesn't exist"),
    ("YearMonth", "2026-13", "month 13 doesn't exist"),
    ("YearMonth", "2026-00", "month 00 doesn't exist"),
    ("YearMonth", "2026-1", "write it like"),
    ("YearMonth", "2026-11-01", "write it like"),
    # Hour, minute, second
    ("Time", "14:30", "write it like 14:30:00"),
    ("Time", "24:00:00", "24:00 is not allowed"),
    ("Time", "25:00:00", "hour 25 doesn't exist"),
    ("Time", "12:60:00", "minute 60 doesn't exist"),
    ("Time", "12:00:61", "second 61 doesn't exist"),
    ("Time", "1:00:00", "write it like"),
    # Leap seconds
    ("Time", "23:59:60", "leap seconds (:60) are not allowed"),
    ("Instant", "2016-12-31T23:59:60Z", "leap seconds"),
    # Fraction
    ("Time", "12:00:00.1234567890", "write it like"),
    ("Time", "12:00:00.", "write it like"),
    ("Time", "12:00:00,5", "write it like"),
    ("Time", "12:00.5:00", "write it like"),
    ("Duration", "PT1.5H", "write it like"),
    ("Duration", "PT1.5M", "write it like"),
    ("Duration", "P1.5D", "write it like"),
    ("Duration", "PT1.1234567890S", "write it like"),
    ("Duration", "PT1.S", "write it like"),
    # Separators
    ("DateTime", "2026-11-09t14:30:00", "write it like"),
    ("DateTime", "2026-11-09 14:30:00", "write it like"),
    ("DateTime", "2026-11-09T14:30:00Z", "write it like"),
    ("Instant", "2026-11-09T14:30:00z", "write it like"),
    # Offset
    ("Instant", "2026-11-09T14:30:00", "write it like 2026-11-09T14:30:00Z"),
    ("Instant", "2026-11-09T14:30:00-00:00", "-00:00 is not allowed; write Z"),
    ("Instant", "2026-11-09T14:30:00+24:00", "offset +24:00 is out of range"),
    ("Instant", "2026-11-09T14:30:00+01:60", "offset +01:60 is out of range"),
    ("Instant", "2026-11-09T14:30:00+0100", "write it like"),
    ("Instant", "2026-11-09T14:30:00+01", "write it like"),
    # Zone
    ("ZonedDateTime", "2027-03-29T10:00:00+01:00[!Europe/Lisbon]", "not an IANA zone name"),
    ("ZonedDateTime", "2027-03-29T10:00:00+01:00[Europe/../etc]", "not an IANA zone name"),
    ("ZonedDateTime", "2027-03-29T10:00:00+01:00[Europe//Lisbon]", "not an IANA zone name"),
    ("ZonedDateTime", "2027-03-29T10:00:00+01:00[]", "not an IANA zone name"),
    ("ZonedDateTime", "2027-03-29T10:00:00+01:00[-00:00]", "-00:00 is not allowed"),
    ("TimeZone", "Europe/../etc", "not an IANA zone name"),
    ("TimeZone", "./x", "not an IANA zone name"),
    ("TimeZone", "Europe//Lisbon", "not an IANA zone name"),
    ("TimeZone", "Europe/", "not an IANA zone name"),
    ("TimeZone", "/Lisbon", "not an IANA zone name"),
    ("TimeZone", "1Europe", "not an IANA zone name"),
    ("TimeZone", "_Europe", "not an IANA zone name"),
    ("TimeZone", "", "not an IANA zone name"),
    ("TimeZone", "europe lisbon", "not an IANA zone name"),
    ("TimeZone", "Europe/Zürich", "not an IANA zone name"),
    ("TimeZone", "Europe/Lisbon\n", "not an IANA zone name"),
    ("TimeZone", "-00:00", "-00:00 is not allowed"),
    ("TimeZone", "+24:00", "offset +24:00 is out of range"),
    ("TimeZone", "+0100", "not an IANA zone name"),
    ("TimeZone", "a" * 256, "not an IANA zone name"),
    # RFC 9557 tags: exactly one zone
    ("ZonedDateTime", "2027-03-29T10:00:00+01:00[Europe/Lisbon][u-ca=iso8601]", "write it like"),
    ("ZonedDateTime", "2027-03-29T10:00:00+01:00", "write it like"),
    ("ZonedDateTime", "2027-03-29T10:00:00[Europe/Lisbon]", "write it like"),
    # Duration
    ("Duration", "P", "at least one component"),
    ("Duration", "PT", "at least one component"),
    ("Duration", "-P", "at least one component"),
    ("Duration", "P1DT", "T must be followed"),
    ("Duration", "+PT1H", "write it like"),
    ("Duration", "p1d", "write it like"),
    ("Duration", "pt1h", "write it like"),
    ("Duration", "PT1M1H", "write it like"),
    ("Duration", "P1D1Y", "write it like"),
    ("Duration", "P1H", "write it like"),
    ("Duration", "--P1D", "write it like"),
    ("Duration", "P01D", "leading zero"),
    ("Duration", "PT00S", "leading zero"),
    ("Duration", "PT01.5S", "leading zero"),
    ("Duration", "P0D", "leaves out components that are zero"),
    ("Duration", "P1DT0S", "leaves out components that are zero"),
    ("Duration", "P0Y1D", "leaves out components that are zero"),
    ("Duration", "P1Y0W", "leaves out components that are zero"),
    ("Duration", "PT1H0M", "leaves out components that are zero"),
    ("Duration", "PT0H1S", "leaves out components that are zero"),
    ("Duration", "PT0M0S", "leaves out components that are zero"),
    ("Duration", "PT1M0.0S", "leaves out components that are zero"),
    ("Duration", "P1DT0.00S", "leaves out components that are zero"),
    ("Duration", "-P0D", "leaves out components that are zero"),
    ("Duration", "-P0Y0M", "leaves out components that are zero"),
    ("Duration", "-PT0S", "a zero duration has no sign"),
    ("Duration", "-PT0.000S", "a zero duration has no sign"),
    ("Duration", "P4294967296Y", "too large"),
    ("Duration", "P4294967296M", "too large"),
    ("Duration", "P4294967296W", "too large"),
    ("Duration", "PT9007199254740992S", "below 2^53 seconds"),
    ("Duration", "P104249991375D", "below 2^53 seconds"),
    ("Duration", "P104249991374DT27392S", "below 2^53 seconds"),
    ("Duration", "PT150119987579017M", "below 2^53 seconds"),
    ("Duration", "PT2501999792984H", "below 2^53 seconds"),
    ("Duration", "P" + "9" * 400 + "Y", "too large"),
    ("Duration", "PT" + "9" * 400 + "S", "below 2^53 seconds"),
    ("Duration", "PT" + "9" * 5000 + "S", "below 2^53 seconds"),
    # Other ISO 8601 forms
    ("Date", "2026-W45-1", "write it like"),
    ("Date", "2026-313", "write it like"),
    ("Date", "20261109", "write it like 2026-11-09"),
    ("Duration", "R5/PT1H", "write it like"),
    ("Instant", "2026-11-09T14:30:00Z/2026-11-10T14:30:00Z", "write it like"),
    # Only ASCII digits
    ("Date", "\u0662\u0660\u0662\u0666-11-09", "write it like"),
    ("Time", "14:30:0\u0660", "write it like"),
    ("Duration", "PT\u0661S", "write it like"),
    # The whole string: no trailing newline
    ("Date", "2026-11-09\n", "write it like"),
    ("Duration", "PT1S\n", "write it like"),
]


def test_types() -> None:
    assert STD_TIME_TYPES == (
        "Date",
        "Time",
        "DateTime",
        "Instant",
        "ZonedDateTime",
        "Duration",
        "YearMonth",
        "TimeZone",
    )
    assert check("Money", "1") == "Money is not a std/time type"


@pytest.mark.parametrize(("type_name", "text"), VALID)
def test_accepts(type_name: str, text: str) -> None:
    assert check(type_name, text) is None


@pytest.mark.parametrize(("type_name", "text", "reason"), INVALID)
def test_rejects(type_name: str, text: str, reason: str) -> None:
    result = check(type_name, text)
    assert result is not None
    assert reason in result


def test_messages() -> None:
    assert (
        check("Date", "2026-02-29")
        == '"2026-02-29" is not a valid Date: 2026-02 has no day 29 (2026 is not a leap year)'
    )
    assert check("Time", "14:30") == '"14:30" is not a Time; write it like 14:30:00'


def test_leap_years() -> None:
    for year in range(10000):
        leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
        assert (check("Date", f"{year:04}-02-29") is None) == leap


def test_month_lengths() -> None:
    lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    for month, days in enumerate(lengths, 1):
        assert check("Date", f"2026-{month:02}-{days:02}") is None
        assert check("Date", f"2026-{month:02}-{days + 1:02}") is not None


# The std/time types of test-suite/schema/builtins.schema.haus.
SUITE_TYPES = {"Day": "Date", "At": "Instant", "Span": "Duration"}


def suite_time_cases() -> list[tuple[str, str, bool]]:
    """The cases of builtins.cases.haus with a std/time type whose input is the
    type's tag around one string: the ones the profile decides."""
    out: list[tuple[str, str, bool]] = []
    for case in haus.parse_all((SUITE / "schema" / "builtins.cases.haus").read_text("utf-8")):
        assert isinstance(case, Variant)
        match case:
            case Variant(outcome, (Record({"type": String(t), "input": Variant(tag, (String(text),))}),)) if (
                SUITE_TYPES.get(t) == tag
            ):
                out.append((tag, text, outcome == "Ok"))
            case _:
                pass
    return out


SUITE_CASES = suite_time_cases()


def test_suite_has_time_cases() -> None:
    assert len(SUITE_CASES) >= 10


@pytest.mark.parametrize(("type_name", "text", "ok"), SUITE_CASES)
def test_suite(type_name: str, text: str, ok: bool) -> None:
    assert (check(type_name, text) is None) == ok
