//! The language-neutral conformance suite (test-suite/README.md).

use haus::Value;
use serde_json::{Map, Value as Json, json};
use std::fs;
use std::path::{Path, PathBuf};

fn suite(dir: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-suite").join(dir)
}

fn cases(dir: &str) -> Vec<PathBuf> {
    let mut files: Vec<_> = fs::read_dir(suite(dir))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "haus"))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no cases in test-suite/{dir}");
    files
}

/// A value in the suite's JSON encoding.
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

/// The expected results; `deep-nesting.json` is deeper than serde_json's default limit.
fn read_json(path: &Path) -> Json {
    let text = fs::read_to_string(path).unwrap();
    let mut de = serde_json::Deserializer::from_str(&text);
    de.disable_recursion_limit();
    serde::Deserialize::deserialize(&mut de).unwrap()
}

#[test]
fn valid() {
    let mut failures = Vec::new();
    for path in cases("valid") {
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        let expected = read_json(&path.with_extension("json"));
        match haus::parse_bytes(&fs::read(&path).unwrap()) {
            Ok(values) => {
                let actual = Json::Array(values.iter().map(canonical).collect());
                if actual != expected {
                    failures.push(format!("{name}: got {actual}"));
                }
            }
            Err(e) => failures.push(format!("{name}: {e}")),
        }
    }
    assert!(failures.is_empty(), "valid cases failed:\n{}", failures.join("\n"));
}

#[test]
fn invalid() {
    let mut failures = Vec::new();
    for path in cases("invalid") {
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        if let Ok(values) = haus::parse_bytes(&fs::read(&path).unwrap()) {
            failures.push(format!("{name}: accepted as {values:?}"));
        }
    }
    assert!(failures.is_empty(), "invalid cases were accepted:\n{}", failures.join("\n"));
}
