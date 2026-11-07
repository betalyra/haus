## Building blocks for decoding a haus `Value` into your own Roc types.
##
## A decoder is a function `Value -> Try(a, Decode.Error)`. Errors carry a
## path that is built on the way out (`$[1].amount.currency`), so decoders
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
import Value

Decode := [].{
	# ── documents ───────────────────────────────────────────

	## Parse a whole file and decode every top-level value (a stream).
	all : Str, (Value -> Try(a, Error)) -> Try(List(a), [Syntax(Value.ParseError), Decode(Error)])
	all = |text, decoder| {
		values = Value.parse_all(text).map_err(|e| Syntax(e))?
		var $out = []
		var $i = 0.U64
		for v in values {
			$out = $out.append(at(decoder(v), "$[${$i.to_str()}]").map_err(|e| Decode(e))?)
			$i = $i + 1
		}
		Ok($out)
	}

	## Parse a text holding exactly one value and decode it.
	one : Str, (Value -> Try(a, Error)) -> Try(a, [Syntax(Value.ParseError), Decode(Error)])
	one = |text, decoder| {
		v = Value.parse(text).map_err(|e| Syntax(e))?
		at(decoder(v), "$").map_err(|e| Decode(e))
	}

	# ── scalars ─────────────────────────────────────────────

	str : Value -> Try(Str, Error)
	str = |v| match v {
		Text(s) => Ok(s)
		_ => expected("String", v)
	}

	## A non-negative integer.
	u64 : Value -> Try(U64, Error)
	u64 = |v| match v {
		Num(text) => {
			var $n = 0
			for b in text.to_utf8() {
				if b < '0' or b > '9' {
					return expected("an unsigned integer", v)
				}
				$n = $n * 10 + (b - '0').to_u64()
			}
			Ok($n)
		}
		_ => expected("an unsigned integer", v)
	}

	## An exact decimal, kept as its literal text (`19.90` stays "19.90").
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

	## `Instant("2026-11-07T10:00:00Z")`, returned as the ISO string.
	instant : Value -> Try(Str, Error)
	instant = |v| tagged_string("Instant", v)

	## `Date("2026-11-07")`, returned as the ISO string.
	date : Value -> Try(Str, Error)
	date = |v| tagged_string("Date", v)

	## `Money(19.99, EUR)`. The amount stays exact text; currencies are an open set.
	money : Value -> Try({ amount : Str, currency : Str }, Error)
	money = |v| match v {
		Tag("Money", [amount, currency]) => Ok({ amount: at(decimal(amount), "[0]")?, currency: at(tag_name(currency), "[1]")? })
		_ => expected("Money(Decimal, Currency)", v)
	}

	# ── containers ──────────────────────────────────────────

	## The fields of a record, or of a variant's record payload (`Circle { … }`).
	record : Value -> Try(List((Str, Value)), Error)
	record = |v| match v {
		Rec(fields) => Ok(fields)
		Tag(_, [Rec(fields)]) => Ok(fields)
		_ => expected("a record", v)
	}

	## A required field.
	field : List((Str, Value)), Str, (Value -> Try(a, Error)) -> Try(a, Error)
	field = |fields, key, decoder| match fields.find_first(|(k, _)| k == key) {
		Ok((_, v)) => at(decoder(v), ".${key}")
		Err(_) => Err({ reason: "missing field '${key}'", path: "" })
	}

	## A `Maybe` field: `None`, `Some(x)`, or missing (also `None`).
	maybe_field : List((Str, Value)), Str, (Value -> Try(a, Error)) -> Try([None, Some(a)], Error)
	maybe_field = |fields, key, decoder| match fields.find_first(|(k, _)| k == key) {
		Err(_) => Ok(None)
		Ok((_, Tag("None", []))) => Ok(None)
		Ok((_, Tag("Some", [inner]))) => Ok(Some(at(decoder(inner), ".${key}[0]")?))
		Ok((_, v)) => at(expected("None | Some(…)", v), ".${key}")
	}

	## A field of a partial update (prelude `Patch a`): absent → `Keep`, present → `Set(value)`.
	## For a Maybe field use `|v| Decode.maybe(v, Decode.str)` as the decoder, so `None` clears.
	patch_field : List((Str, Value)), Str, (Value -> Try(a, Error)) -> Try([Keep, Set(a)], Error)
	patch_field = |fields, key, decoder| match fields.find_first(|(k, _)| k == key) {
		Err(_) => Ok(Keep)
		Ok((_, v)) => Ok(Set(at(decoder(v), ".${key}")?))
	}

	## A `Maybe` value: `None` or `Some(x)`.
	maybe : Value, (Value -> Try(a, Error)) -> Try([None, Some(a)], Error)
	maybe = |v, decoder| match v {
		Tag("None", []) => Ok(None)
		Tag("Some", [inner]) => Ok(Some(at(decoder(inner), "[0]")?))
		_ => expected("None | Some(…)", v)
	}

	## An array, decoding each item.
	list : Value, (Value -> Try(a, Error)) -> Try(List(a), Error)
	list = |v, decoder| match v {
		Arr(items) => {
			var $out = []
			var $i = 0.U64
			for item in items {
				$out = $out.append(at(decoder(item), "[${$i.to_str()}]")?)
				$i = $i + 1
			}
			Ok($out)
		}
		_ => expected("an array", v)
	}

	# ── errors ──────────────────────────────────────────────

	## Fail with a custom reason at the current position.
	fail : Str -> Try(a, Error)
	fail = |reason| Err({ reason, path: "" })

	## Fail with "expected …, found …".
	expected : Str, Value -> Try(a, Error)
	expected = |what, v| Err({ reason: "expected ${what}, found ${describe(v)}", path: "" })
}

