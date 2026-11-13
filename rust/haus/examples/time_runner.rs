//! The std/time fuzzing runner (fuzz/README.md): `time_runner FILE` reads
//! lines `TYPE HEX` (the text as hex-encoded UTF-8) and prints one line each:
//! `ok` if the text is a valid value of the std/time type, `no` if not.

use std::io::{BufWriter, Write};
use std::{env, fs};

fn main() {
    let file = env::args().nth(1).expect("usage: time_runner FILE");
    let input = fs::read_to_string(file).expect("readable input");
    let mut out = BufWriter::new(std::io::stdout().lock());
    for line in input.lines() {
        let (ty, hex) = line.split_once(' ').unwrap_or((line, ""));
        let bytes: Vec<u8> =
            (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap_or(0)).collect();
        let result = match String::from_utf8(bytes) {
            Ok(text) if haus::time::check(ty, &text).is_ok() => "ok",
            Ok(_) => "no",
            Err(_) => "err invalid UTF-8",
        };
        writeln!(out, "{result}").expect("stdout");
    }
}
