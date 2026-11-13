//! `std/time` (spec §13.2): the types and the profile of
//! [spec/std/time.md](../../spec/std/time.md), a port of std-time.ts.
//!
//! Each type keeps its text: validated, never converted. Codecs map them to
//! `jiff`, `chrono` or `time` types (spec §13.4).

use crate::de::{Decode, mismatch, variant};
use crate::ser::{self, Encode};
use crate::{DecodeError, Value};
use std::fmt;

macro_rules! types {
    ($($name:ident),* $(,)?) => {$(
        #[doc = concat!("`", stringify!($name), "(\"…\")`, validated by the std/time profile.")]
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(String);

        impl $name {
            pub const ID: &'static str = concat!("std/time#", stringify!($name));

            /// The value, if `text` follows the profile; otherwise why not.
            pub fn new(text: impl Into<String>) -> Result<Self, String> {
                let text = text.into();
                check(stringify!($name), &text).map(|()| $name(text))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl Decode for $name {
            fn decode(v: &Value) -> Result<Self, DecodeError> {
                const NAME: &str = stringify!($name);
                match variant(v, NAME)? {
                    (NAME, [Value::String(s)]) => $name::new(s.as_str()).map_err(|e| DecodeError::new(e).index(0).tag(NAME)),
                    (NAME, _) => Err(DecodeError::new(concat!("write ", stringify!($name), "(\"…\") with one string"))),
                    _ => Err(mismatch(NAME, v)),
                }
            }
        }

        impl Encode for $name {
            fn encode(&self) -> Value {
                ser::variant(stringify!($name), vec![Value::String(self.0.clone())])
            }
        }
    )*};
}

types!(Date, Time, DateTime, Instant, ZonedDateTime, Duration, YearMonth, TimeZone);

/// A std/time type: its name, an example for messages, and its check.
struct Kind {
    name: &'static str,
    example: &'static str,
    check: fn(&mut Cursor) -> Check,
}

const KINDS: [Kind; 8] = [
    Kind { name: "Date", example: "2026-11-09", check: date },
    Kind { name: "Time", example: "14:30:00", check: time },
    Kind { name: "DateTime", example: "2026-11-09T14:30:00", check: date_time },
    Kind { name: "Instant", example: "2026-11-09T14:30:00Z", check: instant },
    Kind { name: "ZonedDateTime", example: "2026-11-09T14:30:00+01:00[Europe/Lisbon]", check: zoned_date_time },
    Kind { name: "Duration", example: "PT1H30M", check: duration },
    Kind { name: "YearMonth", example: "2026-11", check: year_month },
    Kind { name: "TimeZone", example: "Europe/Lisbon", check: time_zone },
];

/// Whether `text` is a valid value of the std/time type `ty`, and if not, why.
pub fn check(ty: &str, text: &str) -> Result<(), String> {
    let Some(kind) = KINDS.iter().find(|k| k.name == ty) else {
        return Err(format!("{ty} is not a std/time type"));
    };
    (kind.check)(&mut Cursor { s: text.as_bytes(), i: 0 }).map_err(|invalid| match invalid {
        Invalid::Shape => format!("{text:?} is not a {ty}; write it like {}", kind.example),
        Invalid::Value(reason) => format!("{text:?} is not a valid {ty}: {reason}"),
    })
}

/// Why a string isn't a value of its type.
enum Invalid {
    /// Not the type's shape at all.
    Shape,
    /// The right shape, but no such value: why.
    Value(String),
}

type Check = Result<(), Invalid>;

fn invalid(reason: impl Into<String>) -> Check {
    Err(Invalid::Value(reason.into()))
}

// ── the types ────────────────────────────────────────────────
//
// Each one reads its whole shape first, then checks the values: a string
// with the wrong shape says how to write it, whatever its values.

fn date(c: &mut Cursor) -> Check {
    let d = c.date()?;
    c.finish()?;
    d.check()
}

fn time(c: &mut Cursor) -> Check {
    let t = c.time()?;
    c.finish()?;
    t.check()
}

fn date_time(c: &mut Cursor) -> Check {
    let d = c.date()?;
    c.lit(b'T')?;
    let t = c.time()?;
    c.finish()?;
    d.check()?;
    t.check()
}

fn instant(c: &mut Cursor) -> Check {
    let d = c.date()?;
    c.lit(b'T')?;
    let t = c.time()?;
    let o = c.offset()?;
    c.finish()?;
    d.check()?;
    t.check()?;
    offset(o)
}

fn zoned_date_time(c: &mut Cursor) -> Check {
    let d = c.date()?;
    c.lit(b'T')?;
    let t = c.time()?;
    let o = c.offset()?;
    c.lit(b'[')?;
    let z = c.until(b']');
    c.lit(b']')?;
    c.finish()?;
    d.check()?;
    t.check()?;
    offset(o)?;
    zone(z)
}

fn year_month(c: &mut Cursor) -> Check {
    c.digits(4)?;
    c.lit(b'-')?;
    let m = c.digits(2)?;
    c.finish()?;
    if (1..=12).contains(&num(m)) { Ok(()) } else { invalid(format!("month {m} doesn't exist")) }
}

fn time_zone(c: &mut Cursor) -> Check {
    zone(c.rest())
}

/// `-?P[nY][nM][nW][nD][T[nH][nM][n[.f]S]]`.
fn duration(c: &mut Cursor) -> Check {
    let negative = c.opt(b'-');
    c.lit(b'P')?;
    let date = b"YMWD".map(|unit| c.component(unit, false));
    let has_time = c.opt(b'T');
    let ends_with_t = has_time && c.at_end();
    let time = b"HMS".map(|unit| if has_time { c.component(unit, unit == b'S') } else { Ok(None) });
    // Years, months, weeks, days, hours, minutes, seconds (with their fraction).
    let texts = date.into_iter().chain(time).collect::<Result<Vec<_>, _>>()?;
    c.finish()?;
    let values: Vec<_> = texts.iter().map(|t| t.map(|x| x.split_once('.').map_or(x, |(n, _)| n))).collect();
    if values.iter().all(Option::is_none) {
        return invalid("a duration needs at least one component, like PT0S");
    }
    if ends_with_t {
        return invalid("T must be followed by hours, minutes or seconds");
    }
    if let Some(x) = values.iter().flatten().find(|x| x.len() > 1 && x.starts_with('0')) {
        return invalid(format!("{x} has a leading zero"));
    }
    let zero = |x: &&str| x.bytes().all(|b| b == b'0' || b == b'.');
    let others = || texts[..6].iter().flatten();
    if others().any(zero) || (texts[6].as_ref().is_some_and(zero) && others().next().is_some()) {
        return invalid("a duration leaves out components that are zero (zero is PT0S)");
    }
    if negative && !c.s.iter().any(|b| (b'1'..=b'9').contains(b)) {
        return invalid("a zero duration has no sign");
    }
    let number = |v: &str| v.parse::<f64>().unwrap_or(f64::INFINITY);
    if let Some(x) = values[..3].iter().flatten().find(|x| number(x) >= 2f64.powi(32)) {
        return invalid(format!("{x} is too large (years, months and weeks stay below 2^32)"));
    }
    let [d, h, m, s] = [3, 4, 5, 6].map(|i| values[i].map_or(0.0, number));
    if d * 86400.0 + h * 3600.0 + m * 60.0 + s >= 2f64.powi(53) {
        return invalid("days and time together must stay below 2^53 seconds");
    }
    Ok(())
}

// ── values ───────────────────────────────────────────────────

struct Ymd<'a>(&'a str, &'a str, &'a str);
struct Hms<'a>(&'a str, &'a str, &'a str);

