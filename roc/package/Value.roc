## The haus data model and parser.
##
## `Value.parse_all(text)` parses a whole file: a sequence of top-level values.
## Numbers are kept as exact literal text, variants are generic: applying a
## schema (decoding into your own tag unions) happens afterwards.
Value := [
	Num(Str),
	Text(Str),
	Bytes(List(U8)),
	Arr(List(Value)),
	Rec(List((Str, Value))),
	Tag(Str, List(Value)),
].{

	## Parse a whole file into its top-level values.
	parse_all : Str -> Try(List(Value), ParseError)
	parse_all = |text| {
		src = text.to_utf8()
		start = if (src.starts_with([0xEF, 0xBB, 0xBF])) 3 else 0
		match parse_sequence(src, start) {
			Ok(values) => Ok(values)
			Err(f) => Err(locate(src, f))
		}
	}

	## The rest of a stream: like `parse_all`, but not at the start of the input,
	## so a byte order mark is not skipped (the stream reader removes the one at
	## the start).
	parse_rest : Str -> Try(List(Value), ParseError)
	parse_rest = |text| {
		src = text.to_utf8()
		match parse_sequence(src, 0) {
			Ok(values) => Ok(values)
			Err(f) => Err(locate(src, f))
		}
	}

	## Parse raw bytes, which must be valid UTF-8.
	parse_bytes : List(U8) -> Try(List(Value), ParseError)
	parse_bytes = |bytes| match Str.from_utf8(bytes) {
		Ok(text) => parse_all(text)
		Err(_) => Err({ reason: "invalid UTF-8", line: 1, column: 1 })
	}

	## Parse a text that must contain exactly one value.
	parse : Str -> Try(Value, ParseError)
	parse = |text| {
		values = parse_all(text)?
		match values {
			[v] => Ok(v)
			_ => Err({ reason: "expected exactly one value, found ${values.len().to_str()}", line: 1, column: 1 })
		}
	}

	## Encode in the conformance suite's JSON form (see test-suite/README.md).
	to_test_json : Value -> Str
	to_test_json = |value| match value {
		Num(t) => "{\"num\":${json_str(t)}}"
		Text(s) => json_str(s)
		Bytes(bytes) => "{\"bytes\":\"${hex_lower(bytes)}\"}"
		Arr(items) => "[${Str.join_with(items.map(to_test_json), ",")}]"
		Rec(fields) => {
			parts = fields.map(|(k, v)| "${json_str(k)}:${to_test_json(v)}")
			"{\"rec\":{${Str.join_with(parts, ",")}}}"
		}
		Tag(name, []) => "{\"tag\":${json_str(name)}}"
		Tag(name, args) => "{\"tag\":${json_str(name)},\"args\":[${Str.join_with(args.map(to_test_json), ",")}]}"
	}
}

ParseError : { reason : Str, line : U64, column : U64 }

Fail : { reason : Str, pos : U64 }

# ── limits (spec defaults) ───────────────────────────────────

max_depth : U64
max_depth = 256

max_number_length : U64
max_number_length = 1000

max_exponent : U64
max_exponent = 6144

max_string_length : U64
max_string_length = 16 * 1024 * 1024

# ── structure ────────────────────────────────────────────────

parse_sequence : List(U8), U64 -> Try(List(Value), Fail)
parse_sequence = |src, start| {
	var $out = []
	var $pos = skip_trivia(src, start)?
	var $done = $pos >= src.len()
	while !$done {
		(value, after) = parse_value(src, $pos, 0)?
		$out = $out.append(value)
		p = skip_trivia(src, after)?
		if p >= src.len() {
			$done = True
		} else if at(src, p) == ',' {
			$pos = skip_trivia(src, p + 1)?
			$done = $pos >= src.len()
		} else {
			return Err({ reason: "expected ',' between top-level values, found ${describe(src, p)}", pos: p })
		}
	}
	Ok($out)
}

