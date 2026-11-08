## Runnable version of the showcase: `roc run.roc`
app [main!] {
	haus: "../../package/main.roc",
	pf: platform "https://github.com/roc-lang/basic-cli/releases/download/0.26.0/GddgvsGjiNXrHFW6au5i5dUDbTs8FinQdrgE2Gqmw53t.tar.zst",
}

import pf.OsStr
import pf.Path
import pf.Stdout
import haus.Decode
import Shop

main! : List(OsStr) => Try({}, _)
main! = |_args| {
	# Read at runtime (an embedded `import "…" as … : Str` would be evaluated at compile time).
	stream_path : Path
	stream_path = "../../../examples/events.haus"
	stream_src = stream_path.read_utf8!()?

	Stdout.line!("── examples/events.haus, server view (user events, rest is Unknown)")?
	match Decode.all(stream_src, Shop.decode_user_event) {
		Ok(events) =>
			for event in events {
				line = match event {
					Unknown(tag) => "(ignoring unknown event ${tag})"
					_ => Shop.describe_user(event)
				}
				Stdout.line!("  ${line}")?
			}
		Err(error) => Stdout.line!("  ${describe_error(error)}")?
	}

	Stdout.line!("\n── same stream, analytics view (all events)")?
	match Decode.all(stream_src, Shop.decode_app_event) {
		Ok(events) =>
			for event in events {
				line = match event {
					PaymentReceived({ id, amount, .. }) => "payment from user ${id.to_str()}: ${amount.amount} ${amount.currency}"
					Heartbeat => "heartbeat"
					Unknown(tag) => "(ignoring unknown event ${tag})"
					_ => Shop.describe_user(event)
				}
				Stdout.line!("  ${line}")?
			}
		Err(error) => Stdout.line!("  ${describe_error(error)}")?
	}

	Stdout.line!("\n── failures")?
	broken = [
		"UserCreated { id: 1, at: Instant(\"2026-11-07T10:00:00Z\") },",
		"Heartbeat, UserRenamed { id: \"42\" },",
		"{ ok: true }",
	]
	for text in broken {
		match Decode.all(text, Shop.decode_user_event) {
			Ok(_) => Stdout.line!("  unexpectedly OK")?
			Err(error) => Stdout.line!("  ${describe_error(error)}")?
		}
	}

	Ok({})
}

describe_error = |error| match error {
	Syntax({ reason, line, column }) => "syntax error: ${reason} at ${line.to_str()}:${column.to_str()}"
	Decode({ reason, path }) => "decode error: ${reason} at ${path}"
}
