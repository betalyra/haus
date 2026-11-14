## The quickstart: data typed by its schema, decoding, encoding and errors.
## The same steps as the TypeScript and Rust quickstarts, on the same files.
## Run from this folder: roc main.roc
app [main!] {
	haus: "../../package/main.roc",
	pf: platform "https://github.com/roc-lang/basic-cli/releases/download/0.26.0/GddgvsGjiNXrHFW6au5i5dUDbTs8FinQdrgE2Gqmw53t.tar.zst",
}

import pf.OsStr
import pf.Path
import pf.Stdout
import haus.Decode
import haus.Encode
import haus.Int
import Thread

reply : Str
reply = "Comment { author: \"me\", at: Instant(\"2026-11-16T09:00:00Z\"), text: \"+1\", likes: 0, replies: [] }"

main! : List(OsStr) => Try({}, _)
main! = |_args| {
	path : Path
	path = "../../../examples/thread.haus"
	text = path.read_utf8!()?

	# 1. The thread, as typed data: a Comment, whose replies are Comments. likes is an Int (any size).
	thread = Decode.one(text, Thread.decode_root)?
	Stdout.line!("thread by ${author(thread)}: ${depth(thread).to_str()} levels, ${likes(thread).to_str()} likes")?

	# 2. Decode haus text with the schema, change it, encode it back.
	decoded = Decode.one(reply, Thread.decode_comment)?
	liked = match decoded {
		Comment(c) => Comment({ ..c, likes: Int.from_i128((c.likes.to_i128() ?? 0) + 1) })
	}
	Stdout.line!(Encode.to_str(Thread.encode_comment(liked)).map_err(|e| Encode(e))?)?

	# 3. A value that doesn't match the schema is an error that says where.
	Stdout.line!(error(Decode.one(reply.replace_first("likes: 0", "likes: \"lots\""), Thread.decode_comment)))?
	Ok({})
}

## What went wrong, with where.
error : Try(a, [Decode(Decode.Error), Syntax({ reason : Str, line : U64, column : U64 })]) -> Str
error = |result| match result {
	Ok(_) => "no error"
	Err(Decode(e)) => "error: ${Decode.message(e)}"
	Err(Syntax({ reason, line, column })) => "error: ${line.to_str()}:${column.to_str()}: ${reason}"
}

author : Thread.Comment -> Str
author = |comment| match comment {
	Comment(c) => c.author
}

likes : Thread.Comment -> I128
likes = |comment| match comment {
	Comment(c) => {
		var $sum = c.likes.to_i128() ?? 0
		for r in c.replies {
			$sum = $sum + likes(r)
		}
		$sum
	}
}

depth : Thread.Comment -> U64
depth = |comment| match comment {
	Comment(c) => {
		var $deepest = 0
		for r in c.replies {
			d = depth(r)
			if d > $deepest {
				$deepest = d
			}
		}
		1 + $deepest
	}
}
