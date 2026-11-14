## Streams (spec §6): a file of values, each followed by a comma, read as
## the values arrive.
##
## The reader does no I/O: push chunks of bytes, split anywhere, and get
## every value that is complete. Memory holds the current value, not the
## stream. The same reader as the TypeScript and Rust bindings.
##
##     var $reader = Stream.reader({})
##     (next, values) = Stream.push($reader, chunk)?
##     $reader = next
##     …
##     last = Stream.finish($reader)?
import Value

Stream := [].{

	## A reader's state.
	Reader : {
		buf : List(U8),
		scanned : U64,
		chars : U64,
		mode : Mode,
		depth : U64,
		origin : Pos,
		started : Bool,
		options : Options,
	}

	## `max_value_length`: the most characters in one value (spec §7: 64 Mi).
	## `require_terminator`: a stream that ends without a comma after its last
	## value is reported as cut off (recommended for network streams).
	Options : { max_value_length : U64, require_terminator : Bool }

	defaults : Options
	defaults = { max_value_length: 64 * 1024 * 1024, require_terminator: False }

	reader : Options -> Reader
	reader = |options| {
		buf: [],
		scanned: 0,
		chars: 0,
		mode: Normal,
		depth: 0,
		origin: { line: 1, column: 1 },
		started: False,
		options,
	}

	## Add a chunk; returns the reader and the values the chunk completed.
	push : Reader, List(U8) -> Try((Reader, List(Value)), Value.ParseError)
	push = |state, chunk| {
		buf = state.buf.concat(chunk)
		if !state.started and buf.len() < 3 and [0xEF, 0xBB, 0xBF].starts_with(buf) {
			return Ok(({ ..state, buf }, [])) # maybe a byte order mark: wait for more
		}
		started =
			if !state.started and buf.starts_with([0xEF, 0xBB, 0xBF]) {
				# The byte order mark is column 1, as in the whole-text parser.
				{ ..state, buf: buf.drop_first(3), origin: { ..state.origin, column: 2 }, started: True }
			} else {
				{ ..state, buf, started: True }
			}
		scan(started, False)
	}

	## The input is complete: returns the last value, if it had no comma after it.
	finish : Reader -> Try(List(Value), Value.ParseError)
	finish = |state| {
		(rest, values) = scan(state, True)?
		text = utf8(rest.buf, rest.origin)?
		directive(text, rest.origin)?
		last = Value.parse_rest(text).map_err(|e| shift(e, rest.origin))?
		if !last.is_empty() and rest.options.require_terminator {
			end = after(rest.origin, rest.buf)
			return Err({ reason: "stream ended without ',' after the last value (truncated?)", line: end.line, column: end.column })
		}
		Ok(values.concat(last))
	}

	## Read a whole input given as chunks.
	all : List(List(U8)) -> Try(List(Value), Value.ParseError)
	all = |chunks| {
		var $state = reader(defaults)
		var $out = []
		for chunk in chunks {
			(next, values) = push($state, chunk)?
			$state = next
			$out = $out.concat(values)
		}
		Ok($out.concat(finish($state)?))
	}
}

## What the scanner is inside of. It only tracks what it needs to find the
## commas between values; the parser checks everything else.
Mode : [Normal, Text, Block, LineComment, Comment(U64)]

Pos : { line : U64, column : U64 }