parse_value : List(U8), U64, U64 -> Try((Value, U64), Fail)
parse_value = |src, pos, depth| {
	c = at(src, pos)
	if c == '{' {
		(fields, after) = parse_record(src, pos, depth)?
		Ok((Rec(fields), after))
	} else if c == '[' {
		(items, after) = parse_list(src, pos, depth, ']')?
		Ok((Arr(items), after))
	} else if c == '"' {
		(s, after) = (if (starts_at(src, pos, "\"\"\"")) parse_block_string(src, pos) else parse_basic_string(src, pos))?
		Ok((Text(s), after))
	} else if c == 'x' and at(src, pos + 1) == '"' {
		(bytes, after) = parse_bytes_literal(src, pos)?
		Ok((Bytes(bytes), after))
	} else if c == '-' or is_digit(c) {
		parse_number(src, pos)
	} else if is_upper(c) {
		parse_variant(src, pos, depth)
	} else if is_lower_start(c) {
		(word, _) = read_ident(src, pos)
		hint =
			if word == "true" or word == "false" {
				" (booleans are the variants True / False)"
			} else if word == "null" {
				" (use the variant None)"
			} else {
				""
			}
		Err({ reason: "unexpected identifier '${word}': lowercase identifiers can only be record keys${hint}", pos })
	} else {
		Err({ reason: "expected a value, found ${describe(src, pos)}", pos })
	}
}

parse_record : List(U8), U64, U64 -> Try((List((Str, Value)), U64), Fail)
parse_record = |src, open, depth| {
	if depth + 1 > max_depth {
		return Err({ reason: "nesting deeper than ${max_depth.to_str()} levels", pos: open })
	}
	var $fields = []
	var $seen = Set.empty()
	var $pos = skip_trivia(src, open + 1)?
	while at(src, $pos) != '}' {
		if $pos >= src.len() {
			return Err({ reason: "unclosed '{'", pos: open })
		}
		key_pos = $pos
		(key, after_key) = parse_key(src, $pos)?
		colon = skip_trivia(src, after_key)?
		if at(src, colon) != ':' {
			return Err({ reason: "expected ':' after key '${key}', found ${describe(src, colon)}", pos: colon })
		}
		(value, after_value) = parse_value(src, skip_trivia(src, colon + 1)?, depth + 1)?
		if $seen.contains(key) {
			return Err({ reason: "duplicate key '${key}'", pos: key_pos })
		}
		$fields = $fields.append((key, value))
		$seen = $seen.insert(key)
		p = skip_trivia(src, after_value)?
		if at(src, p) == ',' {
			$pos = skip_trivia(src, p + 1)?
		} else if at(src, p) == '}' {
			$pos = p
		} else if p >= src.len() {
			return Err({ reason: "unclosed '{'", pos: open })
		} else {
			return Err({ reason: "expected ',' or '}', found ${describe(src, p)}", pos: p })
		}
	}
	Ok(($fields, $pos + 1))
}

parse_key : List(U8), U64 -> Try((Str, U64), Fail)
parse_key = |src, pos| {
	c = at(src, pos)
	if c == '"' {
		if starts_at(src, pos, "\"\"\"") {
			Err({ reason: "block strings can't be record keys", pos })
		} else {
			parse_basic_string(src, pos)
		}
	} else if is_lower_start(c) {
		Ok(read_ident(src, pos))
	} else if is_upper(c) {
		(word, _) = read_ident(src, pos)
		Err({ reason: "record keys must start with a lowercase letter or '_'; quote it: \"${word}\"", pos })
	} else {
		Err({ reason: "expected a record key, found ${describe(src, pos)}", pos })
	}
}