fn num(s: &str) -> u64 {
    s.parse().unwrap_or(u64::MAX)
}

impl Ymd<'_> {
    fn check(&self) -> Check {
        let Ymd(y, m, d) = *self;
        let (year, month, day) = (num(y), num(m), num(d));
        if !(1..=12).contains(&month) {
            return invalid(format!("month {m} doesn't exist"));
        }
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        let max = match month {
            2 if leap => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        };
        match day {
            1.. if day <= max => Ok(()),
            _ if month == 2 && day == 29 => invalid(format!("{y}-{m} has no day {d} ({y} is not a leap year)")),
            _ => invalid(format!("{y}-{m} has no day {d}")),
        }
    }
}

impl Hms<'_> {
    fn check(&self) -> Check {
        let Hms(h, m, s) = *self;
        match (num(h), num(m), num(s)) {
            (24, ..) => invalid("24:00 is not allowed; write 00:00 of the next day"),
            (24.., ..) => invalid(format!("hour {h} doesn't exist")),
            (_, 60.., _) => invalid(format!("minute {m} doesn't exist")),
            (.., 60) => invalid("leap seconds (:60) are not allowed"),
            (.., 61..) => invalid(format!("second {s} doesn't exist")),
            _ => Ok(()),
        }
    }
}

/// `Z` or `±hh:mm`, up to ±23:59, and never `-00:00`.
fn offset(o: &str) -> Check {
    match o {
        "Z" => Ok(()),
        "-00:00" => invalid("-00:00 is not allowed; write Z"),
        _ if num(&o[1..3]) > 23 || num(&o[4..6]) > 59 => {
            invalid(format!("offset {o} is out of range (±23:59 at most)"))
        }
        _ => Ok(()),
    }
}