## Finds the commas between values and parses what is before them.
scan : Stream.Reader, Bool -> Try((Stream.Reader, List(Value)), Value.ParseError)
scan = |start, last| {
	var $s = start
	var $out = []
	var $i = $s.scanned
	var $go = True
	while $go and $i < $s.buf.len() {
		if $s.chars > $s.options.max_value_length {
			return Err({ reason: "value longer than ${$s.options.max_value_length.to_str()} characters", line: $s.origin.line, column: $s.origin.column })
		}
		b = $s.buf
		c = at(b, $i)
		# `(last or $i + n < b.len())`: is the byte `n` places ahead there (or will it never come)?
		# `step` bytes are part of the value; 0: wait for more input; Cut: a comma between values.
		step = match $s.mode {
			Normal =>
				if c == '/' {
					if !(last or $i + 1 < b.len()) {
						Wait
					} else if at(b, $i + 1) == '/' {
						$s = { ..$s, mode: LineComment }
						Take(2)
					} else if at(b, $i + 1) == '*' {
						$s = { ..$s, mode: Comment(1) }
						Take(2)
					} else {
						Take(1)
					}
				} else if c == '"' {
					if !(last or $i + 2 < b.len()) {
						Wait
					} else if at(b, $i + 1) == '"' and at(b, $i + 2) == '"' {
						$s = { ..$s, mode: Block }
						Take(3)
					} else {
						$s = { ..$s, mode: Text }
						Take(1)
					}
				} else if c == '{' or c == '[' or c == '(' {
					$s = { ..$s, depth: $s.depth + 1 }
					Take(1)
				} else if c == '}' or c == ']' or c == ')' {
					if $s.depth == 0 {
						return Err(unbalanced($s, $i))
					}
					$s = { ..$s, depth: $s.depth - 1 }
					Take(1)
				} else if c == ',' and $s.depth == 0 {
					Cut
				} else {
					Take(1)
				}
			LineComment => {
				if c == '\n' {
					$s = { ..$s, mode: Normal }
				}
				Take(1)
			}
			Comment(depth) =>
				if (c == '/' or c == '*') and !(last or $i + 1 < b.len()) {
					Wait
				} else if c == '/' and at(b, $i + 1) == '*' {
					$s = { ..$s, mode: Comment(depth + 1) }
					Take(2)
				} else if c == '*' and at(b, $i + 1) == '/' {
					$s = { ..$s, mode: if (depth == 1) Normal else Comment(depth - 1) }
					Take(2)
				} else {
					Take(1)
				}
			Text =>
				if c == '\\' {
					if ((last or $i + 1 < b.len())) Take(2) else Wait
				} else if c == '"' or c == '\n' {
					# A line break can't be in a string: the parser reports it at the next cut.
					$s = { ..$s, mode: Normal }
					Take(1)
				} else {
					Take(1)
				}
			Block =>
				if c == '\\' {
					if ((last or $i + 1 < b.len())) Take(2) else Wait
				} else if c == '"' {
					if !(last or $i + 2 < b.len()) {
						Wait
					} else if at(b, $i + 1) == '"' and at(b, $i + 2) == '"' {
						$s = { ..$s, mode: Normal }
						Take(3)
					} else {
						Take(1)
					}
				} else {
					Take(1)
				}
		}
		match step {
			Wait => {
				$go = False
			}
			Cut => {
				(next, value) = cut($s, $i)?
				$s = next
				$out = $out.append(value)
				$i = 0
			}
			Take(n) => {
				end = if ($i + n > b.len()) b.len() else $i + n
				starts = b.sublist({ start: $i, len: end - $i }).keep_if(|x| x < 0x80 or x >= 0xC0).len()
				$s = { ..$s, chars: $s.chars + starts }
				$i = end
			}
		}
	}
	Ok(({ ..$s, scanned: $i }, $out))
}

## Parse the value before the comma at `comma`, and drop it from the buffer.
cut : Stream.Reader, U64 -> Try((Stream.Reader, Value), Value.ParseError)
cut = |s, comma| {
	piece = s.buf.sublist({ start: 0, len: comma })
	text = utf8(piece, s.origin)?
	directive(text, s.origin)?
	value = match Value.parse_rest(text) {
		Ok([v]) => v
		Ok([]) => {
			end = after(s.origin, piece)
			return Err({ reason: "expected a value, found ','", line: end.line, column: end.column })
		}
		Ok(_) => return Err({ reason: "expected ',' between top-level values", line: s.origin.line, column: s.origin.column })
		Err(e) => return Err(shift(e, s.origin))
	}
	origin = after(s.origin, piece.append(','))
	Ok(({ ..s, buf: s.buf.drop_first(comma + 1), scanned: 0, chars: 0, origin }, value))
}

## A closing bracket without an opening one: let the parser say what's wrong.
unbalanced : Stream.Reader, U64 -> Value.ParseError
unbalanced = |s, i| {
	piece = s.buf.sublist({ start: 0, len: i + 1 })
	match utf8(piece, s.origin) {
		Err(e) => e
		Ok(text) =>
			match Value.parse_rest(text) {
				Err(e) => shift(e, s.origin)
				Ok(_) => {
					end = after(s.origin, s.buf.sublist({ start: 0, len: i }))
					{ reason: "unexpected closing bracket", line: end.line, column: end.column }
				}
			}
	}
}

## A version directive at the start of the stream (spec §10): `#haus 2`.
## The first value starts at column 1, or 2 after a byte order mark; any
## later one after at least a value and a comma.
directive : Str, Pos -> Try({}, Value.ParseError)
directive = |text, origin|
	if origin.line == 1 and origin.column <= 2 and Value.starts_with_directive(text) {
		Err({ reason: Value.newer_version_reason, line: origin.line, column: origin.column })
	} else {
		Ok({})
	}

utf8 : List(U8), Pos -> Try(Str, Value.ParseError)
utf8 = |bytes, origin| match Str.from_utf8(bytes) {
	Ok(text) => Ok(text)
	Err(_) => Err({ reason: "invalid UTF-8", line: origin.line, column: origin.column })
}

## An error in a piece that starts at `origin` of the whole input.
shift : Value.ParseError, Pos -> Value.ParseError
shift = |e, origin| {
	reason: e.reason,
	line: origin.line + e.line - 1,
	column: if (e.line == 1) origin.column + e.column - 1 else e.column,
}

## Where the input is after `bytes`, starting at `origin`.
after : Pos, List(U8) -> Pos
after = |origin, bytes| {
	var $p = origin
	for b in bytes {
		if b == '\n' {
			$p = { line: $p.line + 1, column: 1 }
		} else if b < 0x80 or b >= 0xC0 {
			$p = { ..$p, column: $p.column + 1 }
		}
	}
	$p
}

