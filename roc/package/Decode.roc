## Building blocks for decoding a haus `Value` into your own Roc types.
##
## A decoder is a function `Value -> Try(a, Decode.Error)`. Errors carry a
## path that is built on the way out (`[1].amount.currency`), so decoders
## don't need to know where they are.
##
## Decoders are plain functions, so recursion (a tree decoder calling itself
## for the children) is just a recursive function, bounded by the parser's
## depth limit. Keep each decoder to one pass: pick the case by the tag and
## never try one decoder after another on the same value, which would grow
## exponentially with the nesting depth (spec §9.8).
##
##     user_created : Value -> Try({ id : U64, email : Str }, Decode.Error)
##     user_created = |v| {
##         fields = Decode.record(v)?
##         Ok({ id: Decode.field(fields, "id", Decode.u64)?, email: Decode.field(fields, "email", Decode.str)? })
##     }
import Int
import Value
import Time

Decode := [].{
	# ── documents ───────────────────────────────────────────

	## Parse a whole file and decode every top-level value (a stream).
	all : Str, (Value -> Try(a, Error)) -> Try(List(a), [Syntax(Value.ParseError), Decode(Error)])
	all = |text, decoder| {
		values = Value.parse_all(text).map_err(|e| Syntax(e))?
		var $out = []
		var $i = 0.U64
		for v in values {
			$out = $out.append(at(decoder(v), "[${$i.to_str()}]").map_err(|e| Decode(e))?)
			$i = $i + 1
		}
		Ok($out)
	}

	## Parse a text holding exactly one value and decode it.
	one : Str, (Value -> Try(a, Error)) -> Try(a, [Syntax(Value.ParseError), Decode(Error)])
	one = |text, decoder| {
		v = Value.parse(text).map_err(|e| Syntax(e))?
		decoder(v).map_err(|e| Decode(e))
	}

	## Item `i` of a stream, already parsed: errors say which (`[3].total`).
	item : Value, U64, (Value -> Try(a, Error)) -> Try(a, Error)
	item = |v, i, decoder| at(decoder(v), "[${i.to_str()}]")

	# ── scalars ─────────────────────────────────────────────

	str : Value -> Try(Str, Error)
	str = |v| match v {
		Text(s) => Ok(s)
		_ => expected("String", v)
	}

	## A byte string: `x"9f86d081"`.
	bytes : Value -> Try(List(U8), Error)
	bytes = |v| match v {
		Bytes(b) => Ok(b)
		_ => expected("Bytes", v)
	}

	## `Int`: an integer of any size, kept as its digits (see `Int`).
	int : Value -> Try(Int, Error)
	int = |v| match v {
		Num(text) => Int.from_str(text).map_err(|_| { reason: "expected a whole number (Int), found ${text}", path: "" })
		_ => expected("a number (Int)", v)
	}

	i8 : Value -> Try(I8, Error)
	i8 = |v| whole(v, "Int8", "-128", "127", I8.from_str)

	i16 : Value -> Try(I16, Error)
	i16 = |v| whole(v, "Int16", "-32768", "32767", I16.from_str)

	i32 : Value -> Try(I32, Error)
	i32 = |v| whole(v, "Int32", "-2147483648", "2147483647", I32.from_str)

	i64 : Value -> Try(I64, Error)
	i64 = |v| whole(v, "Int64", "-9223372036854775808", "9223372036854775807", I64.from_str)

	u8 : Value -> Try(U8, Error)
	u8 = |v| whole(v, "UInt8", "0", "255", U8.from_str)

	u16 : Value -> Try(U16, Error)
	u16 = |v| whole(v, "UInt16", "0", "65535", U16.from_str)

	u32 : Value -> Try(U32, Error)
	u32 = |v| whole(v, "UInt32", "0", "4294967295", U32.from_str)

	u64 : Value -> Try(U64, Error)
	u64 = |v| whole(v, "UInt64", "0", "18446744073709551615", U64.from_str)

	## `Float64`: any number, rounded to the nearest binary64 value (spec §15),
	## and the tags `NaN`, `Infinity`, `NegInfinity`. A number too large for
	## a Float64 is an error, not an infinity.
	f64 : Value -> Try(F64, Error)
	f64 = |v| match v {
		Num(text) => F64.from_str(text).map_err(|_| { reason: "${text} is too large for Float64", path: "" })
		Tag("NaN", []) => Ok(0.0 / 0.0)
		Tag("Infinity", []) => Ok(1.0 / 0.0)
		Tag("NegInfinity", []) => Ok(-1.0 / 0.0)
		_ => expected("a number (Float64)", v)
	}

	## `Float32`: any number, rounded directly from its exact decimal value to
	## the nearest binary32 value (never through a binary64), and the tags
	## `NaN`, `Infinity`, `NegInfinity`. Too large for a Float32 is an error.
	f32 : Value -> Try(F32, Error)
	f32 = |v| match v {
		Num(text) => F32.from_str(text).map_err(|_| { reason: "${text} is too large for Float32", path: "" })
		Tag("NaN", []) => Ok(0.0 / 0.0)
		Tag("Infinity", []) => Ok(1.0 / 0.0)
		Tag("NegInfinity", []) => Ok(-1.0 / 0.0)
		_ => expected("a number (Float32)", v)
	}

	## An exact decimal: any number, kept as its normalized literal, scale and
	## exponent included (`19.90` stays "19.90", `1.5e3` stays "1.5e3").
	decimal : Value -> Try(Str, Error)
	decimal = |v| match v {
		Num(text) => Ok(text)
		_ => expected("a number", v)
	}

	## `True` / `False`.
	bool : Value -> Try(Bool, Error)
	bool = |v| match v {
		Tag("True", []) => Ok(True)
		Tag("False", []) => Ok(False)
		_ => expected("True | False", v)
	}

	## A payload-less tag, returned as its name: `EUR` → "EUR".
	tag_name : Value -> Try(Str, Error)
	tag_name = |v| match v {
		Tag(name, []) => Ok(name)
		_ => expected("a tag without payload", v)
	}

	## A std/time value, checked by the std/time profile and returned as its
	## text: `Decode.time("Date")` reads `Date("2026-11-07")` as "2026-11-07".
	time : Str -> (Value -> Try(Str, Error))
	time = |name| |v| {
		text = tagged_string(name, v)?
		Time.check(name, text).map_err(|reason| { reason, path: "(${name})[0]" })?
		Ok(text)
	}

	## `Instant("2026-11-07T10:00:00Z")`, checked, as its text.
	instant : Value -> Try(Str, Error)
	instant = |v| time("Instant")(v)

	## `Date("2026-11-07")`, checked, as its text.
	date : Value -> Try(Str, Error)
	date = |v| time("Date")(v)

	## `< >`: a bare tag by its name, or any other variant as it was.
	any_tag : Value -> Try([Bare(Str), Other(Str, List(Value))], Error)
	any_tag = |v| match v {
		Tag(name, []) => Ok(Bare(name))
		Tag(name, args) => Ok(Other(name, args))
		_ => expected("a tag", v)
	}

	# ── containers ──────────────────────────────────────────

	## The fields of a record, or of a variant's record payload (`Circle { … }`).
	record : Value -> Try(List((Str, Value)), Error)
	record = |v| match v {
		Rec(fields) => Ok(fields)
		Tag(_, [Rec(fields)]) => Ok(fields)
		_ => expected("a record", v)
	}

	## The fields of a record, and only of a record: `User { … }` is a variant,
	## not a record (spec §15). Generated decoders use this one.
	strict_record : Value -> Try(List((Str, Value)), Error)
	strict_record = |v| match v {
		Rec(fs) => Ok(fs)
		_ => expected("a record", v)
	}

	## A required field.
	field : List((Str, Value)), Str, (Value -> Try(a, Error)) -> Try(a, Error)
	field = |fields, key, decoder| match fields.find_first(|(k, _)| k == key) {
		Ok((_, v)) => at(decoder(v), ".${key}")
		Err(_) => Err({ reason: "missing field '${key}'", path: "" })
	}

	## An optional field (`name?: T` in a schema): `Missing`, or `Present(value)`.
	## Missing is never `None`: for a `Maybe` value use `Decode.field(fs, key, |v| Decode.maybe(v, …))`,
	## and for a partial update that can also clear a value, both:
	## `Decode.optional_field(fs, "nickname", |v| Decode.maybe(v, Decode.str))`.
	optional_field : List((Str, Value)), Str, (Value -> Try(a, Error)) -> Try([Missing, Present(a)], Error)
	optional_field = |fields, key, decoder| match fields.find_first(|(k, _)| k == key) {
		Err(_) => Ok(Missing)
		Ok((_, v)) => Ok(Present(at(decoder(v), ".${key}")?))
	}

	## A `Maybe` value: `None` or `Some(x)`.
	maybe : Value, (Value -> Try(a, Error)) -> Try([None, Some(a)], Error)
	maybe = |v, decoder| match v {
		Tag("None", []) => Ok(None)
		Tag("Some", [inner]) => Ok(Some(at(decoder(inner), "[0]")?))
		_ => expected("None | Some(…)", v)
	}

	## A closed record has only the fields listed.
	closed : List((Str, Value)), List(Str) -> Try({}, Error)
	closed = |fields, known| match fields.find_first(|(k, _)| !known.contains(k)) {
		Ok((k, _)) => fail("unknown field '${k}' in a closed record")
		Err(_) => Ok({})
	}

	## `Map v`: a record used as a dictionary.
	map : Value, (Value -> Try(a, Error)) -> Try(List((Str, a)), Error)
	map = |v, decoder| match v {
		Rec(fields) => {
			var $out = []
			for (k, x) in fields {
				$out = $out.append((k, at(decoder(x), ".${k}")?))
			}
			Ok($out)
		}
		_ => expected("a record (Map)", v)
	}

	## `Result e a`: `Ok(a)` or `Err(e)`.
	result : Value, (Value -> Try(a, Error)), (Value -> Try(e, Error)) -> Try(Try(a, e), Error)
	result = |v, ok, err| match v {
		Tag("Ok", [x]) => Ok(Ok(at(ok(x), "(Ok)[0]")?))
		Tag("Err", [x]) => Ok(Err(at(err(x), "(Err)[0]")?))
		_ => expected("Ok(…) | Err(…)", v)
	}

	## Payload value `i` of `tag`.
	arg : Str, U64, Value, (Value -> Try(a, Error)) -> Try(a, Error)
	arg = |tag, i, v, decoder| at(decoder(v), "(${tag})[${i.to_str()}]")

	## The record payload of `Tag { … }`, with errors inside it under `(Tag)`.
	payload : Str, Value, (List((Str, Value)) -> Try(a, Error)) -> Try(a, Error)
	payload = |tag, v, decoder| at(
		match strict_record(v) {
			Ok(fields) => decoder(fields)
			Err(e) => Err(e)
		},
		"(${tag})",
	)

	## A type with a codec: its base decoder first, then the codec (spec §13.4).
	codec : Value, (Value -> Try(b, Error)), (b -> Try(t, Str)) -> Try(t, Error)
	codec = |v, base, decode| match base(v) {
		Ok(x) => decode(x).map_err(|reason| { reason, path: "" })
		Err(e) => Err(e)
	}

	## A tag with the wrong number of payload values.
	arity : Str, U64 -> Try(a, Error)
	arity = |tag, n| fail(if (n == 0) "${tag} takes no payload" else "${tag} takes ${n.to_str()} value(s)")

	## A tag a closed variant doesn't list.
	unknown_tag : Str, List(Str) -> Try(a, Error)
	unknown_tag = |tag, known| fail("unknown tag ${tag}; expected one of ${Str.join_with(known, ", ")}")

	## An array, decoding each item.
	list : Value, (Value -> Try(a, Error)) -> Try(List(a), Error)
	list = |v, decoder| match v {
		Arr(items) => {
			var $out = []
			var $i = 0.U64
			for x in items {
				$out = $out.append(at(decoder(x), "[${$i.to_str()}]")?)
				$i = $i + 1
			}
			Ok($out)
		}
		_ => expected("an array", v)
	}

	# ── errors ──────────────────────────────────────────────

	## `.total: 44.405 has more than 2 decimal places`, or just the reason at the root.
	message : Error -> Str
	message = |{ reason, path }| if (path == "") reason else "${path}: ${reason}"

	## Fail with a custom reason at the current position.
	fail : Str -> Try(a, Error)
	fail = |reason| Err({ reason, path: "" })

	## Fail with "expected …, found …".
	expected : Str, Value -> Try(a, Error)
	expected = |what, v| Err({ reason: "expected ${what}, found ${describe(v)}", path: "" })
}