## `open value, value, ... close` with an optional trailing comma.
parse_list : List(U8), U64, U64, U8 -> Try((List(Value), U64), Fail)
parse_list = |src, open, depth, close| {
	if depth + 1 > max_depth {
		return Err({ reason: "nesting deeper than ${max_depth.to_str()} levels", pos: open })
	}
	open_str = byte_str(at(src, open))
	var $items = []
	var $pos = skip_trivia(src, open + 1)?
	while at(src, $pos) != close {
		if $pos >= src.len() {
			return Err({ reason: "unclosed '${open_str}'", pos: open })
		}
		(value, after) = parse_value(src, $pos, depth + 1)?
		$items = $items.append(value)
		p = skip_trivia(src, after)?
		if at(src, p) == ',' {
			$pos = skip_trivia(src, p + 1)?
		} else if at(src, p) == close {
			$pos = p
		} else if p >= src.len() {
			return Err({ reason: "unclosed '${open_str}'", pos: open })
		} else {
			return Err({ reason: "expected ',' or '${byte_str(close)}', found ${describe(src, p)}", pos: p })
		}
	}
	Ok(($items, $pos + 1))
}

parse_variant : List(U8), U64, U64 -> Try((Value, U64), Fail)
parse_variant = |src, pos, depth| {
	(tag, after_tag) = read_ident(src, pos)
	# The payload must follow on the same line: only spaces and tabs in between.
	var $p = after_tag
	while at(src, $p) == ' ' or at(src, $p) == '\t' {
		$p = $p + 1
	}
	p = $p
	if at(src, p) == '(' {
		(args, after) = parse_list(src, p, depth, ')')?
		if args.is_empty() {
			Err({ reason: "empty payload: write '${tag}' without parentheses", pos: p })
		} else {
			Ok((Tag(tag, args), after))
		}
	} else if at(src, p) == '{' {
		(fields, after) = parse_record(src, p, depth)?
		Ok((Tag(tag, [Rec(fields)]), after))
	} else {
		Ok((Tag(tag, []), after_tag))
	}
}

# ── numbers ──────────────────────────────────────────────────

parse_number : List(U8), U64 -> Try((Value, U64), Fail)
parse_number = |src, start| {
	check_number_limits(src, start)?
	neg = at(src, start) == '-'
	digits_start = if (neg) start + 1 else start
	(text, end) =
		if starts_at(src, digits_start, "0x") {
			radix_literal(src, digits_start + 2, 16, neg).map_err(|_| invalid_number(src, start))?
		} else if starts_at(src, digits_start, "0b") {
			radix_literal(src, digits_start + 2, 2, neg).map_err(|_| invalid_number(src, start))?
		} else {
			decimal_literal(src, start, digits_start)?
		}
	next = at(src, end)
	if is_ident_char(next) or next == '.' {
		Err(invalid_number(src, start))
	} else {
		Ok((Num(text), end))
	}
}

## Digits with optional single `_` between them. Returns the end position.
digit_run : List(U8), U64, (U8 -> Bool) -> Try(U64, {})
digit_run = |src, start, is_valid| {
	if !is_valid(at(src, start)) {
		return Err({})
	}
	var $p = start + 1
	var $go = True
	while $go {
		c = at(src, $p)
		if is_valid(c) {
			$p = $p + 1
		} else if c == '_' and is_valid(at(src, $p + 1)) {
			$p = $p + 2
		} else {
			$go = False
		}
	}
	Ok($p)
}

## `invalid number '0x'`, at the start of the literal, like the other bindings.
invalid_number : List(U8), U64 -> Fail
invalid_number = |src, start| {
	var $e = start + 1
	while is_ident_char(at(src, $e)) or at(src, $e) == '.' {
		$e = $e + 1
	}
	{ reason: "invalid number '${slice_str(src, start, $e)}'", pos: start }
}

