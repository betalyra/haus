//! The fuzzing runner (fuzz/README.md): `fuzz_runner [--stream] DIR N` parses
//! DIR/00000.haus … DIR/{N-1}.haus and prints one line each:
//! `ok <values>` in the test-suite JSON encoding, or `err <line> <column> <reason>`.
//! With `--stream`, each file goes through the stream reader in chunks
//! (see `chunks`).

use haus::Value;
use serde_json::{Map, Value as Json, json};
use std::io::{BufWriter, Write};
use std::{env, fs};

fn canonical(v: &Value) -> Json {
    match v {
        Value::String(s) => json!(s),
        Value::Number(n) => json!({ "num": n }),
        Value::Bytes(b) => json!({ "bytes": b.iter().map(|x| format!("{x:02x}")).collect::<String>() }),
        Value::Array(items) => Json::Array(items.iter().map(canonical).collect()),
        Value::Record(fields) => {
            json!({ "rec": fields.iter().map(|(k, v)| (k.clone(), canonical(v))).collect::<Map<_, _>>() })
        }
        Value::Variant { tag, args } if args.is_empty() => json!({ "tag": tag }),
        Value::Variant { tag, args } => json!({ "tag": tag, "args": args.iter().map(canonical).collect::<Vec<_>>() }),
    }
}

fn line(result: Result<Vec<Value>, haus::SyntaxError>) -> String {
    match result {
        Ok(values) => format!("ok {}", Json::Array(values.iter().map(canonical).collect())),
        Err(e) => format!("err {} {} {}", e.line, e.column, e.reason.replace('\n', " ")),
    }
}

/// The chunks of case `i`, the same in every runner: chunk k has size
/// SIZES[(i + k) % 7], so cuts fall inside escapes, comments and UTF-8 sequences.
fn chunks(bytes: &[u8], i: usize) -> Vec<&[u8]> {
    const SIZES: [usize; 7] = [1, 2, 3, 5, 8, 13, 64];
    let mut out = Vec::new();
    let (mut at, mut k) = (0, 0);
    while at < bytes.len() {
        let end = (at + SIZES[(i + k) % 7]).min(bytes.len());
        out.push(&bytes[at..end]);
        at = end;
        k += 1;
    }
    out
}

fn streamed(bytes: &[u8], i: usize) -> Result<Vec<Value>, haus::SyntaxError> {
    let mut reader = haus::stream::Reader::default();
    let mut values = Vec::new();
    for chunk in chunks(bytes, i) {
        values.extend(reader.push(chunk)?);
    }
    values.extend(reader.finish()?);
    Ok(values)
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let (stream, dir, n) = match args.as_slice() {
        [flag, dir, n] if flag == "--stream" => (true, dir, n),
        [dir, n] => (false, dir, n),
        _ => panic!("usage: fuzz_runner [--stream] DIR N"),
    };
    let n: usize = n.parse().expect("N");
    let mut out = BufWriter::new(std::io::stdout().lock());
    for i in 0..n {
        let bytes = fs::read(format!("{dir}/{i:05}.haus")).expect("read case");
        let result = if stream { streamed(&bytes, i) } else { haus::parse_bytes(&bytes) };
        writeln!(out, "{}", line(result)).unwrap();
    }
}