at : List(U8), U64 -> U8
at = |s, i| match s.get(i) {
	Ok(b) => b
	Err(_) => 0
}

# ── tests ────────────────────────────────────────────────────

## All values of `text`, pushed in chunks of `size` bytes.
chunked : Str, U64 -> Try(List(Value), Value.ParseError)
chunked = |text, size| {
	bytes = text.to_utf8()
	var $chunks = []
	var $i = 0
	while $i < bytes.len() {
		$chunks = $chunks.append(bytes.sublist({ start: $i, len: size }))
		$i = $i + size
	}
	Stream.all($chunks)
}

expect {
	text = "UserCreated { id: 1 },\nHeartbeat,\n\"a,b\", /* , */ Pair(1, 2), // ,\n\"\"\"\n  x,\n  \"\"\",\n\"Olá 😀\""
	json = |r| r.map_ok(|values| values.map(Value.to_test_json))
	whole = json(Value.parse_all(text))
	[1, 2, 3, 5, 7, 1000].all(|size| json(chunked(text, size)) == whole)
}

# Each value as soon as its comma arrives.
# Comments between values: commas, brackets and quotes inside them don't cut.
expect {
	text = "// header, with a comma\nA { x: 1 }, // after A, [unbalanced\n/* block, with } and \" and /* nested, */ */\nB(2),\n\n// before C\nC { s: \"// not a comment\" } /* before the comma */ ,\n// trailing comment, {"
	json = |r| r.map_ok(|values| values.map(Value.to_test_json))
	whole = json(Value.parse_all(text))
	whole.map_ok(|vs| vs.len()) == Ok(3) and [1, 2, 3, 4, 5, 7, 11, 1000].all(|size| json(chunked(text, size)) == whole)
}

expect {
	s0 = Stream.reader(Stream.defaults)
	match Stream.push(s0, "UserCreated { id: 1 ".to_utf8()) {
		Ok((s1, [])) =>
			match Stream.push(s1, "},\nHeart".to_utf8()) {
				Ok((s2, [_])) => Stream.finish(s2).map_ok(|vs| vs.map(Value.to_test_json)) == Ok(["{\"tag\":\"Heart\"}"])
				_ => False
			}
		_ => False
	}
}

# Positions in the whole stream.
expect {
	match Stream.push(Stream.reader(Stream.defaults), "A,\nB,\n{ ok: true },".to_utf8()) {
		Err({ line: 3, column: 7, .. }) => True
		_ => False
	}
}

expect {
	options = { ..Stream.defaults, require_terminator: True }
	match Stream.push(Stream.reader(options), "1000,\n100".to_utf8()) {
		Ok((s, [_])) =>
			match Stream.finish(s) {
				Err({ reason, .. }) => reason.contains("truncated")
				_ => False
			}
		_ => False
	}
}

expect {
	options = { ..Stream.defaults, max_value_length: 100 }
	bytes = "[".to_utf8().concat(List.repeat("1, ".to_utf8(), 100).join())
	match Stream.push(Stream.reader(options), bytes) {
		Err({ reason, .. }) => reason.contains("value longer than 100")
		_ => False
	}
}

expect chunked("1,, 2,", 1).is_err()
expect chunked("[1, 2,", 2).is_err()
expect chunked("1 ] 2,", 1).is_err()

# A byte order mark is skipped only at the start of the stream, not after a comma (found by fuzz/).
expect {
	Stream.all(["A,\u(FEFF)".to_utf8()]).is_err() and Stream.all(["\u(FEFF)A, B".to_utf8()]).is_ok()
}

# Positions after a byte order mark are the whole-text parser's (design review S18):
# the reader skipped it without counting it, so columns on line 1 were one too small.
expect {
	same = |text| match (Value.parse_all(text), chunked(text, 1000)) {
		(Err(whole), Err(e)) => whole.line == 1 and e.line == whole.line and e.column == whole.column
		_ => False
	}
	same("\u(FEFF){ ok: true }") and same("\u(FEFF)\u(001B)") and same("\u(FEFF)\",x")
}

# A version directive at the start (spec §10) needs a newer version of haus.
expect Stream.all(["#haus 2\n1,\n2,\n".to_utf8()]).map_ok(|vs| vs.len()).map_err(|e| e.reason) == Err("the file starts with a version directive (#haus): it needs a newer version of haus")
expect Stream.all(["\u(FEFF)#ha".to_utf8(), "us 2\n1,\n".to_utf8()]).map_ok(|vs| vs.len()).map_err(|e| (e.reason, e.column)) == Err(("the file starts with a version directive (#haus): it needs a newer version of haus", 2))
expect Stream.all(["1,\n#haus 2,\n".to_utf8()]).map_ok(|vs| vs.len()).map_err(|e| e.reason) == Err("expected a value, found '#'")
