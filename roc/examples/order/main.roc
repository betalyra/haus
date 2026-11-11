## The same order, decoded with the schema's own types (Order.roc) and with
## the app's codecs (Typed.roc: generated with --codec, see ../gen.sh). The
## same steps as the TypeScript and Rust order examples, on the same files.
## Run from this folder: roc main.roc
app [main!] {
	haus: "../../package/main.roc",
	money: "../../../extensions/money/roc/main.roc",
	geo: "../../../extensions/geo/roc/main.roc",
	pf: platform "https://github.com/roc-lang/basic-cli/releases/download/0.26.0/GddgvsGjiNXrHFW6au5i5dUDbTs8FinQdrgE2Gqmw53t.tar.zst",
}

import pf.OsStr
import pf.Path
import pf.Stdout
import haus.Decode
import haus.Encode
import CivilDate
import Order
import Typed

main! : List(OsStr) => Try({}, _)
main! = |_args| {
	path : Path
	path = "../../../examples/order.haus"
	text = path.read_utf8!()?

	# Without codecs: Money is Money(Str, Currency).
	plain = Decode.one(text, Order.decode_root)?
	Stdout.line!(describe_plain(plain))?

	# With codecs: the fields have the codecs' types.
	typed = Decode.one(text, Typed.decode_root)?
	(lng, lat) = typed.deliver_to
	Stdout.line!("typed:  ${user(typed.customer)} pays ${typed.total.cents.to_str()} cents, deliver to [lng, lat] [${lng.to_str()}, ${lat.to_str()}]")?
	Stdout.line!("placed: ${CivilDate.encode(typed.placed)}, a ${CivilDate.weekday(typed.placed)}")?

	# Variants are tag unions: match on them.
	Stdout.line!(status(typed.status))?

	# Encoding with the same codecs gives back the same haus text.
	Stdout.line!(Encode.to_str(Typed.encode_root(typed)))?

	# Codecs add rules on top of the schema's: Eur is a valid tag, but not ISO-shaped.
	eur = text.replace_first("EUR", "Eur")
	Stdout.line!(outcome("Eur without codecs", Decode.one(eur, Order.decode_root)))?
	Stdout.line!(outcome("Eur with codecs", Decode.one(eur, Typed.decode_root)))?
	Stdout.line!(outcome("44.405 with codecs", Decode.one(text.replace_first("44.40", "44.405"), Typed.decode_root)))?
	Ok({})
}

describe_plain : Order.Root -> Str
describe_plain = |order| {
	customer = match order.customer {
		UserId(id) => id
	}
	match order.total {
		Money(amount, Bare(currency)) => "plain:  ${customer} pays ${amount} ${currency}"
		Money(amount, Other(tag, _)) => "plain:  ${customer} pays ${amount} ${tag}(…)"
	}
}

user : Typed.UserId -> Str
user = |id| match id {
	UserId(name) => name
}

status : Typed.Status -> Str
status = |s| match s {
	Shipped({ tracking }) => "status: shipped, tracking ${tracking}"
	Pending | Cancelled => "status: not on its way"
}

outcome : Str, Try(a, [Decode(Decode.Error), Syntax({ reason : Str, line : U64, column : U64 })]) -> Str
outcome = |what, result| match result {
	Ok(_) => "${what}: accepted"
	Err(Decode(e)) => "${what}: ${Decode.message(e)}"
	Err(Syntax({ reason, .. })) => "${what}: ${reason}"
}