decimal_literal : List(U8), U64, U64 -> Try((Str, U64), Fail)
decimal_literal = |src, start, digits_start| {
	bad = |_| { reason: "invalid number", pos: start }
	int_end =
		if at(src, digits_start) == '0' {
			digits_start + 1
		} else if is_nonzero_digit(at(src, digits_start)) {
			digit_run(src, digits_start, is_digit).map_err(bad)?
		} else {
			return Err(bad({}))
		}
	frac_end =
		if at(src, int_end) == '.' and is_digit(at(src, int_end + 1)) {
			digit_run(src, int_end + 1, is_digit).map_err(bad)?
		} else {
			int_end
		}
	c = at(src, frac_end)
	end =
		if c == 'e' or c == 'E' {
			sign = at(src, frac_end + 1)
			exp_start = if (sign == '+' or sign == '-') frac_end + 2 else frac_end + 1
			match digit_run(src, exp_start, is_digit) {
				Ok(e) => e
				Err(_) => frac_end
			}
		} else {
			frac_end
		}
	text = src
		.sublist({ start, len: end - start })
		.keep_if(|b| b != '_')
		.map(|b| if (b == 'E') 'e' else b)
	Ok((bytes_to_str(text), end))
}

## Hex or binary digits, converted to a decimal integer of any size.
radix_literal : List(U8), U64, U64, Bool -> Try((Str, U64), Fail)
radix_literal = |src, start, radix, neg| {
	is_valid = |b| if (radix == 16) is_hex(b) else b == '0' or b == '1'
	end = digit_run(src, start, is_valid).map_err(|_| { reason: "invalid number", pos: start })?
	# Little-endian decimal digits; multiply by radix and add each digit.
	var $decimal = [0]
	for b in src.sublist({ start, len: end - start }) {
		if b != '_' {
			$decimal = mul_add($decimal, radix, hex_value(b))
		}
	}
	digits = bytes_to_str(reverse($decimal).map(|d| d.to_u8_wrap() + '0'))
	sign = if (neg and digits != "0") "-" else ""
	Ok(("${sign}${digits}", end))
}

mul_add : List(U64), U64, U64 -> List(U64)
mul_add = |digits, factor, add| {
	var $carry = add
	var $out = []
	for d in digits {
		v = d * factor + $carry
		$out = $out.append(v % 10)
		$carry = v // 10
	}
	while $carry > 0 {
		$out = $out.append($carry % 10)
		$carry = $carry // 10
	}
	$out
}

## Checked before converting, so huge literals are rejected cheaply.
check_number_limits : List(U8), U64 -> Try({}, Fail)
check_number_limits = |src, start| {
	var $end = start
	while is_number_char(at(src, $end)) {
		$end = $end + 1
	}
	if $end - start > max_number_length {
		return Err({ reason: "number literal longer than ${max_number_length.to_str()} characters", pos: start })
	}
	digits_start = if (at(src, start) == '-') start + 1 else start
	if starts_at(src, digits_start, "0x") or starts_at(src, digits_start, "0b") {
		return Ok({})
	}
	# Decimal: find the exponent marker, then its digits.
	var $p = digits_start
	while $p < $end and at(src, $p) != 'e' and at(src, $p) != 'E' {
		$p = $p + 1
	}
	if $p >= $end {
		return Ok({})
	}
	$p = $p + 1
	if at(src, $p) == '+' or at(src, $p) == '-' {
		$p = $p + 1
	}
	var $exp = 0
	while $p < $end {
		b = at(src, $p)
		if is_digit(b) {
			$exp = $exp * 10 + (b - '0').to_u64()
			if $exp > max_exponent {
				return Err({ reason: "exponent larger than ${max_exponent.to_str()}", pos: start })
			}
		}
		$p = $p + 1
	}
	Ok({})
}

is_number_char = |b| is_ident_char(b) or b == '-' or b == '+' or b == '.'

# ── strings ──────────────────────────────────────────────────

