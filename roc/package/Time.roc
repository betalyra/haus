## std/time (spec §13.2): which strings each type accepts, the profile of
## spec/std/time.md. The same rules as the TypeScript and Rust bindings.
##
## Each type reads its whole shape first, then checks the values: a string
## with the wrong shape says how to write it, whatever its values.
Time := [].{
	## Whether `text` is a valid value of the std/time type `name`, and if not, why.
	check : Str, Str -> Try({}, Str)
	check = |name, text| {
		s = text.to_utf8()
		result = match name {
			"Date" => date(s)
			"Time" => time(s)
			"DateTime" => date_time(s)
			"Instant" => instant(s)
			"ZonedDateTime" => zoned_date_time(s)
			"Duration" => duration(s)
			"YearMonth" => year_month(s)
			"TimeZone" => zone(s)
			_ => return Err("${name} is not a std/time type")
		}
		match result {
			Ok({}) => Ok({})
			Err(Shape) => Err("\"${text}\" is not a ${name}; write it like ${example(name)}")
			Err(Invalid(reason)) => Err("\"${text}\" is not a valid ${name}: ${reason}")
		}
	}

	## The std/time types.
	types : List(Str)
	types = ["Date", "Time", "DateTime", "Instant", "ZonedDateTime", "Duration", "YearMonth", "TimeZone"]
}

Check : Try({}, [Shape, Invalid(Str)])

example : Str -> Str
example = |name| match name {
	"Date" => "2026-11-09"
	"Time" => "14:30:00"
	"DateTime" => "2026-11-09T14:30:00"
	"Instant" => "2026-11-09T14:30:00Z"
	"ZonedDateTime" => "2026-11-09T14:30:00+01:00[Europe/Lisbon]"
	"Duration" => "PT1H30M"
	"YearMonth" => "2026-11"
	_ => "Europe/Lisbon"
}

invalid : Str -> Check
invalid = |reason| Err(Invalid(reason))

# ── the types ────────────────────────────────────────────────

date : List(U8) -> Check
date = |s| {
	if s.len() != 10 or !ymd_shape(s, 0) {
		return Err(Shape)
	}
	ymd(s, 0)
}

time : List(U8) -> Check
time = |s| {
	end = hms_end(s, 0)?
	if end != s.len() {
		return Err(Shape)
	}
	hms(s, 0)
}

date_time : List(U8) -> Check
date_time = |s| {
	if !ymd_shape(s, 0) or at(s, 10) != 'T' {
		return Err(Shape)
	}
	end = hms_end(s, 11)?
	if end != s.len() {
		return Err(Shape)
	}
	ymd(s, 0)?
	hms(s, 11)
}

instant : List(U8) -> Check
instant = |s| {
	if !ymd_shape(s, 0) or at(s, 10) != 'T' {
		return Err(Shape)
	}
	time_end = hms_end(s, 11)?
	end = offset_end(s, time_end)?
	if end != s.len() {
		return Err(Shape)
	}
	ymd(s, 0)?
	hms(s, 11)?
	offset(s, time_end, end)
}

zoned_date_time : List(U8) -> Check
zoned_date_time = |s| {
	if !ymd_shape(s, 0) or at(s, 10) != 'T' {
		return Err(Shape)
	}
	time_end = hms_end(s, 11)?
	offset_stop = offset_end(s, time_end)?
	if at(s, offset_stop) != '[' {
		return Err(Shape)
	}
	var $z = offset_stop + 1
	while $z < s.len() and at(s, $z) != ']' {
		$z = $z + 1
	}
	if $z + 1 != s.len() {
		return Err(Shape)
	}
	ymd(s, 0)?
	hms(s, 11)?
	offset(s, time_end, offset_stop)?
	zone(s.sublist({ start: offset_stop + 1, len: $z - offset_stop - 1 }))
}

year_month : List(U8) -> Check
year_month = |s| {
	if s.len() != 7 or !digits(s, 0, 4) or at(s, 4) != '-' or !digits(s, 5, 2) {
		return Err(Shape)
	}
	month = num(s, 5, 2)
	if month < 1 or month > 12 {
		invalid("month ${text(s, 5, 2)} doesn't exist")
	} else {
		Ok({})
	}
}

