## `Secret a` (spec §15): the same data as `a`, for API keys and passwords,
## in a type that keeps it out of logs. `Str.inspect` and `dbg` show
## `<redacted>`; get the value with `expose`. Encoding writes it in full: the
## receiver needs it. Decoding errors inside a secret say only that it isn't
## valid (see `Decode.secret`).
##
##     key = Secret.new("sk-123")
##     Str.inspect(key)   # "<redacted>"
##     key.expose()       # "sk-123"
Secret(a) :: [Hidden(a)].{
	new : a -> Secret(a)
	new = |x| Hidden(x)

	## The value.
	expose : Secret(a) -> a
	expose = |s| match s {
		Hidden(x) => x
	}

	is_eq : Secret(a), Secret(a) -> Bool where [a.is_eq : a, a -> Bool]
	is_eq = |x, y| x.expose() == y.expose()

	## Never the value: `<redacted>`.
	to_inspect : Secret(a) -> Str
	to_inspect = |_| "<redacted>"
}

expect Str.inspect(Secret.new("sk-123")) == "<redacted>"
expect Str.inspect({ user: "ada", key: Secret.new("sk-123") }) == "{ key: <redacted>, user: \"ada\" }"
expect Secret.new("sk-123").expose() == "sk-123"
expect Secret.new(1.U8) == Secret.new(1.U8)
expect Secret.new(1.U8) != Secret.new(2.U8)