## Raw bidirectional controls (U+202A–U+202E, U+2066–U+2069, "Trojan Source")
## are not allowed outside escapes. In UTF-8: E2 80 AA–AE and E2 81 A6–A9.
bidi_at : List(U8), U64 -> Bool
bidi_at = |src, p|
	if at(src, p) != 0xE2 {
		False
	} else {
		b1 = at(src, p + 1)
		b2 = at(src, p + 2)
		(b1 == 0x80 and b2 >= 0xAA and b2 <= 0xAE) or (b1 == 0x81 and b2 >= 0xA6 and b2 <= 0xA9)
	}

## Raw control characters (C0, DEL, C1: U+0000–U+001F, U+007F, U+0080–U+009F)
## are allowed outside escapes only as tab and line breaks, where the grammar
## says. In UTF-8, C1 is C2 80–9F.
control_at : List(U8), U64 -> Bool
control_at = |src, p| {
	c = at(src, p)
	c < 0x20 or c == 0x7F or (c == 0xC2 and at(src, p + 1) >= 0x80 and at(src, p + 1) <= 0x9F)
}

## A control character that is allowed in comments: tab, LF, and CR before LF.
comment_control_ok : List(U8), U64 -> Bool
comment_control_ok = |src, p| {
	c = at(src, p)
	c == '\t' or c == '\n' or (c == '\r' and at(src, p + 1) == '\n')
}

control_error : U64, Str -> Fail
control_error = |pos, place| { reason: "raw control character in ${place} (write it as an escape, e.g. \\u{1B})", pos }

bidi_error : U64 -> Fail
bidi_error = |pos| { reason: "raw bidirectional control character (write it as an escape, e.g. \\u{202E})", pos }

check_string_length : List(U8), U64 -> Try({}, Fail)
check_string_length = |bytes, open| {
	# Count code points: every byte that isn't a UTF-8 continuation byte.
	chars = bytes.keep_if(|b| b < 0x80 or b >= 0xC0).len()
	if chars > max_string_length {
		Err({ reason: "string longer than ${max_string_length.to_str()} characters", pos: open })
	} else {
		Ok({})
	}
}

parse_basic_string : List(U8), U64 -> Try((Str, U64), Fail)
parse_basic_string = |src, open| {
	var $out = []
	var $pos = open + 1
	while at(src, $pos) != '"' {
		if $pos >= src.len() {
			return Err({ reason: "unterminated string", pos: open })
		}
		c = at(src, $pos)
		if c == '\\' {
			(bytes, after) = read_escape(src, $pos)?
			$out = $out.concat(bytes)
			$pos = after
		} else if c == '\n' {
			return Err({ reason: "line break in string (use \\n or a \"\"\" block string)", pos: $pos })
		} else if c == '\t' {
			return Err({ reason: "raw tab in string (use \\t)", pos: $pos })
		} else if control_at(src, $pos) {
			return Err(control_error($pos, "string"))
		} else if bidi_at(src, $pos) {
			return Err(bidi_error($pos))
		} else {
			$out = $out.append(c)
			$pos = $pos + 1
		}
	}
	check_string_length($out, open)?
	Ok((bytes_to_str($out), $pos + 1))
}

## At a backslash. Returns the escaped bytes and the position after the escape.
read_escape : List(U8), U64 -> Try((List(U8), U64), Fail)
read_escape = |src, start| {
	e = at(src, start + 1)
	if e == '"' {
		Ok((['"'], start + 2))
	} else if e == '\\' {
		Ok((['\\'], start + 2))
	} else if e == 'n' {
		Ok((['\n'], start + 2))
	} else if e == 'r' {
		Ok((['\r'], start + 2))
	} else if e == 't' {
		Ok((['\t'], start + 2))
	} else if e == 'u' {
		bad = { reason: "invalid unicode escape: expected \\u{1-6 hex digits}", pos: start }
		if at(src, start + 2) != '{' {
			return Err(bad)
		}
		var $p = start + 3
		var $cp = 0
		while is_hex(at(src, $p)) and $p - (start + 3) < 6 {
			$cp = $cp * 16 + hex_value(at(src, $p))
			$p = $p + 1
		}
		if $p == start + 3 or at(src, $p) != '}' {
			return Err(bad)
		}
		if $cp > 0x10FFFF or ($cp >= 0xD800 and $cp <= 0xDFFF) {
			return Err({ reason: "\\u{${slice_str(src, start + 3, $p)}} is not a Unicode scalar value", pos: start })
		}
		Ok((utf8_encode($cp), $p + 1))
	} else {
		Err({ reason: "invalid escape '\\${byte_str(e)}'", pos: start })
	}
}

