## Writing haus: the compact layout (spec §11: one value per line, normal
## spacing), and the building blocks that generated encoders use.
##
##     Encode.to_str(Rec([("name", Text("Ada"))]))   # { name: "Ada" }
import Int
import Secret
import Value

Encode := [].{
	## One value on one line.
	to_str : Value -> Str
	to_str = |value| bytes_to_str(line(value))

	## The canonical form (spec §12): one exact text per value, the same in
	## every binding, so equal values (§2) give identical text. There is no
	## `hash` yet: Roc has no SHA-256 in its standard library; hash the
	## UTF-8 bytes of `canonical` with SHA-256 for the spec's `hash`.
	canonical : Value -> Str
	canonical = |value| bytes_to_str(canonical_bytes(value))

	## Whether two values are equal (spec §2): the same canonical form.
	equals : Value, Value -> Bool
	equals = |a, b| canonical_bytes(a) == canonical_bytes(b)

	## Orders values by the bytes of their canonical forms (spec §12): a total
	## order consistent with `equals`, for sorting (`values.sort_with(Encode.compare)`).
	## Not numeric order: `10` sorts before `9`.
	compare : Value, Value -> [Before, Same, After]
	compare = |a, b| compare_bytes(canonical_bytes(a), canonical_bytes(b))

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

	## `Int`: an integer of any size, as its digits.
	int : Int -> Value
	int = |n| Num(n.to_str())

	## An exact decimal, as its text: `19.90`.
	decimal : Str -> Value
	decimal = |text| Num(text)

	## A Float64 in its one spelling (spec §15): the fewest digits that read
	## back as the same binary64 value, laid out like JavaScript's
	## `Number.prototype.toString` without `+` in the exponent (`1e21`,
	## `1.5e-7`, `-0`). NaN and the infinities are tags (prelude).
	f64 : F64 -> Value
	f64 = |x|
		if x != x {
			Tag("NaN", [])
		} else if x > 1.7976931348623157e308 {
			Tag("Infinity", [])
		} else if x < -1.7976931348623157e308 {
			Tag("NegInfinity", [])
		} else {
			# Roc's `to_str` has the digits the spec asks for: the fewest that read
			# back as the same float, the closest of them, ties to even.
			Num(float_text(x.to_str()))
		}

	## A Float32 in its one spelling: the fewest digits that read back as the
	## same binary32 value (`0.1`, not `0.10000000149011612`), laid out as for `f64`.
	f32 : F32 -> Value
	f32 = |x|
		if x != x {
			Tag("NaN", [])
		} else if x > 3.4028235e38 {
			Tag("Infinity", [])
		} else if x < -3.4028235e38 {
			Tag("NegInfinity", [])
		} else {
			Num(float_text(x.to_str()))
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

	## `Any`: the value as it was.
	any : Value -> Value
	any = |v| v

	## `Secret a`: the value in full (the receiver needs it).
	secret : Secret(a), (a -> Value) -> Value
	secret = |s, encoder| encoder(s.expose())

	## `< >`: a bare tag, or any other variant kept as it was.
	any_tag : [Bare(Str), Other(Str, List(Value))] -> Value
	any_tag = |t| match t {
		Bare(name) => Tag(name, [])
		Other(name, args) => Tag(name, args)
	}
}

## Roc's float text (`1e20`, `1e-6`, `-0`, `0.30000000000000004`) laid out as
## spec §15 says: with the digits d₁…dₖ and the value 0.d₁…dₖ × 10ⁿ, like
## JavaScript's `Number.prototype.toString` without `+` in the exponent.
float_text : Str -> Str
float_text = |shortest| {
	b = shortest.to_utf8()
	sign = if (byte_at(b, 0) == '-') "-" else ""
	# The digits, how many come before the point, and the exponent.
	var $digits = []
	var $before = 0.I64
	var $point = False
	var $in_exp = False
	var $exp = 0.I64
	var $exp_sign = 1.I64
	for c in b {
		if $in_exp {
			if c == '-' {
				$exp_sign = -1
			} else if c >= '0' and c <= '9' {
				$exp = $exp * 10 + (c - '0').to_i64()
			}
		} else if c == 'e' or c == 'E' {
			$in_exp = True
		} else if c == '.' {
			$point = True
		} else if c >= '0' and c <= '9' {
			$digits = $digits.append(c)
			if !$point {
				$before = $before + 1
			}
		}
	}
	var $lead = 0
	while $lead < $digits.len() and byte_at($digits, $lead) == '0' {
		$lead = $lead + 1
	}
	var $end = $digits.len()
	while $end > $lead and byte_at($digits, $end - 1) == '0' {
		$end = $end - 1
	}
	if $end == $lead {
		return "${sign}0"
	}
	d = $digits.sublist({ start: $lead, len: $end - $lead })
	k = d.len().to_i64_wrap()
	n = $before + $exp_sign * $exp - $lead.to_i64_wrap()
	zeros = |count| List.repeat('0', count.to_u64_wrap())
	body =
		if k <= n and n <= 21 {
			d.concat(zeros(n - k))
		} else if 0 < n and n <= 21 {
			d.sublist({ start: 0, len: n.to_u64_wrap() }).append('.').concat(d.sublist({ start: n.to_u64_wrap(), len: (k - n).to_u64_wrap() }))
		} else if -6 < n and n <= 0 {
			['0', '.'].concat(zeros(-n)).concat(d)
		} else {
			rest = if (k > 1) ['.'].concat(d.sublist({ start: 1, len: (k - 1).to_u64_wrap() })) else []
			d.sublist({ start: 0, len: 1 }).concat(rest).append('e').concat((n - 1).to_str().to_utf8())
		}
	"${sign}${bytes_to_str(body)}"
}

line : Value -> List(U8)
line = |value| match value {
	Num(text) => number_text(text)
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

## The canonical form: no spaces, fields sorted by key.
canonical_bytes : Value -> List(U8)
canonical_bytes = |value| match value {
	Num(text) => number_text(text)
	Text(s) => quote(s)
	Bytes(b) => "x\"".to_utf8().concat(hex(b)).append('"')
	Arr(items) => ['['].concat(comma_joined(items.map(canonical_bytes))).append(']')
	Rec(fields) => canonical_record(fields)
	Tag(name, []) => name.to_utf8()
	Tag(name, [Rec(fields)]) => name.to_utf8().concat(canonical_record(fields))
	Tag(name, args) => name.to_utf8().append('(').concat(comma_joined(args.map(canonical_bytes))).append(')')
}

## Fields sorted by their keys' UTF-8 bytes, which is the order of code points.
canonical_record : List((Str, Value)) -> List(U8)
canonical_record = |fields| {
	sorted = fields.map(|(k, v)| (k.to_utf8(), k, v)).sort_with(|(a, _, _), (b, _, _)| compare_bytes(a, b))
	entries = sorted.map(|(_, k, v)| key(k).append(':').concat(canonical_bytes(v)))
	['{'].concat(comma_joined(entries)).append('}')
}

compare_bytes : List(U8), List(U8) -> [Before, Same, After]
compare_bytes = |a, b| {
	var $i = 0
	while $i < a.len() and $i < b.len() {
		x = byte_at(a, $i)
		y = byte_at(b, $i)
		if x < y {
			return Before
		}
		if x > y {
			return After
		}
		$i = $i + 1
	}
	if a.len() < b.len() Before else if a.len() > b.len() After else Same
}

byte_at : List(U8), U64 -> U8
byte_at = |bytes, i| match bytes.get(i) {
	Ok(b) => b
	Err(_) => 0
}

## Items separated by `,`.
comma_joined : List(List(U8)) -> List(U8)
comma_joined = |items| {
	var $out = []
	var $first = True
	for item in items {
		$out = if ($first) item else $out.append(',').concat(item)
		$first = False
	}
	$out
}

## A number's normalized literal, except an integer longer than the number
## limit (spec §7), which is written in hex so that it parses again (§11, §12).
number_text : Str -> List(U8)
number_text = |text| {
	b = text.to_utf8()
	negative = byte_at(b, 0) == '-'
	digits = if (negative) b.sublist({ start: 1, len: b.len() - 1 }) else b
	if b.len() > 1000 and digits.all(|c| c >= '0' and c <= '9') {
		(if (negative) ['-'] else []).concat(['0', 'x']).concat(decimal_to_hex(digits))
	} else {
		b
	}
}

## Decimal digits as lowercase hex, without leading zeros.
decimal_to_hex : List(U8) -> List(U8)
decimal_to_hex = |digits| {
	# Little-endian limbs of base 2^32.
	var $limbs = [0]
	for d in digits {
		var $carry = (d - '0').to_u64()
		var $next = []
		for limb in $limbs {
			v = limb * 10 + $carry
			$next = $next.append(v % 4294967296)
			$carry = v // 4294967296
		}
		$limbs = if ($carry > 0) $next.append($carry) else $next
	}
	var $out = []
	var $first = True
	var $index = $limbs.len()
	while $index > 0 {
		$index = $index - 1
		limb = match $limbs.get($index) {
			Ok(l) => l
			Err(_) => 0
		}
		# The most significant limb without leading zeros, the others padded to 8 digits.
		var $part = []
		var $v = limb
		var $count = 0
		while $v > 0 or ($first and $part.is_empty()) or (!$first and $count < 8) {
			$part = [hex_digit(($v % 16).to_u8_wrap())].concat($part)
			$v = $v // 16
			$count = $count + 1
		}
		$out = $out.concat($part)
		$first = False
	}
	$out
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
		# C1 controls (U+0080–U+009F): C2 80–9F.
		c1 = c == 0xC2 and next >= 0x80 and next <= 0x9F
		if c1 {
			$out = $out.concat("\\u{${hex_upper(next.to_u64())}}".to_utf8())
			$i = $i + 2
		} else if bidi {
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
				} else if c < 0x20 or c == 0x7F {
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
expect Int.from_str("340282366920938463463374607431768211457").map_ok(|n| Encode.to_str(Encode.int(n))) == Ok("340282366920938463463374607431768211457")
expect Encode.to_str(Encode.record([("a", Present(Num("1"))), ("b", Missing)])) == "{ a: 1 }"
expect Encode.to_str(Text("\u(1B)\u(7F)\u(85)")) == "\"\\u{1B}\\u{7F}\\u{85}\""

# Floats in their one spelling (spec §15).
expect [1.0, 100.0, 123000.0, 1.5, 12.25, 0.1, 0.000001, 1e-7, 1.5e-7, 1e20, 1e21, -1.5, 0.30000000000000004, 5e-324, 1.7976931348623157e308].map(|x| Encode.to_str(Encode.f64(x))) == ["1", "100", "123000", "1.5", "12.25", "0.1", "0.000001", "1e-7", "1.5e-7", "100000000000000000000", "1e21", "-1.5", "0.30000000000000004", "5e-324", "1.7976931348623157e308"]
expect [0.0, -0.0, 0.0 / 0.0, 1.0 / 0.0, -1.0 / 0.0].map(|x| Encode.to_str(Encode.f64(x))) == ["0", "-0", "NaN", "Infinity", "NegInfinity"]
expect [0.1.F32, 16777216.0, 1.0000001, 3.4028235e38, 1e21, -0.0].map(|x| Encode.to_str(Encode.f32(x))) == ["0.1", "16777216", "1.0000001", "3.4028235e38", "1e21", "-0"]
# Exactly half way between the two closest shortest candidates: the even one, like JavaScript.
expect [1690060720831323.25, -1690060720831323.25].map(|x| Encode.to_str(Encode.f64(x))) == ["1690060720831323.2", "-1690060720831323.2"]
expect [2097152.25.F32, 2097152.75, 1048576.125, 4498.53125].map(|x| Encode.to_str(Encode.f32(x))) == ["2097152.2", "2097152.8", "1048576.1", "4498.5312"]

# The canonical form (spec §12): the same cases as the TypeScript and Rust bindings.
canonical_of : Str -> Str
canonical_of = |src| match Value.parse_all(src) {
	Ok([v]) => Encode.canonical(v)
	_ => "(not one value)"
}

equal_texts : Str, Str -> Bool
equal_texts = |a, b| match (Value.parse_all(a), Value.parse_all(b)) {
	(Ok([x]), Ok([y])) => Encode.equals(x, y)
	_ => False
}

compare_texts : Str, Str -> [Before, Same, After]
compare_texts = |a, b| match (Value.parse_all(a), Value.parse_all(b)) {
	(Ok([x]), Ok([y])) => Encode.compare(x, y)
	_ => Same
}

expect canonical_of("Order { total: 19.90, id: 0xFF, \"x-y\": 1e+5, p: Point(1, 2) }") == "Order{id:255,p:Point(1,2),total:19.90,\"x-y\":1e5}"
expect canonical_of("{ b: [1_000, 0b11], /* c */ a: Tag({ x: x\"0B 34\" }) }") == "{a:Tag{x:x\"0b34\"},b:[1000,3]}"
expect equal_texts("{ b: [1_000, 0b11], /* c */ a: Tag({ x: x\"0B 34\" }) }", "{a:Tag{x:x\"0b34\"},b:[1000,3]}")
expect !equal_texts("1.0", "1") and !equal_texts("{}", "{ x: None }") and !equal_texts("-0", "0")
expect !equal_texts("\"caf\\u{E9}\"", "\"cafe\\u{301}\"") and equal_texts("-0x0", "0")
expect canonical_of("\"tab\\tquote\\\" \\u{41} \\u{1b} \\u{202e} café 😀\"") == "\"tab\\tquote\\\" A \\u{1B} \\u{202E} café 😀\""
expect canonical_of("\"\"\"\n  two\n  lines\n  \"\"\"") == "\"two\\nlines\""
expect canonical_of("{ \"😀\": 1, \"\u(FFFD)\": 2, a: 3, \"Z\": 4 }") == "{\"Z\":4,a:3,\"\u(FFFD)\":2,\"😀\":1}"
expect canonical_of("[None, Some(1), Circle({ r: 1 }), Pair({ a: 1 }, 2)]") == "[None,Some(1),Circle{r:1},Pair({a:1},2)]"
expect canonical_of("0x${"f".repeat(900)}") == "0x${"f".repeat(900)}"
expect match Value.parse_all("9, 10, [], \"😀\", { b: 1, a: 2 }, Some(1), -1") {
	Ok(vs) => vs.sort_with(Encode.compare).map(Encode.canonical) == ["\"😀\"", "-1", "10", "9", "Some(1)", "[]", "{a:2,b:1}"]
	_ => False
}
expect compare_texts("{ b: 1, a: 2 }", "{ a: 2, b: 1 }") == Same and compare_texts("1.0", "1") == After
# The compact writer keeps a huge integer in hex too (spec §11), so its output parses again.
expect match Value.parse_all("0x${"f".repeat(900)}") {
	Ok([v]) => Encode.to_str(v) == "0x${"f".repeat(900)}"
	_ => False
}