## `path` is relative while decoding and absolute (`$…`) once it reaches the top.
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
	Arr(_) => "an array"
	Rec(_) => "a record"
	Tag(name, _) => "variant ${name}"
}

# ── tests ────────────────────────────────────────────────────

Order : { id : U64, note : [None, Some(Str)], prices : List({ amount : Str, currency : Str }), paid : Bool }

order : Value -> Try(Order, Error)
order = |v| {
	fs = Decode.record(v)?
	Ok({
		id: Decode.field(fs, "id", Decode.u64)?,
		note: Decode.maybe_field(fs, "note", Decode.str)?,
		prices: Decode.field(fs, "prices", |p| Decode.list(p, Decode.money))?,
		paid: Decode.field(fs, "paid", Decode.bool)?,
	})
}

expect Decode.one("{ id: 1, prices: [Money(19.90, EUR)], paid: True }", order) == Ok({ id: 1, note: None, prices: [{ amount: "19.90", currency: "EUR" }], paid: True })
expect Decode.one("{ id: 1, note: Some(\"hi\"), prices: [], paid: False }", order) == Ok({ id: 1, note: Some("hi"), prices: [], paid: False })
expect Decode.one("{ id: 1, note: None, prices: [Money(1, EUR), Money(2, 3)], paid: True }", order) == Err(Decode({ reason: "expected a tag without payload, found number 3", path: "$.prices[1][1]" }))
expect Decode.one("{ id: 1, note: Some(1), prices: [], paid: True }", order) == Err(Decode({ reason: "expected String, found number 1", path: "$.note[0]" }))
expect Decode.one("{ id: 1, prices: [], paid: Yes }", order) == Err(Decode({ reason: "expected True | False, found variant Yes", path: "$.paid" }))
expect Decode.all("1, 2, x", Decode.u64) == Err(Syntax({ reason: "unexpected identifier 'x': lowercase identifiers can only be record keys", line: 1, column: 7 }))

PatchUser : { name : [Keep, Set(Str)], nickname : [Keep, Set([None, Some(Str)])] }

patch_user : Value -> Try(PatchUser, Error)
patch_user = |v| {
	fs = Decode.record(v)?
	Ok({
		name: Decode.patch_field(fs, "name", Decode.str)?,
		nickname: Decode.patch_field(fs, "nickname", |n| Decode.maybe(n, Decode.str))?,
	})
}

expect Decode.one("{}", patch_user) == Ok({ name: Keep, nickname: Keep })
expect Decode.one("{ name: \"Jan\", nickname: None }", patch_user) == Ok({ name: Set("Jan"), nickname: Set(None) })
expect Decode.one("{ nickname: Some(\"J\") }", patch_user) == Ok({ name: Keep, nickname: Set(Some("J")) })
