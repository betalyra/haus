## Writing haus: the compact layout (spec §11: one value per line, normal
## spacing), and the building blocks that generated encoders use.
##
##     Encode.to_str(Rec([("name", Text("Ada"))]))   # { name: "Ada" }
import Value

Encode := [].{
	## One value on one line.
	to_str : Value -> Str
	to_str = |value| bytes_to_str(line(value))

	## A stream: one value per line, each followed by a comma.
	stream : List(Value) -> Str
	stream = |values| Str.join_with(values.map(|v| "${to_str(v)},\n"), "")

	# ── building blocks ─────────────────────────────────────

	str : Str -> Value
	str = |s| Text(s)

	bytes : List(U8) -> Value
	bytes = |b| Bytes(b)

	bool : Bool -> Value
	bool = |b| Tag(if (b) "True" else "False", [])

	## An exact decimal, as its text: `19.90`.
	decimal : Str -> Value
	decimal = |text| Num(text)

	## A float; NaN and the infinities are tags (prelude).
	f64 : F64 -> Value
	f64 = |x|
		if x != x {
			Tag("NaN", [])
		} else if x > 1.7976931348623157e308 {
			Tag("Infinity", [])
		} else if x < -1.7976931348623157e308 {
			Tag("NegInfinity", [])
		} else {
			Num(x.to_str())
		}

	## A std/time value: `Date("2026-11-09")`.
	time : Str -> (Str -> Value)
	time = |name| |text| Tag(name, [Text(text)])

	list : List(a), (a -> Value) -> Value
	list = |items, encode| Arr(items.map(encode))

	## `Map v`: a record used as a dictionary.
	map : List((Str, a)), (a -> Value) -> Value
	map = |entries, encode| Rec(entries.map(|(k, v)| (k, encode(v))))

	maybe : [None, Some(a)], (a -> Value) -> Value
	maybe = |m, encode| match m {
		None => Tag("None", [])
		Some(x) => Tag("Some", [encode(x)])
	}

	result : Try(a, e), (a -> Value), (e -> Value) -> Value
	result = |r, ok, err| match r {
		Ok(x) => Tag("Ok", [ok(x)])
		Err(x) => Tag("Err", [err(x)])
	}

	## An optional field (`key?: T`): left out of the record when `Missing`.
	optional : [Missing, Present(a)], (a -> Value) -> [Missing, Present(Value)]
	optional = |o, encode| match o {
		Missing => Missing
		Present(x) => Present(encode(x))
	}

	## A record from its fields in order, leaving out missing optional ones.
	record : List((Str, [Missing, Present(Value)])) -> Value
	record = |fields| {
		var $out = []
		for (key, field) in fields {
			match field {
				Present(v) => {
					$out = $out.append((key, v))
				}
				Missing => {}
			}
		}
		Rec($out)
	}

	## `< >`: a bare tag, or any other variant kept as it was.
	any_tag : [Bare(Str), Other(Str, List(Value))] -> Value
	any_tag = |t| match t {
		Bare(name) => Tag(name, [])
		Other(name, args) => Tag(name, args)
	}
}

line : Value -> List(U8)
line = |value| match value {
	Num(text) => text.to_utf8()
	Text(s) => quote(s)
	Bytes(b) => "x\"".to_utf8().concat(hex(b)).append('"')
	Arr(items) => ['['].concat(joined(items.map(line))).append(']')
	Rec(fields) => record_line(fields)
	Tag(name, []) => name.to_utf8()
	Tag(name, [Rec(fields)]) => name.to_utf8().append(' ').concat(record_line(fields))
	Tag(name, args) => name.to_utf8().append('(').concat(joined(args.map(line))).append(')')
}

record_line : List((Str, Value)) -> List(U8)
record_line = |fields|
	if fields.is_empty() {
		['{', '}']
	} else {
		entries = fields.map(|(k, v)| key(k).concat([':', ' ']).concat(line(v)))
		['{', ' '].concat(joined(entries)).concat([' ', '}'])
	}

## Items separated by `, `.
joined : List(List(U8)) -> List(U8)
joined = |items| {
	var $out = []
	var $first = True
	for item in items {
		$out = if ($first) item else $out.concat([',', ' ']).concat(item)
		$first = False
	}
	$out
}