/// An IANA zone name by its syntax (not looked up), or an offset.
fn zone(z: &str) -> Check {
    let mut c = Cursor { s: z.as_bytes(), i: 0 };
    if let Ok(o) = c.offset()
        && c.at_end()
    {
        return offset(o);
    }
    let part = |p: &str| {
        !p.is_empty() && p != "." && p != ".." && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b))
    };
    if z.len() <= 255 && z.starts_with(|c: char| c.is_ascii_alphabetic()) && z.split('/').all(part) {
        Ok(())
    } else {
        invalid(format!("{z:?} is not an IANA zone name (like Europe/Lisbon) or an offset (like +01:00)"))
    }
}

// ── reading ──────────────────────────────────────────────────

struct Cursor<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Cursor<'a> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn at_end(&self) -> bool {
        self.i == self.s.len()
    }

    fn finish(&self) -> Check {
        if self.at_end() { Ok(()) } else { Err(Invalid::Shape) }
    }

    fn text(&self, from: usize) -> &'a str {
        std::str::from_utf8(&self.s[from..self.i]).unwrap_or_default()
    }

    /// The byte `c`.
    fn lit(&mut self, c: u8) -> Check {
        if self.opt(c) { Ok(()) } else { Err(Invalid::Shape) }
    }

    /// The byte `c`, if it's next.
    fn opt(&mut self, c: u8) -> bool {
        let next = self.peek() == Some(c);
        self.i += usize::from(next);
        next
    }

    /// Exactly `n` digits.
    fn digits(&mut self, n: usize) -> Result<&'a str, Invalid> {
        match self.s.get(self.i..self.i + n) {
            Some(d) if d.iter().all(u8::is_ascii_digit) => {
                self.i += n;
                Ok(self.text(self.i - n))
            }
            _ => Err(Invalid::Shape),
        }
    }

    /// One or more digits, or None.
    fn run(&mut self) -> Option<&'a str> {
        let n = self.s[self.i..].iter().take_while(|c| c.is_ascii_digit()).count();
        (n > 0).then(|| self.digits(n).ok()).flatten()
    }

    /// Everything up to the byte `c` (or the end).
    fn until(&mut self, c: u8) -> &'a str {
        let start = self.i;
        self.i += self.s[start..].iter().take_while(|&&b| b != c).count();
        self.text(start)
    }

    /// Everything that's left.
    fn rest(&mut self) -> &'a str {
        let start = self.i;
        self.i = self.s.len();
        self.text(start)
    }

    /// A fraction of 1–9 digits after a `.`, if there is a `.`.
    fn fraction(&mut self) -> Check {
        if self.opt(b'.') && !self.run().is_some_and(|f| (1..=9).contains(&f.len())) {
            return Err(Invalid::Shape);
        }
        Ok(())
    }

    fn date(&mut self) -> Result<Ymd<'a>, Invalid> {
        let y = self.digits(4)?;
        self.lit(b'-')?;
        let m = self.digits(2)?;
        self.lit(b'-')?;
        Ok(Ymd(y, m, self.digits(2)?))
    }

    /// `hh:mm:ss`, then an optional fraction.
    fn time(&mut self) -> Result<Hms<'a>, Invalid> {
        let h = self.digits(2)?;
        self.lit(b':')?;
        let m = self.digits(2)?;
        self.lit(b':')?;
        let s = self.digits(2)?;
        self.fraction()?;
        Ok(Hms(h, m, s))
    }

    /// `Z` or `±hh:mm`.
    fn offset(&mut self) -> Result<&'a str, Invalid> {
        let start = self.i;
        match self.peek() {
            Some(b'Z') => self.i += 1,
            Some(b'+' | b'-') => {
                self.i += 1;
                self.digits(2)?;
                self.lit(b':')?;
                self.digits(2)?;
            }
            _ => return Err(Invalid::Shape),
        }
        Ok(self.text(start))
    }

    /// A duration component: digits (and a fraction, if allowed) and its unit
    /// letter, if the next one is that unit (otherwise nothing is read).
    fn component(&mut self, unit: u8, fraction: bool) -> Result<Option<&'a str>, Invalid> {
        let start = self.i;
        if self.run().is_none() {
            return Ok(None);
        }
        if fraction {
            self.fraction()?;
        }
        let n = self.text(start);
        if self.opt(unit) {
            Ok(Some(n))
        } else {
            self.i = start;
            Ok(None)
        }
    }
}