parse_block_string : List(U8), U64 -> Try((Str, U64), Fail)
parse_block_string = |src, open| {
	var $p = open + 3
	while at(src, $p) == ' ' or at(src, $p) == '\t' {
		$p = $p + 1
	}
	content_start =
		if starts_at(src, $p, "\r\n") {
			$p + 2
		} else if at(src, $p) == '\n' {
			$p + 1
		} else {
			return Err({ reason: "opening \"\"\" must be followed by a line break", pos: if ($p >= src.len()) open else $p })
		}

	# Find the closing """, skipping escaped characters.
	var $i = content_start
	var $close = src.len()
	while $i < src.len() {
		if at(src, $i) == '\\' {
			$i = $i + 2
		} else if starts_at(src, $i, "\"\"\"") {
			$close = $i
			$i = src.len()
		} else {
			$i = $i + 1
		}
	}
	if $close == src.len() {
		return Err({ reason: "unterminated block string", pos: open })
	}

	# Lines as (start, end) ranges; CR before LF is dropped.
	var $lines = []
	var $line_start = content_start
	var $j = content_start
	while $j < $close {
		if at(src, $j) == '\n' {
			end = if ($j > $line_start and at(src, $j - 1) == '\r') $j - 1 else $j
			$lines = $lines.append(($line_start, end))
			$line_start = $j + 1
		}
		$j = $j + 1
	}
	indent_bytes = src.sublist({ start: $line_start, len: $close - $line_start })
	if !is_blank(indent_bytes) {
		return Err({ reason: "closing \"\"\" must be on its own line", pos: $close })
	}
	indent_len = indent_bytes.len()

	var $out = []
	var $first = True
	for (s, e) in $lines {
		line = src.sublist({ start: s, len: e - s })
		decoded =
			if line.starts_with(indent_bytes) {
				decode_block_line(src, s + indent_len, e)?
			} else if is_blank(line) {
				[]
			} else {
				return Err({ reason: "line is indented less than the closing \"\"\"", pos: s })
			}
		$out = if ($first) $out.concat(decoded) else $out.append('\n').concat(decoded)
		$first = False
	}
	check_string_length($out, open)?
	Ok((bytes_to_str($out), $close + 3))
}

decode_block_line : List(U8), U64, U64 -> Try(List(U8), Fail)
decode_block_line = |src, start, end| {
	var $out = []
	var $p = start
	while $p < end {
		c = at(src, $p)
		if c == '\\' {
			(bytes, after) = read_escape(src, $p)?
			$out = $out.concat(bytes)
			$p = after
		} else if c != '\t' and control_at(src, $p) {
			return Err(control_error($p, "block string"))
		} else if bidi_at(src, $p) {
			return Err(bidi_error($p))
		} else {
			$out = $out.append(c)
			$p = $p + 1
		}
	}
	Ok($out)
}

# ── byte strings ─────────────────────────────────────────

