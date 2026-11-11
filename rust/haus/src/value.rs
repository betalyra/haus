//! The haus data model, exactly as written in the source. No schema has been
//! applied: numbers are kept as exact literal text, and variants are generic.

/// A haus value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    /// The exact literal, digit separators removed and the exponent marker
    /// lower-cased. Hex and binary literals are converted to decimal integers:
    /// `"19.90"`, `"-1e10"`, `"255"`.
    Number(String),
    String(String),
    /// A byte string, written `x"0b34ff"`.
    Bytes(Vec<u8>),
    Array(Vec<Value>),
    /// Fields in source order. Keys are unique.
    Record(Vec<(String, Value)>),
    /// `args` is empty for a bare tag; `Tag { … }` has one record argument.
    Variant {
        tag: String,
        args: Vec<Value>,
    },
}

impl Value {
    /// A field of a record.
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Record(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}