## `-?P[nY][nM][nW][nD][T[nH][nM][n[.f]S]]`.
duration : List(U8) -> Check
duration = |s| {
	start = if (at(s, 0) == '-') 1 else 0
	if at(s, start) != 'P' {
		return Err(Shape)
	}
	var $p = start + 1
	# Years, months, weeks, days, hours, minutes, seconds: the digits, or "".
	var $values = []
	for unit in ['Y', 'M', 'W', 'D'] {
		(value, next) = component(s, $p, unit, False)?
		$values = $values.append(value)
		$p = next
	}
	has_time = at(s, $p) == 'T'
	if has_time {
		$p = $p + 1
	}
	ends_with_t = has_time and $p == s.len()
	# Whether the seconds are there and zero, fraction included.
	var $zero_seconds = False
	for unit in ['H', 'M', 'S'] {
		(value, next) = if (has_time) component(s, $p, unit, unit == 'S')? else ("", $p)
		if unit == 'S' and value != "" {
			$zero_seconds = s.sublist({ start: $p, len: next - 1 - $p }).all(|b| b == '0' or b == '.')
		}
		$values = $values.append(value)
		$p = next
	}
	if $p != s.len() {
		return Err(Shape)
	}
	if $values.all(|v| v == "") {
		return invalid("a duration needs at least one component, like PT0S")
	}
	if ends_with_t {
		return invalid("T must be followed by hours, minutes or seconds")
	}
	for v in $values {
		if v.to_utf8().len() > 1 and v.starts_with("0") {
			return invalid("${v} has a leading zero")
		}
	}
	others = $values.sublist({ start: 0, len: 6 })
	if others.any(|v| v == "0") or ($zero_seconds and others.any(|v| v != "")) {
		return invalid("a duration leaves out components that are zero (zero is PT0S)")
	}
	if start == 1 and !s.any(|b| b >= '1' and b <= '9') {
		return invalid("a zero duration has no sign")
	}
	for v in $values.sublist({ start: 0, len: 3 }) {
		if component_value(v) >= 4294967296 {
			return invalid("${v} is too large (years, months and weeks stay below 2^32)")
		}
	}
	seconds = component_value(get($values, 3)) * 86400 + component_value(get($values, 4)) * 3600 + component_value(get($values, 5)) * 60 + component_value(get($values, 6))
	if seconds >= 9007199254740992 {
		invalid("days and time together must stay below 2^53 seconds")
	} else {
		Ok({})
	}
}

## The value of a component's digits (0 for ""), exactly. It stops growing
## at 10^24, which is above every bound, so any number of digits fits.
component_value : Str -> U128
component_value = |v| {
	var $n = 0
	for b in v.to_utf8() {
		if $n < 1000000000000000000000000 {
			$n = $n * 10 + (b - '0').to_u128()
		}
	}
	$n
}

## A duration component at `p`: its digits and the position after its unit
## letter, if the next one is that unit; ("", p) otherwise.
component : List(U8), U64, U8, Bool -> Try((Str, U64), [Shape, Invalid(Str)])
component = |s, p, unit, fraction| {
	end = run_end(s, p)
	if end == p {
		return Ok(("", p))
	}
	after =
		if fraction and at(s, end) == '.' {
			frac_end = run_end(s, end + 1)
			if frac_end - (end + 1) < 1 or frac_end - (end + 1) > 9 {
				return Err(Shape)
			}
			frac_end
		} else {
			end
		}
	if at(s, after) == unit {
		Ok((text(s, p, end - p), after + 1))
	} else {
		Ok(("", p))
	}
}

# ── values ───────────────────────────────────────────────────

ymd_shape : List(U8), U64 -> Bool
ymd_shape = |s, i| digits(s, i, 4) and at(s, i + 4) == '-' and digits(s, i + 5, 2) and at(s, i + 7) == '-' and digits(s, i + 8, 2)

ymd : List(U8), U64 -> Check
ymd = |s, i| {
	(year, month, day) = (num(s, i, 4), num(s, i + 5, 2), num(s, i + 8, 2))
	(y, m, d) = (text(s, i, 4), text(s, i + 5, 2), text(s, i + 8, 2))
	if month < 1 or month > 12 {
		return invalid("month ${m} doesn't exist")
	}
	leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
	max =
		if month == 2 {
			if (leap) 29 else 28
		} else if month == 4 or month == 6 or month == 9 or month == 11 {
			30
		} else {
			31
		}
	if day >= 1 and day <= max {
		Ok({})
	} else if month == 2 and day == 29 {
		invalid("${y}-${m} has no day ${d} (${y} is not a leap year)")
	} else {
		invalid("${y}-${m} has no day ${d}")
	}
}

