## A codec (spec §13.4) for `@haus/money@1#Money`: integer cents, as payment
## APIs want them. `Money(44.40, EUR)` ↔ `{ cents: 4440, currency: "EUR" }`.
## More than 2 decimal places, or a currency that isn't ISO-shaped, is an error.
import money.HausMoney

Cents := [].{
	Target : { cents : I128, currency : Str }

	decode : HausMoney.Money -> Try(Target, Str)
	decode = |money| match money {
		Money(amount, currency) => Ok({ cents: to_cents(amount)?, currency: iso(currency)? })
	}

	encode : Target -> HausMoney.Money
	encode = |{ cents, currency }| Money(from_cents(cents), Bare(currency))
}

## The @haus/money iso profile: a currency is three letters A–Z.
iso : HausMoney.Currency -> Try(Str, Str)
iso = |currency| match currency {
	Bare(code) if code.to_utf8().len() == 3 and code.to_utf8().all(|b| b >= 'A' and b <= 'Z') => Ok(code)
	Bare(code) => Err("${code} is not a currency: three letters A–Z (ISO 4217)")
	Other(tag, _) => Err("${tag}(…) is not a currency: three letters A–Z (ISO 4217)")
}

## `44.40` → 4440. Trailing zeros don't count: `19.900` is fine, `19.999` isn't.
to_cents : Str -> Try(I128, Str)
to_cents = |amount| {
	var $int = []
	var $frac = []
	var $after_dot = False
	for b in amount.to_utf8() {
		if b == '.' {
			$after_dot = True
		} else if $after_dot {
			$frac = $frac.append(b)
		} else {
			$int = $int.append(b)
		}
	}
	while $frac.len() > 2 and $frac.sublist({ start: $frac.len() - 1, len: 1 }) == ['0'] {
		$frac = $frac.sublist({ start: 0, len: $frac.len() - 1 })
	}
	if $frac.len() > 2 {
		return Err("${amount} has more than 2 decimal places")
	}
	digits = $int.concat($frac).concat(List.repeat('0', 2 - $frac.len()))
	match Str.from_utf8(digits) {
		Ok(text) => I128.from_str(text).map_err(|_| "${amount} is not an amount of cents")
		Err(_) => Err("${amount} is not an amount of cents")
	}
}

## 4440 → `44.40`.
from_cents : I128 -> Str
from_cents = |cents| {
	sign = if (cents < 0) "-" else ""
	magnitude = if (cents < 0) -cents else cents
	digits = magnitude.to_str().to_utf8()
	padded = List.repeat('0', if (digits.len() < 3) 3 - digits.len() else 0).concat(digits)
	split = padded.len() - 2
	whole = Str.from_utf8(padded.sublist({ start: 0, len: split })) ?? "0"
	fraction = Str.from_utf8(padded.sublist({ start: split, len: 2 })) ?? "00"
	"${sign}${whole}.${fraction}"
}
