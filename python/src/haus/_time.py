"""The std/time profile (spec/std/time.md, spec §13.2): which strings each
std/time type accepts. A strict subset of RFC 3339 / RFC 9557 and ISO 8601
durations, the same in every binding:

    Date           2026-11-09                    the day must exist (Gregorian)
    Time           14:30:00, 14:30:00.250        seconds required, 1-9 fraction digits
    DateTime       2026-11-09T14:30:00           no offset
    Instant        2026-11-09T14:30:00Z          offset Z or ±hh:mm (not -00:00)
    ZonedDateTime  …+01:00[Europe/Lisbon]        offset and one zone; the zone is not looked up
    Duration       P1Y2M3W4DT5H6M7.5S, -PT30M    fraction only on seconds; no zero components (zero is PT0S)
    YearMonth      2026-11
    TimeZone       Europe/Lisbon, +01:00         IANA name syntax or an offset

Nothing here depends on a registry: whether a zone exists, or whether an
offset matches its zone at that time, is up to the application.

    >>> check("Date", "2024-02-29") is None
    True
    >>> check("Date", "2026-02-29")
    '"2026-02-29" is not a valid Date: 2026-02 has no day 29 (2026 is not a leap year)'
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable

STD_TIME_TYPES: tuple[str, ...] = (
    "Date",
    "Time",
    "DateTime",
    "Instant",
    "ZonedDateTime",
    "Duration",
    "YearMonth",
    "TimeZone",
)

# Digits are spelled [0-9]: `\d` would also match other scripts' digits.
_DATE = r"([0-9]{4})-([0-9]{2})-([0-9]{2})"
_TIME = r"([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,9})?"
_OFFSET = r"(Z|[+-][0-9]{2}:[0-9]{2})"
_DURATION = (
    r"-?P(?:([0-9]+)Y)?(?:([0-9]+)M)?(?:([0-9]+)W)?(?:([0-9]+)D)?"
    r"(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)(?:\.([0-9]{1,9}))?S)?)?"
)
_NUM_OFFSET = re.compile(r"[+-][0-9]{2}:[0-9]{2}")
_ZONE_PART = re.compile(r"[A-Za-z0-9._+-]+")
_LETTER = re.compile(r"[A-Za-z]")
_NONZERO = re.compile(r"[1-9]")


def _is_leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def _days_in(year: int, month: int) -> int:
    if month == 2:
        return 29 if _is_leap(year) else 28
    return 30 if month in (4, 6, 9, 11) else 31


def _date(y: str, m: str, d: str) -> str | None:
    month, day = int(m), int(d)
    if not 1 <= month <= 12:
        return f"month {m} doesn't exist"
    if not 1 <= day <= _days_in(int(y), month):
        leap = f" ({y} is not a leap year)" if month == 2 and day == 29 else ""
        return f"{y}-{m} has no day {d}{leap}"
    return None


def _time(h: str, m: str, s: str) -> str | None:
    if int(h) > 23:
        return "24:00 is not allowed; write 00:00 of the next day" if h == "24" else f"hour {h} doesn't exist"
    if int(m) > 59:
        return f"minute {m} doesn't exist"
    if s == "60":
        return "leap seconds (:60) are not allowed"
    if int(s) > 59:
        return f"second {s} doesn't exist"
    return None


def _offset(o: str) -> str | None:
    """`Z` or `±hh:mm`, up to ±23:59, and never `-00:00`."""
    if o == "Z":
        return None
    if o == "-00:00":
        return "-00:00 is not allowed; write Z"
    if int(o[1:3]) > 23 or int(o[4:6]) > 59:
        return f"offset {o} is out of range (±23:59 at most)"
    return None


def _zone(z: str) -> str | None:
    """An IANA zone name by its syntax (never looked up), or an offset."""
    if _NUM_OFFSET.fullmatch(z):
        return _offset(z)
    parts = z.split("/")
    if len(z) <= 255 and _LETTER.match(z) and all(p not in (".", "..") and _ZONE_PART.fullmatch(p) for p in parts):
        return None
    return (
        f"{json.dumps(z, ensure_ascii=False)} is not an IANA zone name (like Europe/Lisbon) or an offset (like +01:00)"
    )


def _first(*checks: Callable[[], str | None]) -> str | None:
    return next((r for c in checks if (r := c()) is not None), None)


# Above these lengths (and without leading zeros) a component is past every bound:
# 2^32 has 10 digits, 2^53 has 16. Checking the length first keeps `int` away from
# numbers with thousands of digits.
_MAX_DIGITS = 20


def _value(digits: str) -> int:
    return int(digits) if len(digits) <= _MAX_DIGITS else 10**_MAX_DIGITS


def _duration(m: re.Match[str]) -> str | None:
    text = m[0]
    y, mo, w, d, h, mi, s, f = m.groups()
    components = (y, mo, w, d, h, mi, s)
    if all(x is None for x in components):
        return "a duration needs at least one component, like PT0S"
    if text.endswith("T"):
        return "T must be followed by hours, minutes or seconds"
    padded = next((x for x in components if x is not None and len(x) > 1 and x.startswith("0")), None)
    if padded is not None:
        return f"{padded} has a leading zero"
    others = [x for x in (y, mo, w, d, h, mi) if x is not None]
    zero_seconds = s == "0" and not _NONZERO.search(f or "")
    if "0" in others or (zero_seconds and others):
        return "a duration leaves out components that are zero (zero is PT0S)"
    if text.startswith("-") and not _NONZERO.search(text):
        return "a zero duration has no sign"
    big = next((x for x in (y, mo, w) if x is not None and _value(x) >= 2**32), None)
    if big is not None:
        return f"{big} is too large (years, months and weeks stay below 2^32)"
    days, hours, minutes, seconds = (_value(x or "0") for x in (d, h, mi, s))
    if days * 86400 + hours * 3600 + minutes * 60 + seconds >= 2**53:
        return "days and time together must stay below 2^53 seconds"
    return None


_Shape = tuple[re.Pattern[str], str, Callable[[re.Match[str]], str | None]]

_SHAPES: dict[str, _Shape] = {
    "Date": (re.compile(_DATE), "2026-11-09", lambda m: _date(m[1], m[2], m[3])),
    "Time": (re.compile(_TIME), "14:30:00", lambda m: _time(m[1], m[2], m[3])),
    "DateTime": (
        re.compile(f"{_DATE}T{_TIME}"),
        "2026-11-09T14:30:00",
        lambda m: _first(lambda: _date(m[1], m[2], m[3]), lambda: _time(m[4], m[5], m[6])),
    ),
    "Instant": (
        re.compile(f"{_DATE}T{_TIME}{_OFFSET}"),
        "2026-11-09T14:30:00Z",
        lambda m: _first(
            lambda: _date(m[1], m[2], m[3]),
            lambda: _time(m[4], m[5], m[6]),
            lambda: _offset(m[7]),
        ),
    ),
    "ZonedDateTime": (
        re.compile(rf"{_DATE}T{_TIME}{_OFFSET}\[([^\]]*)\]"),
        "2026-11-09T14:30:00+01:00[Europe/Lisbon]",
        lambda m: _first(
            lambda: _date(m[1], m[2], m[3]),
            lambda: _time(m[4], m[5], m[6]),
            lambda: _offset(m[7]),
            lambda: _zone(m[8]),
        ),
    ),
    "Duration": (re.compile(_DURATION), "PT1H30M", _duration),
    "YearMonth": (
        re.compile(r"([0-9]{4})-([0-9]{2})"),
        "2026-11",
        lambda m: None if 1 <= int(m[2]) <= 12 else f"month {m[2]} doesn't exist",
    ),
    "TimeZone": (re.compile(r".*", re.DOTALL), "Europe/Lisbon", lambda m: _zone(m[0])),
}


def check(type_name: str, text: str) -> str | None:
    """Why `text` is not a valid value of the std/time type `type_name`, or None if it is.

    >>> check("Duration", "PT1H30M") is None
    True
    >>> check("Duration", "P0D")
    '"P0D" is not a valid Duration: a duration leaves out components that are zero (zero is PT0S)'
    >>> check("Instant", "2026-11-09 14:30:00Z")
    '"2026-11-09 14:30:00Z" is not a Instant; write it like 2026-11-09T14:30:00Z'
    """
    shape = _SHAPES.get(type_name)
    if shape is None:
        return f"{type_name} is not a std/time type"
    pattern, example, rules = shape
    shown = json.dumps(text, ensure_ascii=False)
    m = pattern.fullmatch(text)
    if m is None:
        return f"{shown} is not a {type_name}; write it like {example}"
    reason = rules(m)
    return None if reason is None else f"{shown} is not a valid {type_name}: {reason}"