## `x"9f86 d081"`: two hex digits per byte, spaces and tabs between bytes.
parse_bytes_literal : List(U8), U64 -> Try((List(U8), U64), Fail)
parse_bytes_literal = |src, start| {
	open = start + 1
	var $out = []
	var $pos = open + 1
	while at(src, $pos) != '"' {
		c = at(src, $pos)
		if $pos >= src.len() {
			return Err({ reason: "unterminated byte string", pos: start })
		} else if c == ' ' or c == '\t' {
			$pos = $pos + 1
		} else if c == '\n' or c == '\r' {
			return Err({ reason: "line break in byte string", pos: $pos })
		} else if is_hex(c) {
			d = at(src, $pos + 1)
			if !is_hex(d) {
				return Err({ reason: "incomplete byte in byte string: two hex digits per byte", pos: $pos })
			}
			$out = $out.append((hex_value(c) * 16 + hex_value(d)).to_u8_wrap())
			$pos = $pos + 2
		} else {
			return Err({ reason: "invalid character ${describe(src, $pos)} in byte string (only hex digits, spaces and tabs)", pos: $pos })
		}
	}
	# Same limit as strings, counted over the literal's characters (all ASCII).
	if $pos - (open + 1) > max_string_length {
		return Err({ reason: "byte string longer than ${max_string_length.to_str()} characters", pos: start })
	}
	Ok(($out, $pos + 1))
}

