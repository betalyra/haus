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
    hex(&Sha256::digest(canonical(value).as_bytes()))
}

/// The hash of a list of values, such as a whole file or stream (spec §12):
/// the SHA-256 digest of their canonical forms joined by `,`. A list of one
/// value hashes like the value. Needs the `hash` feature.
///
/// ```
/// let vs = haus::parse("1, \"a\",").unwrap();
/// assert_eq!(haus::hash_all(&vs[..1]), haus::hash(&vs[0]));
/// ```
#[cfg(feature = "hash")]
pub fn hash_all<'a>(values: impl IntoIterator<Item = &'a Value>) -> String {
    let mut hasher = Hasher::new();
    for v in values {
        hasher.add(v);
    }
    hasher.digest()
}

/// Hashes a list of values as it grows, e.g. a stream while it is read (spec
/// §12): [`Hasher::digest`] gives [`hash_all`] of the values added so far, at
/// any time. Memory stays bounded by the largest value. Needs the `hash` feature.
#[cfg(feature = "hash")]
#[derive(Clone, Default)]
pub struct Hasher {
    sha: sha2::Sha256,
    count: usize,
}

#[cfg(feature = "hash")]
impl Hasher {
    pub fn new() -> Hasher {
        Hasher::default()
    }

    /// Add the next value.
    pub fn add(&mut self, value: &Value) -> &mut Hasher {
        use sha2::Digest;
        if self.count > 0 {
            self.sha.update(b",");
        }
        self.count += 1;
        self.sha.update(canonical(value).as_bytes());
        self
    }

    /// [`hash_all`] of the values added so far, as 64 lowercase hex digits.
    pub fn digest(&self) -> String {
        use sha2::Digest;
        hex(&self.sha.clone().finalize())
    }
}

#[cfg(feature = "hash")]
fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::with_capacity(64), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

fn write(v: &Value, out: &mut String) {
    match v {
        // The default number limit, whatever the reader's (spec §12).
        Value::Number(n) => out.push_str(&number_text(n, crate::Limits::default().max_number_length)),
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