## A whole number in range for `name`, converted with `from_str`.
whole : Value, Str, Str, Str, (Str -> Try(n, [BadNumStr])) -> Try(n, Error)
whole = |v, name, min, max, from_str| match v {
	Num(text) => {
		digits = if (text.starts_with("-")) text.drop_prefix("-") else text
		if digits.is_empty() or !digits.to_utf8().all(|b| b >= '0' and b <= '9') {
			return Decode.fail("expected a whole number (${name}), found ${text}")
		}
		# `-0` is 0, also for the unsigned types.
		from_str(if (text == "-0") "0" else text).map_err(|_| { reason: "${text} is out of range for ${name} (${min} to ${max})", path: "" })
	}
	_ => Decode.expected("a number (${name})", v)
}

## Where in the value (`.total(Money)[1]`, empty at the root), and what's wrong.
## The same paths as the Rust binding.
Error : { reason : Str, path : Str }

## Prefix the path of an error coming out of a nested decoder.
at : Try(a, Error), Str -> Try(a, Error)
at = |result, segment| result.map_err(|{ reason, path }| { reason, path: "${segment}${path}" })

tagged_string : Str, Value -> Try(Str, Error)
tagged_string = |name, v| match v {
	Tag(tag, [Text(s)]) if tag == name => Ok(s)
	_ => Decode.expected("${name}(\"…\")", v)
}