## A key without quotes if it is an identifier: `name`, `_id`.
key : Str -> List(U8)
key = |k| {
	b = k.to_utf8()
	first = match b.get(0) {
		Ok(c) => c
		Err(_) => 0
	}
	bare = ((first >= 'a' and first <= 'z') or first == '_') and b.all(|c| (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or (c >= '0' and c <= '9') or c == '_')
	if (bare) b else quote(k)
}

## A `"…"` string with the minimal escapes.
quote : Str -> List(U8)
quote = |s| {
	b = s.to_utf8()
	var $out = ['"']
	var $i = 0
	while $i < b.len() {
		c = match b.get($i) {
			Ok(x) => x
			Err(_) => 0
		}
		# Bidirectional controls (U+202A–U+202E, U+2066–U+2069): E2 80 AA–AE, E2 81 A6–A9.
		next = match b.get($i + 1) {
			Ok(x) => x
			Err(_) => 0
		}
		third = match b.get($i + 2) {
			Ok(x) => x
			Err(_) => 0
		}
		bidi = c == 0xE2 and ((next == 0x80 and third >= 0xAA and third <= 0xAE) or (next == 0x81 and third >= 0xA6 and third <= 0xA9))
		if bidi {
			cp = if (next == 0x80) 0x2000 + third.to_u64() - 0x80 else 0x2040 + third.to_u64() - 0x80
			$out = $out.concat("\\u{${hex_upper(cp)}}".to_utf8())
			$i = $i + 3
		} else {
			$out =
				if c == '"' {
					$out.concat(['\\', '"'])
				} else if c == '\\' {
					$out.concat(['\\', '\\'])
				} else if c == '\n' {
					$out.concat(['\\', 'n'])
				} else if c == '\r' {
					$out.concat(['\\', 'r'])
				} else if c == '\t' {
					$out.concat(['\\', 't'])
				} else if c < 0x20 {
					$out.concat("\\u{${hex_upper(c.to_u64())}}".to_utf8())
				} else {
					$out.append(c)
				}
			$i = $i + 1
		}
	}
	$out.append('"')
}

digit_chars : List(U8)
digit_chars = "0123456789abcdef".to_utf8()

hex : List(U8) -> List(U8)
hex = |bytes| {
	var $out = []
	for b in bytes {
		$out = $out.append(hex_digit(b // 16)).append(hex_digit(b % 16))
	}
	$out
}

hex_digit : U8 -> U8
hex_digit = |d| match digit_chars.get(d.to_u64()) {
	Ok(c) => c
	Err(_) => '0'
}

hex_upper : U64 -> Str
hex_upper = |n| {
	var $digits = []
	var $v = n
	while $v > 0 or $digits.is_empty() {
		d = ($v % 16).to_u8_wrap()
		c = if (d < 10) '0' + d else 'A' + d - 10
		$digits = [c].concat($digits)
		$v = $v // 16
	}
	bytes_to_str($digits)
}

bytes_to_str : List(U8) -> Str
bytes_to_str = |bytes| match Str.from_utf8(bytes) {
	Ok(s) => s
	Err(_) => ""
}

# ── tests ────────────────────────────────────────────────────

expect Encode.to_str(Rec([("name", Text("Ada")), ("pt-BR", Num("1"))])) == "{ name: \"Ada\", \"pt-BR\": 1 }"
expect Encode.to_str(Tag("Shipped", [Rec([("tracking", Text("DE-4711"))])])) == "Shipped { tracking: \"DE-4711\" }"
expect Encode.to_str(Tag("Money", [Num("44.40"), Tag("EUR", [])])) == "Money(44.40, EUR)"
expect Encode.to_str(Arr([Bytes([0x0b, 0xff]), Rec([]), Arr([])])) == "[x\"0bff\", {}, []]"
expect Encode.to_str(Text("a\"b\\\n\u(202E)")) == "\"a\\\"b\\\\\\n\\u{202E}\""
expect Encode.stream([Tag("A", []), Num("1")]) == "A,\n1,\n"
expect Encode.to_str(Encode.record([("a", Present(Num("1"))), ("b", Missing)])) == "{ a: 1 }"
