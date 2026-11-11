## A log, read as a stream: each entry is decoded as soon as its comma
## arrives, so memory holds one entry, not the whole file. The same steps as
## the TypeScript and Rust logs examples, on the same files.
## Run from this folder: roc main.roc
app [main!] {
	haus: "../../package/main.roc",
	pf: platform "https://github.com/roc-lang/basic-cli/releases/download/0.26.0/GddgvsGjiNXrHFW6au5i5dUDbTs8FinQdrgE2Gqmw53t.tar.zst",
}

import pf.File
import pf.OsStr
import pf.Path
import pf.Stdout
import haus.Decode
import haus.Encode
import haus.Stream
import Logs

main! : List(OsStr) => Try({}, _)
main! = |_args| {
	path : Path
	path = "../../../examples/logs.haus"
	reader = File.open_reader!(path)?

	# 1. Read the stream chunk by chunk (from a file here; a socket or stdin
	#    work the same), and decode each entry as soon as its comma arrives.
	var $stream = Stream.reader(Stream.defaults)
	var $index = 0
	var $problems = []
	var $more = True
	while $more {
		values = match reader.read_up_to!(1024) {
			Ok(chunk) => {
				(next, completed) = Stream.push($stream, chunk).map_err(|e| Syntax(e))?
				$stream = next
				completed
			}
			Err(EndOfInput) => {
				$more = False
				Stream.finish($stream).map_err(|e| Syntax(e))?
			}
			Err(FileErr(e)) => return Err(FileErr(e))
		}
		for value in values {
			entry = Decode.item(value, $index, Logs.decode_entry).map_err(|e| Decode(e))?
			$index = $index + 1
			Stdout.line!(describe(entry))?
			if is_problem(entry) {
				$problems = $problems.append(entry)
			}
		}
	}

	# 2. Write a stream: the problems, one entry per line.
	Stdout.line!("problems:")?
	Stdout.write!(Encode.stream($problems.map(Logs.encode_entry)))?
	Ok({})
}

## One line per entry. Entries of kinds the schema doesn't know are `Unknown`.
describe : Logs.Entry -> Str
describe = |entry| match entry {
	Log({ at, level, service, message }) => "${time(at)} ${level_name(level)} ${service}: ${message}"
	Request({ at, method, path, status, ms }) => "${time(at)} ${method} ${path} → ${status.to_str()} in ${ms.to_str()} ms"
	Unknown(kind, _) => "(skipped an entry of kind ${kind})"
}

is_problem : Logs.Entry -> Bool
is_problem = |entry| match entry {
	Log({ level, .. }) => level_name(level) == "Warn" or level_name(level) == "Error"
	Request({ status, .. }) => status >= 500
	Unknown(_, _) => False
}

level_name : Logs.Level -> Str
level_name = |level| match level {
	Debug => "Debug"
	Info => "Info"
	Warn => "Warn"
	Error => "Error"
}

## `09:00:02` of `2026-11-11T09:00:02Z`.
time : Str -> Str
time = |at| match Str.from_utf8(at.to_utf8().sublist({ start: 11, len: 8 })) {
	Ok(t) => t
	Err(_) => at
}