describe : Value -> Str
describe = |v| match v {
	Num(t) => "number ${t}"
	Text(_) => "a string"
	Bytes(_) => "bytes"
	Arr(_) => "an array"
	Rec(_) => "a record"
	Tag(name, _) => "variant ${name}"
}

# ── tests ────────────────────────────────────────────────────

Order : { id : U64, note : [Missing, Present(Str)], coupon : [None, Some(Str)], prices : List(Str), paid : Bool }

order : Value -> Try(Order, Error)
order = |v| {
	fs = Decode.record(v)?
	Ok({
		id: Decode.field(fs, "id", Decode.u64)?,
		note: Decode.optional_field(fs, "note", Decode.str)?,
		coupon: Decode.field(fs, "coupon", |c| Decode.maybe(c, Decode.str))?,
		prices: Decode.field(fs, "prices", |p| Decode.list(p, Decode.decimal))?,
		paid: Decode.field(fs, "paid", Decode.bool)?,
	})
}

expect Decode.one("{ id: 1, coupon: None, prices: [19.90], paid: True }", order) == Ok({ id: 1, note: Missing, coupon: None, prices: ["19.90"], paid: True })
expect Decode.one("{ id: 1, note: \"hi\", coupon: Some(\"X1\"), prices: [], paid: False }", order) == Ok({ id: 1, note: Present("hi"), coupon: Some("X1"), prices: [], paid: False })
# A Maybe must be written; an optional field is never None.
expect Decode.one("{ id: 1, prices: [], paid: True }", order) == Err(Decode({ reason: "missing field 'coupon'", path: "" }))
expect Decode.one("{ id: 1, note: None, coupon: None, prices: [], paid: True }", order) == Err(Decode({ reason: "expected String, found variant None", path: ".note" }))
expect Decode.one("{ id: 1, coupon: None, prices: [1, Two], paid: True }", order) == Err(Decode({ reason: "expected a number, found variant Two", path: ".prices[1]" }))
expect Decode.message({ reason: "missing field 'id'", path: "" }) == "missing field 'id'"
expect Decode.message({ reason: "expected a string", path: ".total" }) == ".total: expected a string"
expect Decode.one("300", Decode.u8) == Err(Decode({ reason: "300 is out of range for UInt8 (0 to 255)", path: "" }))
expect Decode.one("1.5", Decode.i64) == Err(Decode({ reason: "expected a whole number (Int64), found 1.5", path: "" }))
expect Decode.one("-12", Decode.int) == Ok(Int.from_i64(-12))
expect Decode.one("1.5", Decode.int) == Err(Decode({ reason: "expected a whole number (Int), found 1.5", path: "" }))
# Int has no size limit, and writes back unchanged (2^128 + 1).
expect Decode.one("340282366920938463463374607431768211457", Decode.int).map_ok(|n| n.to_str()) == Ok("340282366920938463463374607431768211457")
expect Decode.one("Date(\"2026-02-30\")", Decode.date) == Err(Decode({ reason: "\"2026-02-30\" is not a valid Date: 2026-02 has no day 30", path: "(Date)[0]" }))
expect Decode.one("{ id: 1, coupon: Some(1), prices: [], paid: True }", order) == Err(Decode({ reason: "expected String, found number 1", path: ".coupon[0]" }))
expect Decode.one("{ id: 1, coupon: None, prices: [], paid: Yes }", order) == Err(Decode({ reason: "expected True | False, found variant Yes", path: ".paid" }))
expect Decode.one("{ hash: x\"9f86 D0\" }", |v| Decode.field(Decode.record(v)?, "hash", Decode.bytes)) == Ok([0x9f, 0x86, 0xd0])
expect Decode.one("x\"\"", Decode.bytes) == Ok([])
expect Decode.one("x\"00\"", Decode.str) == Err(Decode({ reason: "expected String, found bytes", path: "" }))
expect Decode.one("\"00\"", Decode.bytes) == Err(Decode({ reason: "expected Bytes, found a string", path: "" }))
expect Decode.all("1, 2, x", Decode.u64) == Err(Syntax({ reason: "unexpected identifier 'x': lowercase identifiers can only be record keys", line: 1, column: 7 }))