## Where `hh:mm:ss[.f]` at `i` ends.
hms_end : List(U8), U64 -> Try(U64, [Shape, Invalid(Str)])
hms_end = |s, i| {
	if !digits(s, i, 2) or at(s, i + 2) != ':' or !digits(s, i + 3, 2) or at(s, i + 5) != ':' or !digits(s, i + 6, 2) {
		return Err(Shape)
	}
	if at(s, i + 8) != '.' {
		return Ok(i + 8)
	}
	end = run_end(s, i + 9)
	if end - (i + 9) < 1 or end - (i + 9) > 9 {
		Err(Shape)
	} else {
		Ok(end)
	}
}

hms : List(U8), U64 -> Check
hms = |s, i| {
	(h, m, sec) = (text(s, i, 2), text(s, i + 3, 2), text(s, i + 6, 2))
	if num(s, i, 2) == 24 {
		invalid("24:00 is not allowed; write 00:00 of the next day")
	} else if num(s, i, 2) > 23 {
		invalid("hour ${h} doesn't exist")
	} else if num(s, i + 3, 2) > 59 {
		invalid("minute ${m} doesn't exist")
	} else if num(s, i + 6, 2) == 60 {
		invalid("leap seconds (:60) are not allowed")
	} else if num(s, i + 6, 2) > 59 {
		invalid("second ${sec} doesn't exist")
	} else {
		Ok({})
	}
}

## Where an offset (`Z` or `±hh:mm`) at `i` ends.
offset_end : List(U8), U64 -> Try(U64, [Shape, Invalid(Str)])
offset_end = |s, i| {
	c = at(s, i)
	if c == 'Z' {
		Ok(i + 1)
	} else if (c == '+' or c == '-') and digits(s, i + 1, 2) and at(s, i + 3) == ':' and digits(s, i + 4, 2) {
		Ok(i + 6)
	} else {
		Err(Shape)
	}
}

## The offset from `i` to `end`: up to ±23:59, and never `-00:00`.
offset : List(U8), U64, U64 -> Check
offset = |s, i, end| {
	o = text(s, i, end - i)
	if o == "Z" {
		Ok({})
	} else if o == "-00:00" {
		invalid("-00:00 is not allowed; write Z")
	} else if num(s, i + 1, 2) > 23 or num(s, i + 4, 2) > 59 {
		invalid("offset ${o} is out of range (±23:59 at most)")
	} else {
		Ok({})
	}
}

## An IANA zone name by its syntax (not looked up), or an offset.
zone : List(U8) -> Check
zone = |s| {
	if s.len() == 6 and (at(s, 0) == '+' or at(s, 0) == '-') and offset_end(s, 0) == Ok(6) {
		return offset(s, 0, 6)
	}
	z = text(s, 0, s.len())
	bad = invalid("\"${z}\" is not an IANA zone name (like Europe/Lisbon) or an offset (like +01:00)")
	first = at(s, 0)
	if s.len() > 255 or !((first >= 'a' and first <= 'z') or (first >= 'A' and first <= 'Z')) {
		return bad
	}
	# Parts between '/': not empty, not '.' or '..', letters, digits and ._+-
	var $part = []
	for c in s.append('/') {
		if c == '/' {
			if $part.is_empty() or $part == ['.'] or $part == ['.', '.'] {
				return bad
			}
			$part = []
		} else if is_digit(c) or (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or c == '.' or c == '_' or c == '+' or c == '-' {
			$part = $part.append(c)
		} else {
			return bad
		}
	}
	Ok({})
}

# ── helpers ──────────────────────────────────────────────────

at : List(U8), U64 -> U8
at = |s, i| match s.get(i) {
	Ok(b) => b
	Err(_) => 0
}

get : List(Str), U64 -> Str
get = |list, i| match list.get(i) {
	Ok(v) => v
	Err(_) => ""
}

is_digit = |b| b >= '0' and b <= '9'

## Exactly `n` digits at `i`.
digits : List(U8), U64, U64 -> Bool
digits = |s, i, n| i + n <= s.len() and s.sublist({ start: i, len: n }).all(is_digit)

## Where a run of digits starting at `i` ends.
run_end : List(U8), U64 -> U64
run_end = |s, i| {
	var $p = i
	while is_digit(at(s, $p)) {
		$p = $p + 1
	}
	$p
}

## The number in `n` digits at `i`.
num : List(U8), U64, U64 -> U64
num = |s, i, n| {
	var $v = 0
	for b in s.sublist({ start: i, len: n }) {
		$v = $v * 10 + (b - '0').to_u64()
	}
	$v
}

text : List(U8), U64, U64 -> Str
text = |s, i, n| match Str.from_utf8(s.sublist({ start: i, len: n })) {
	Ok(t) => t
	Err(_) => ""
}
