## Showcase: decoding haus data into Roc's structural types.
##
## haus variants map to Roc tag unions and haus records to Roc records. Both
## are structural in Roc, like in haus, so no class or wrapper declarations
## are needed: a tag union type is just the set of tags.
import haus.Value
import haus.Decode
import "../../../examples/stream.haus" as stream_src : Str

Shop := [].{

	## The server decodes only the user events it handles. Any other tag in
	## the stream lands in `Unknown`, the open part of the variant.
	decode_user_event : Value -> Try(UserEvent, Decode.Error)
	decode_user_event = |v| match v {
		Tag("UserCreated", _) => {
			fs = Decode.record(v)?
			Ok(UserCreated({ id: Decode.field(fs, "id", Decode.u64)?, email: Decode.field(fs, "email", Decode.str)?, at: Decode.field(fs, "at", Decode.instant)? }))
		}
		Tag("UserRenamed", _) => {
			fs = Decode.record(v)?
			Ok(UserRenamed({ id: Decode.field(fs, "id", Decode.u64)?, from: Decode.field(fs, "from", Decode.str)?, to: Decode.field(fs, "to", Decode.str)?, at: Decode.field(fs, "at", Decode.instant)? }))
		}
		Tag(tag, _) => Ok(Unknown(tag))
		_ => Decode.expected("a variant", v)
	}

	## A consumer that knows more tags, e.g. an analytics service.
	decode_app_event : Value -> Try(AppEvent, Decode.Error)
	decode_app_event = |v| match v {
		Tag("PaymentReceived", _) => {
			fs = Decode.record(v)?
			Ok(PaymentReceived({ id: Decode.field(fs, "id", Decode.u64)?, amount: Decode.field(fs, "amount", Decode.money)?, at: Decode.field(fs, "at", Decode.instant)? }))
		}
		Tag("Heartbeat", []) => Ok(Heartbeat)
		_ =>
		# Reuse the user-event decoder: its result type is a subset of ours.
			match decode_user_event(v)? {
				UserCreated(e) => Ok(UserCreated(e))
				UserRenamed(e) => Ok(UserRenamed(e))
				Unknown(tag) => Ok(Unknown(tag))
			}
	}

	## Works for ANY tag union that contains these two user events, with any
	## extra fields on their records: the open union `..others` and the open
	## records `..` are Roc's row polymorphism.
	describe_user : [UserCreated({ id : U64, email : Str, .. }), UserRenamed({ id : U64, to : Str, .. }), ..others] -> Str
	describe_user = |event| match event {
		UserCreated({ id, email, .. }) => "user ${id.to_str()} created (${email})"
		UserRenamed({ id, to, .. }) => "user ${id.to_str()} renamed to ${to}"
		_ => "-"
	}

	## Any record with an `id` field.
	id_of : { id : U64, .. } -> U64
	id_of = |record| record.id
}

UserEvent : [
	UserCreated({ id : U64, email : Str, at : Str }),
	UserRenamed({ id : U64, from : Str, to : Str, at : Str }),
	Unknown(Str),
]

AppEvent : [
	UserCreated({ id : U64, email : Str, at : Str }),
	UserRenamed({ id : U64, from : Str, to : Str, at : Str }),
	PaymentReceived({ id : U64, amount : { amount : Str, currency : Str }, at : Str }),
	Heartbeat,
	Unknown(Str),
]

# ── showcase, run with `roc test` ────────────────────────────

# The server's view of examples/stream.haus: PaymentReceived and Heartbeat
# aren't user events, so they decode as Unknown.
expect {
	events = Decode.all(stream_src, Shop.decode_user_event)
	events
		== Ok([
			UserCreated({ id: 42, email: "jan@example.com", at: "2026-11-07T10:00:00Z" }),
			UserRenamed({ id: 42, from: "Jan", to: "Jan S.", at: "2026-11-07T10:05:12Z" }),
			Unknown("PaymentReceived"),
			Unknown("Heartbeat"),
		])
}

# The analytics view of the same stream knows every tag.
expect {
	events = Decode.all(stream_src, Shop.decode_app_event)
	match events {
		Ok([_, _, PaymentReceived({ amount, .. }), Heartbeat]) => amount == { amount: "19.99", currency: "EUR" }
		_ => False
	}
}

# One handler, two different union types.
expect {
	server : UserEvent
	server = UserRenamed({ id: 42, from: "Jan", to: "Jan S.", at: "now" })
	analytics : AppEvent
	analytics = UserCreated({ id: 7, email: "ada@example.com", at: "now" })
	Shop.describe_user(server) == "user 42 renamed to Jan S." and Shop.describe_user(analytics) == "user 7 created (ada@example.com)"
}

# One accessor, records of different shapes.
expect Shop.id_of({ id: 1, email: "a@b" }) + Shop.id_of({ id: 2, amount: { amount: "1", currency: "EUR" } }) == 3

# Mismatches report where they happened.
expect Decode.all("UserCreated { id: 1, at: Instant(\"x\") },", Shop.decode_user_event) == Err(Decode({ reason: "missing field 'email'", path: "$[0]" }))
expect Decode.all("Heartbeat, UserRenamed { id: \"42\" },", Shop.decode_user_event) == Err(Decode({ reason: "expected an unsigned integer, found a string", path: "$[1].id" }))
expect Decode.all("UserCreated(1)", Shop.decode_user_event) == Err(Decode({ reason: "expected a record, found variant UserCreated", path: "$[0]" }))
expect {
	match Decode.all("{ ok: true }", Shop.decode_user_event) {
		Err(Syntax({ line: 1, column: 7, .. })) => True
		_ => False
	}
}
