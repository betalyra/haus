## The std/time fuzzing runner (../../fuzz/README.md): `time_runner FILE`
## reads lines `TYPE HEX` (the text as hex-encoded UTF-8) and prints one line
## each: `ok` if the text is a valid value of the std/time type, `no` if not.
app [main!] {
	haus: "../package/main.roc",
	pf: platform "https://github.com/roc-lang/basic-cli/releases/download/0.26.0/GddgvsGjiNXrHFW6au5i5dUDbTs8FinQdrgE2Gqmw53t.tar.zst",
}

import pf.OsStr
import pf.Path
import pf.Stdout
import haus.Time

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
			Stdout.line!(check($line))?
			$line = []
		} else {
			$line = $line.append(b)
		}
	}
	Ok({})
}

## One line: `TYPE HEX`.
check : List(U8) -> Str
check = |line| {
	var $space = 0
	while $space < line.len() and at(line, $space) != ' ' {
		$space = $space + 1
	}
	name = match Str.from_utf8(line.sublist({ start: 0, len: $space })) {
		Ok(s) => s
		Err(_) => ""
	}
	hex = line.sublist({ start: $space + 1, len: line.len() - $space - 1 })
	var $text = []
	var $i = 0
	while $i + 1 < hex.len() {
		$text = $text.append(nibble(at(hex, $i)) * 16 + nibble(at(hex, $i + 1)))
		$i = $i + 2
	}
	match Str.from_utf8($text) {
		Ok(text) => match Time.check(name, text) {
			Ok({}) => "ok"
			Err(_) => "no"
		}
		Err(_) => "err invalid UTF-8"
	}
}

nibble : U8 -> U8
nibble = |c| if c >= 'a' c - 'a' + 10 else c - '0'

at : List(U8), U64 -> U8
at = |s, i| match s.get(i) {
	Ok(b) => b
	Err(_) => 0
}