# A partial update: `name?: String, nickname?: Maybe String`.
UserUpdate : { name : [Missing, Present(Str)], nickname : [Missing, Present([None, Some(Str)])] }

user_update : Value -> Try(UserUpdate, Error)
user_update = |v| {
	fs = Decode.record(v)?
	Ok({
		name: Decode.optional_field(fs, "name", Decode.str)?,
		nickname: Decode.optional_field(fs, "nickname", |n| Decode.maybe(n, Decode.str))?,
	})
}

expect Decode.one("{}", user_update) == Ok({ name: Missing, nickname: Missing })
expect Decode.one("{ name: \"Jan\", nickname: None }", user_update) == Ok({ name: Present("Jan"), nickname: Present(None) })
expect Decode.one("{ nickname: Some(\"J\") }", user_update) == Ok({ name: Missing, nickname: Present(Some("J")) })

# Floats are rounded to their type, and too large for it is an error (spec §15).
expect Decode.one("1.000000059604644775390625", Decode.f32) == Ok(1.0)
expect Decode.one("1e-400", Decode.f64) == Ok(0.0)
expect Decode.one("1e400", Decode.f64) == Err(Decode({ reason: "1e400 is too large for Float64", path: "" }))
expect Decode.one("3.4028236e38", Decode.f32) == Err(Decode({ reason: "3.4028236e38 is too large for Float32", path: "" }))
# `-0` is 0, also for the unsigned types.
expect Decode.one("-0", Decode.u8) == Ok(0)
expect Decode.one("-1", Decode.u8) == Err(Decode({ reason: "-1 is out of range for UInt8 (0 to 255)", path: "" }))
# A variant with a record payload is not a record.
expect Decode.one("User { id: 1 }", |v| Decode.strict_record(v).map_ok(|fs| fs.len())) == Err(Decode({ reason: "expected a record, found variant User", path: "" }))
expect Decode.one("{ id: 1 }", |v| Decode.strict_record(v).map_ok(|fs| fs.len())) == Ok(1)
