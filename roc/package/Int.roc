## `Int`: an integer of any size (prelude), kept as its decimal digits, like
## `haus::Int` in Rust and `bigint` in TypeScript. Writing it gives the same
## digits back.
##
## Convert it with `to_i64` / `to_i128`, which fail when the value doesn't fit.
## For a native integer that must fit, the schema says `Int64` (decoded as an
## `I64`, out of range is a decode error).
##
##     n = Int.from_str("340282366920938463463374607431768211457")?
##     n.to_i128()   # Err(OutOfRange)
##     n.to_str()    # "340282366920938463463374607431768211457"
Int :: [Digits(Str)].{
	## A decimal integer: an optional `-` and digits. Leading zeros are dropped.
	from_str : Str -> Try(Int, [BadNumStr])
	from_str = |text| {
		negative = text.starts_with("-")
		digits = (if (negative) text.drop_prefix("-") else text).to_utf8()
		if digits.is_empty() or !digits.all(|b| b >= '0' and b <= '9') {
			return Err(BadNumStr)
		}
		var $start = 0
		while $start + 1 < digits.len() and digits.get($start) == Ok('0') {
			$start = $start + 1
		}
		rest = Str.from_utf8(digits.sublist({ start: $start, len: digits.len() - $start })) ?? "0"
		Ok(Digits(if (negative and rest != "0") "-${rest}" else rest))
	}

	from_i64 : I64 -> Int
	from_i64 = |n| Digits(n.to_str())

	from_i128 : I128 -> Int
	from_i128 = |n| Digits(n.to_str())

	## The decimal digits, with a `-` if negative.
	to_str : Int -> Str
	to_str = |n| match n {
		Digits(text) => text
	}

	## The value as an I64, if it fits.
	to_i64 : Int -> Try(I64, [OutOfRange])
	to_i64 = |n| I64.from_str(n.to_str()).map_err(|_| OutOfRange)

	## The value as an I128, if it fits.
	to_i128 : Int -> Try(I128, [OutOfRange])
	to_i128 = |n| I128.from_str(n.to_str()).map_err(|_| OutOfRange)

	is_eq : Int, Int -> Bool
	is_eq = |a, b| a.to_str() == b.to_str()
}

above_2_128 : Str
above_2_128 = "340282366920938463463374607431768211457"

expect Int.from_str(above_2_128).map_ok(|n| n.to_str()) == Ok(above_2_128)
expect Int.from_str(above_2_128).map_ok(|n| n.to_i128()) == Ok(Err(OutOfRange))
expect Int.from_str("-${above_2_128}").map_ok(|n| n.to_i64()) == Ok(Err(OutOfRange))
expect Int.from_str("-170141183460469231731687303715884105728").map_ok(|n| n.to_i128()) == Ok(Ok(-170141183460469231731687303715884105728))
expect Int.from_str("42").map_ok(|n| n.to_i64()) == Ok(Ok(42))
expect Int.from_str("007") == Ok(Int.from_i64(7))
expect Int.from_str("-0") == Ok(Int.from_i64(0))
expect Int.from_str("-000") == Ok(Int.from_i64(0))
expect Int.from_i128(-5).to_str() == "-5"
expect Int.from_str("1.5").is_err()
expect Int.from_str("-").is_err()
expect Int.from_str("").is_err()
expect Int.from_str("0x10").is_err()