hex_lower : List(U8) -> Str
hex_lower = |bytes| {
	digits = "0123456789abcdef".to_utf8()
	var $out = []
	for b in bytes {
		$out = $out.append(at(digits, (b // 16).to_u64())).append(at(digits, (b % 16).to_u64()))
	}
	bytes_to_str($out)
}

# ── trivia ───────────────────────────────────────────────────

skip_trivia : List(U8), U64 -> Try(U64, Fail)
skip_trivia = |src, start| {
	var $p = start
	var $go = True
	while $go {
		c = at(src, $p)
		if c == ' ' or c == '\t' or c == '\n' {
			$p = $p + 1
		} else if c == '\r' and at(src, $p + 1) == '\n' {
			$p = $p + 2
		} else if c == '\r' {
			return Err({ reason: "carriage return without a line feed (line breaks are LF or CRLF)", pos: $p })
		} else if c == '/' and at(src, $p + 1) == '/' {
			while $p < src.len() and at(src, $p) != '\n' {
				if bidi_at(src, $p) {
					return Err(bidi_error($p))
				}
				if control_at(src, $p) and !comment_control_ok(src, $p) {
					return Err(control_error($p, "comment"))
				}
				$p = $p + 1
			}
		} else if c == '/' and at(src, $p + 1) == '*' {
			$p = skip_block_comment(src, $p)?
		} else if c == '/' {
			return Err({ reason: "unexpected '/' (comments are // or /* */)", pos: $p })
		} else {
			$go = False
		}
	}
	Ok($p)
}

skip_block_comment : List(U8), U64 -> Try(U64, Fail)
skip_block_comment = |src, open| {
	var $depth = 0
	var $p = open
	while $p < src.len() {
		if starts_at(src, $p, "/*") {
			$depth = $depth + 1
			$p = $p + 2
		} else if starts_at(src, $p, "*/") {
			$depth = $depth - 1
			$p = $p + 2
			if $depth == 0 {
				return Ok($p)
			}
		} else if bidi_at(src, $p) {
			return Err(bidi_error($p))
		} else if control_at(src, $p) and !comment_control_ok(src, $p) {
			return Err(control_error($p, "comment"))
		} else {
			$p = $p + 1
		}
	}
	Err({ reason: "unterminated block comment", pos: open })
}

# ── helpers ──────────────────────────────────────────────────

reverse : List(a) -> List(a)
reverse = |list| {
	var $out = []
	for x in list {
		$out = [x].concat($out)
	}
	$out
}

## The byte at `pos`, or 0 past the end (0 never matches anything we look for).
at : List(U8), U64 -> U8
at = |src, pos| match src.get(pos) {
	Ok(b) => b
	Err(_) => 0
}

starts_at : List(U8), U64, Str -> Bool
starts_at = |src, pos, prefix| {
	bytes = prefix.to_utf8()
	src.sublist({ start: pos, len: bytes.len() }) == bytes
}

read_ident : List(U8), U64 -> (Str, U64)
read_ident = |src, start| {
	var $p = start
	while is_ident_char(at(src, $p)) {
		$p = $p + 1
	}
	(slice_str(src, start, $p), $p)
}

is_digit = |b| b >= '0' and b <= '9'

is_nonzero_digit = |b| b >= '1' and b <= '9'

is_upper = |b| b >= 'A' and b <= 'Z'

is_lower_start = |b| (b >= 'a' and b <= 'z') or b == '_'

is_ident_char = |b| is_digit(b) or is_upper(b) or is_lower_start(b)

is_hex = |b| is_digit(b) or (b >= 'a' and b <= 'f') or (b >= 'A' and b <= 'F')

is_blank = |bytes| bytes.all(|b| b == ' ' or b == '\t')

hex_value : U8 -> U64
hex_value = |b|
	if b >= 'a' {
		(b - 'a').to_u64() + 10
	} else if b >= 'A' {
		(b - 'A').to_u64() + 10
	} else {
		(b - '0').to_u64()
	}

utf8_encode : U64 -> List(U8)
utf8_encode = |cp|
	if cp < 0x80 {
		[cp.to_u8_wrap()]
	} else if cp < 0x800 {
		[(0xC0 + cp // 64).to_u8_wrap(), (0x80 + cp % 64).to_u8_wrap()]
	} else if cp < 0x10000 {
		[(0xE0 + cp // 4096).to_u8_wrap(), (0x80 + (cp // 64) % 64).to_u8_wrap(), (0x80 + cp % 64).to_u8_wrap()]
	} else {
		[
			(0xF0 + cp // 262144).to_u8_wrap(),
			(0x80 + (cp // 4096) % 64).to_u8_wrap(),
			(0x80 + (cp // 64) % 64).to_u8_wrap(),
			(0x80 + cp % 64).to_u8_wrap(),
		]
	}

bytes_to_str : List(U8) -> Str
bytes_to_str = |bytes| match Str.from_utf8(bytes) {
	Ok(s) => s
	Err(_) => "" # unreachable: input is valid UTF-8 and escapes are encoded correctly
}

slice_str : List(U8), U64, U64 -> Str
slice_str = |src, start, end| bytes_to_str(src.sublist({ start, len: end - start }))

byte_str : U8 -> Str
byte_str = |b| bytes_to_str([b])

describe : List(U8), U64 -> Str
describe = |src, pos|
	if pos >= src.len() {
		"end of input"
	} else if at(src, pos) == '\n' {
		"line break"
	} else {
		"'${byte_str(at(src, pos))}'"
	}

## Line and column (1-based, in code points) of a byte position.
locate : List(U8), Fail -> ParseError
locate = |src, { reason, pos }| {
	var $line = 1
	var $column = 1
	for b in src.sublist({ start: 0, len: pos }) {
		if b == '\n' {
			$line = $line + 1
			$column = 1
		} else if b < 0x80 or b >= 0xC0 {
			$column = $column + 1
		}
	}
	{ reason, line: $line, column: $column }
}

json_str : Str -> Str
json_str = |s| {
	var $out = ['"']
	for b in s.to_utf8() {
		$out =
			if b == '"' {
				$out.concat(['\\', '"'])
			} else if b == '\\' {
				$out.concat(['\\', '\\'])
			} else if b == '\n' {
				$out.concat(['\\', 'n'])
			} else if b == '\r' {
				$out.concat(['\\', 'r'])
			} else if b == '\t' {
				$out.concat(['\\', 't'])
			} else if b < 0x20 {
				# Other C0 controls as JSON writes them: \u001b
				$out.concat(['\\', 'u', '0', '0', hex_digit(b // 16), hex_digit(b % 16)])
			} else {
				$out.append(b)
			}
	}
	bytes_to_str($out.append('"'))
}

hex_digit : U8 -> U8
hex_digit = |n| if n < 10 '0' + n else 'a' + n - 10
