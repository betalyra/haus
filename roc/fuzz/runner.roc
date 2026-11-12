## The fuzzing runner (../../fuzz/README.md): `runner DIR N` parses DIR/00000.haus …
## DIR/{N-1}.haus and prints one line each: `ok <values>` in the test-suite
## JSON encoding, or `err <line> <column> <reason>`.
app [main!] {
	haus: "../package/main.roc",
	pf: platform "https://github.com/roc-lang/basic-cli/releases/download/0.26.0/GddgvsGjiNXrHFW6au5i5dUDbTs8FinQdrgE2Gqmw53t.tar.zst",
}

import pf.OsStr
import pf.Path
import pf.Stdout
import haus.Value

main! : List(OsStr) => Try({}, _)
main! = |args| {
	(dir, n) = match args.map(|a| OsStr.to_str_try(a) ?? "") {
		[d, count] => (d, U64.from_str(count) ?? 0)
		_ => ("", 0)
	}
	var $i = 0
	while $i < n {
		path : Path
		path = "${dir}/${pad($i)}.haus"
		bytes = path.read_bytes!()?
		Stdout.line!(line(bytes))?
		$i = $i + 1
	}
	Ok({})
}

line : List(U8) -> Str
line = |bytes| match Value.parse_bytes(bytes) {
	Ok(values) => "ok [${Str.join_with(values.map(Value.to_test_json), ",")}]"
	# One line per case: line breaks in the reason are written as \n.
	Err({ reason, line: l, column }) => "err ${l.to_str()} ${column.to_str()} ${reason.replace_each("\r", "\\r").replace_each("\n", "\\n")}"
}

## 7 → "00007"
pad : U64 -> Str
pad = |i| {
	s = i.to_str()
	"${Str.repeat("0", 5 - s.count_utf8_bytes())}${s}"
}
