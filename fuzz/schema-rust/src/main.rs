//! The Rust runner of the schema fuzzer (fuzz/README.md): `schema_runner FILE`
//! reads lines `SUITE TYPE HEX` (a value's haus text as hex-encoded UTF-8),
//! decodes the value with the type, encodes the result, and prints one line
//! each: `ok <canonical form>` or `err <place> <reason>`.

mod schemas {
    include!(concat!(env!("OUT_DIR"), "/schemas.rs"));
}

use std::io::{BufWriter, Write};
use std::{env, fs};

fn unhex(hex: &str) -> Vec<u8> {
    let digit = |c: u8| if c.is_ascii_digit() { c - b'0' } else { c - b'a' + 10 };
    hex.as_bytes().chunks(2).map(|p| digit(p[0]) * 16 + digit(p[1])).collect()
}

fn line(text: &str) -> String {
    let parts: Vec<&str> = text.split(' ').collect();
    let [suite, ty, hex] = parts.as_slice() else { return "err $ bad line".into() };
    let value = match haus::parse_bytes(&unhex(hex)) {
        Ok(mut vs) if vs.len() == 1 => vs.remove(0),
        _ => return "err $ not a single value".into(),
    };
    match schemas::roundtrip(suite, ty, &value) {
        None => format!("crash no type {suite}.{ty}"),
        Some(Ok(encoded)) => format!("ok {}", haus::canonical(&encoded)),
        Some(Err(e)) => format!("err {}", e.to_string().replace(['\n', '\r'], " ")),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let file = env::args().nth(1).ok_or("usage: schema_runner FILE")?;
    let text = fs::read_to_string(file)?;
    let mut out = BufWriter::new(std::io::stdout().lock());
    for l in text.lines().filter(|l| !l.is_empty()) {
        writeln!(out, "{}", line(l))?;
    }
    Ok(())
}
