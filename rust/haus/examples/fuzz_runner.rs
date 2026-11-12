//! The fuzzing runner (fuzz/README.md): `fuzz_runner DIR N` parses
//! DIR/00000.haus … DIR/{N-1}.haus and prints one line each:
//! `ok <values>` in the test-suite JSON encoding, or `err <line> <column> <reason>`.

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

fn line(bytes: &[u8]) -> String {
    match haus::parse_bytes(bytes) {
        Ok(values) => format!("ok {}", Json::Array(values.iter().map(canonical).collect())),
        Err(e) => format!("err {} {} {}", e.line, e.column, e.reason.replace('\n', " ")),
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let [_, dir, n] = args.as_slice() else { panic!("usage: fuzz_runner DIR N") };
    let n: usize = n.parse().expect("N");
    let mut out = BufWriter::new(std::io::stdout().lock());
    for i in 0..n {
        let bytes = fs::read(format!("{dir}/{i:05}.haus")).expect("read case");
        writeln!(out, "{}", line(&bytes)).unwrap();
    }
}
