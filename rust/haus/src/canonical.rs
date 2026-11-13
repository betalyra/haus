//! The canonical form, equality and hashing (spec §12): one exact text per
//! value, the same in every binding. Equal values (§2) have identical
//! canonical forms, so [`hash`] is the same whatever the layout, comments,
//! key order or spelling of the document the value came from.
//!
//! ```
//! let v = haus::from_str::<haus::Value>(r#"Order { total: 19.90, id: 0xFF, "x-y": 1e+5 }"#).unwrap();
//! assert_eq!(haus::canonical(&v), r#"Order{id:255,total:19.90,"x-y":1e5}"#);
//! ```

use crate::Value;
use crate::ser::{key, number_text, quote};
use std::fmt::Write;

/// The canonical form of a value (spec §12).
pub fn canonical(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

/// Whether two values are equal (spec §2): the same canonical form.
pub fn equals(a: &Value, b: &Value) -> bool {
    canonical(a) == canonical(b)
}

/// Orders values by the bytes of their canonical forms (spec §12): a total
/// order consistent with [`equals`], for sorting and ordered maps. Not
/// numeric order: `10` sorts before `9`.
///
/// ```
/// let mut vs: Vec<haus::Value> = ["9", "10", "\"a\"", "[]"].iter().map(|s| haus::from_str(s).unwrap()).collect();
/// vs.sort_by(haus::compare);
/// assert_eq!(vs.iter().map(haus::canonical).collect::<Vec<_>>(), ["\"a\"", "10", "9", "[]"]);
/// ```
pub fn compare(a: &Value, b: &Value) -> std::cmp::Ordering {
    canonical(a).cmp(&canonical(b))
}

/// The SHA-256 digest of the canonical form, as 64 lowercase hex digits
/// (spec §12). Needs the `hash` feature.
#[cfg(feature = "hash")]
pub fn hash(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(canonical(value).as_bytes()).iter().fold(String::with_capacity(64), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

fn write(v: &Value, out: &mut String) {
    match v {
        Value::Number(n) => out.push_str(&number_text(n)),
        Value::String(s) => quote(s, out),
        Value::Bytes(b) => {
            out.push_str("x\"");
            for x in b {
                let _ = write!(out, "{x:02x}");
            }
            out.push('"');
        }
        Value::Array(items) => list('[', items, ']', out),
        Value::Record(fields) => record(fields, out),
        Value::Variant { tag, args } => {
            out.push_str(tag);
            match args.as_slice() {
                [] => {}
                [Value::Record(fields)] => record(fields, out),
                _ => list('(', args, ')', out),
            }
        }
    }
}

fn list(open: char, items: &[Value], close: char, out: &mut String) {
    out.push(open);
    for (i, x) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write(x, out);
    }
    out.push(close);
}

/// Fields sorted by key. `str`'s order is the order of UTF-8 bytes, which is
/// the order of code points (spec §12).
fn record(fields: &[(String, Value)], out: &mut String) {
    let mut sorted: Vec<&(String, Value)> = fields.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    out.push('{');
    for (i, (k, v)) in sorted.into_iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        key(k, out);
        out.push(':');
        write(v, out);
    }
    out.push('}');
}
