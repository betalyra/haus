## A codec (spec §13.4) for `std/time#Date`: `Date("2026-11-09")` ↔
## `{ year: 2026, month: 11, day: 9 }`. The std/time profile has already
## checked the text, so decoding can't fail.
CivilDate := [].{
	Target : { year : U64, month : U64, day : U64 }

	decode : Str -> Try(Target, Str)
	decode = |text| {
		b = text.to_utf8()
		Ok({ year: number(b, 0, 4), month: number(b, 5, 2), day: number(b, 8, 2) })
	}

	encode : Target -> Str
	encode = |{ year, month, day }| "${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}"

	## `Monday` for 2026-11-09 (Sakamoto's method).
	weekday : Target -> Str
	weekday = |{ year, month, day }| {
		offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
		y = if (month < 3) year - 1 else year
		offset = offsets.get(month - 1) ?? 0
		names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
		names.get((y + y // 4 - y // 100 + y // 400 + offset + day) % 7) ?? "?"
	}
}

number : List(U8), U64, U64 -> U64
number = |b, start, len| {
	var $n = 0
	for d in b.sublist({ start, len }) {
		$n = $n * 10 + (d - '0').to_u64()
	}
	$n
}

pad : U64, U64 -> Str
pad = |n, width| {
	digits = n.to_str()
	missing = if (digits.to_utf8().len() < width) width - digits.to_utf8().len() else 0
	"${Str.join_with(List.repeat("0", missing), "")}${digits}"
}
