## The Roc runner of the schema fuzzer (../README.md): `schema_runner FILE`
## reads lines `SUITE TYPE HEX` (a value's haus text as hex-encoded UTF-8),
## decodes the value with the type of the suite's schema (the modules that
## gen_schemas.ts generates), encodes the result, and prints one line each:
## `ok <canonical form>` or `err <reason>`.
app [main!] {
	haus: "../../roc/package/main.roc",
	schemas: "../.build/roc-schema/main.roc",
	pf: platform "https://github.com/roc-lang/basic-cli/releases/download/0.26.0/GddgvsGjiNXrHFW6au5i5dUDbTs8FinQdrgE2Gqmw53t.tar.zst",
}

import pf.OsStr
import pf.Path
import pf.Stdout
import haus.Value
import haus.Decode
import haus.Encode
import schemas.Schemas

main! : List(OsStr) => Try({}, _)
main! = |args| {
	file = match args.map(|a| OsStr.to_str_try(a) ?? "") {
		[f] => f
		_ => ""
	}
	path : Path
	path = "${file}"
	bytes = path.read_bytes!()?
	var $line = []
	for b in bytes {
		if b == '\n' {
			Stdout.line!(run($line))?
			$line = []
		} else {
			$line = $line.append(b)
		}
	}
	Ok({})
}

## One line: `SUITE TYPE HEX`.
run : List(U8) -> Str
run = |line| {
	first = space(line, 0)
	second = space(line, first + 1)
	suite = text(line.sublist({ start: 0, len: first }))
	ty = text(line.sublist({ start: first + 1, len: second - first - 1 }))
	hex = line.sublist({ start: second + 1, len: line.len() - second - 1 })
	var $bytes = []
	var $i = 0
	while $i + 1 < hex.len() {
		$bytes = $bytes.append(nibble(at(hex, $i)) * 16 + nibble(at(hex, $i + 1)))
		$i = $i + 2
	}
	match Str.from_utf8($bytes) {
		Ok(input) => match Value.parse_all(input) {
			Ok([v]) => match Schemas.roundtrip(suite, ty, v) {
				Decoded(Ok(encoded)) => "ok ${Encode.canonical(encoded)}"
				Decoded(Err(e)) => "err ${Decode.message(e)}"
				NoType => "crash no type ${suite}.${ty}"
			}
			_ => "err $ not a single value"
		}
		Err(_) => "err $ invalid UTF-8"
	}
}

## The index of the next space from `from`, or the end.
space : List(U8), U64 -> U64
space = |line, from| {
	var $at = from
	while $at < line.len() and at(line, $at) != ' ' {
		$at = $at + 1
	}
	$at
}

text : List(U8) -> Str
text = |bs| match Str.from_utf8(bs) {
	Ok(s) => s
	Err(_) => ""
}

nibble : U8 -> U8
nibble = |c| if c >= 'a' c - 'a' + 10 else c - '0'

at : List(U8), U64 -> U8
at = |s, i| match s.get(i) {
	Ok(b) => b
	Err(_) => 0
}
