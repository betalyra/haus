//! The schema conformance suite (test-suite/schema, spec §15), run on the
//! code haus-build generates for its schemas (see build.rs).
//!
//! Each case is `Ok { type, input, output? }` or `Err { type, input }`. Ok:
//! decoding `input` with `type` succeeds, and encoding the result gives a value
//! equal to `output` (or `input`). Err: decoding fails.

mod suite {
    include!(concat!(env!("OUT_DIR"), "/schema_suite.rs"));
}

use haus::{Value, canonical};
use std::fs;
use std::path::Path;

/// A case: whether it should decode, the type, the input, and the expected output.
struct Case {
    ok: bool,
    ty: String,
    input: Value,
    output: Value,
}

impl Case {
    /// A case from its value in a `.cases.haus` file.
    fn parse(v: &Value) -> Result<Case, String> {
        let (ok, fields) = match v {
            Value::Variant { tag, args } if tag == "Ok" || tag == "Err" => match args.as_slice() {
                [fields @ Value::Record(_)] => (tag == "Ok", fields),
                _ => return Err(format!("not a case: {}", canonical(v))),
            },
            _ => return Err(format!("not a case: {}", canonical(v))),
        };
        match (fields.get("type"), fields.get("input")) {
            (Some(Value::String(ty)), Some(input)) => Ok(Case {
                ok,
                ty: ty.clone(),
                input: input.clone(),
                output: fields.get("output").unwrap_or(input).clone(),
            }),
            _ => Err(format!("not a case: {}", canonical(v))),
        }
    }

    /// `Ok F64 1.0`.
    fn name(&self) -> String {
        format!("{} {} {}", if self.ok { "Ok" } else { "Err" }, self.ty, canonical(&self.input))
    }

    /// Runs the case on the schema `file`: None if it passes, what went wrong otherwise.
    fn failure(&self, file: &str) -> Option<String> {
        let Some(result) = suite::roundtrip(file, &self.ty, &self.input) else {
            return Some(format!("no type {}", self.ty));
        };
        match (self.ok, result) {
            (true, Ok(encoded)) if canonical(&encoded) == canonical(&self.output) => None,
            (true, Ok(encoded)) => {
                Some(format!("encoded as {}, expected {}", canonical(&encoded), canonical(&self.output)))
            }
            (true, Err(e)) => Some(format!("failed to decode: {e}")),
            (false, Ok(encoded)) => Some(format!("decoded, expected an error (encoded as {})", canonical(&encoded))),
            (false, Err(_)) => None,
        }
    }
}

#[test]
fn schema_conformance() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-suite/schema");
    assert!(!suite::FILES.is_empty(), "no schemas in {}", dir.display());
    let (count, failures) = suite::FILES.iter().fold((0, vec![]), |(count, mut failures), file| {
        let path = dir.join(format!("{file}.cases.haus"));
        let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let values = haus::parse(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let cases: Vec<Case> =
            values.iter().map(Case::parse).collect::<Result<_, _>>().unwrap_or_else(|e| panic!("{file}: {e}"));
        failures.extend(
            cases.iter().filter_map(|c| c.failure(file).map(|why| format!("{file}.cases.haus: {}: {why}", c.name()))),
        );
        (count + cases.len(), failures)
    });
    assert!(failures.is_empty(), "{} of {count} cases failed:\n{}", failures.len(), failures.join("\n"));
}
