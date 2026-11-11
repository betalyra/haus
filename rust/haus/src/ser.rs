//! Encoding Rust values as haus: the [`Encode`] trait and the compact writer
//! (spec §11: one value per line, normal spacing).

use crate::de::{AnyTag, Bytes, Decimal, Int, Unknown};
use crate::{Codec, Value};
use std::collections::BTreeMap;
use std::fmt::Write as _;

/// A Rust type that encodes to a haus value.
pub trait Encode {
    fn encode(&self) -> Value;
}

/// A variant value.
pub fn variant(tag: &str, args: Vec<Value>) -> Value {
    Value::Variant { tag: tag.to_owned(), args }
}

/// A record value from fields in order, leaving out missing optional ones.
pub fn record<const N: usize>(fields: [(&str, Option<Value>); N]) -> Value {
    Value::Record(fields.into_iter().filter_map(|(k, v)| Some((k.to_owned(), v?))).collect())
}

pub fn array<T>(items: &[T], f: impl Fn(&T) -> Value) -> Value {
    Value::Array(items.iter().map(f).collect())
}
pub fn map<T>(m: &BTreeMap<String, T>, f: impl Fn(&T) -> Value) -> Value {
    Value::Record(m.iter().map(|(k, v)| (k.clone(), f(v))).collect())
}
pub fn maybe<T>(m: &Option<T>, f: impl FnOnce(&T) -> Value) -> Value {
    match m {
        None => variant("None", vec![]),
        Some(x) => variant("Some", vec![f(x)]),
    }
}
pub fn result<A, E>(r: &Result<A, E>, ok: impl FnOnce(&A) -> Value, err: impl FnOnce(&E) -> Value) -> Value {
    match r {
        Ok(x) => variant("Ok", vec![ok(x)]),
        Err(x) => variant("Err", vec![err(x)]),
    }
}
/// A type with a codec: back to its base type, then encoded.
pub fn codec<C: Codec>(x: &C::Target) -> Value {
    C::encode(x).encode()
}

impl<T: Encode + ?Sized> Encode for &T {
    fn encode(&self) -> Value {
        (**self).encode()
    }
}
impl<T: Encode> Encode for Box<T> {
    fn encode(&self) -> Value {
        (**self).encode()
    }
}
impl<T: Encode> Encode for Vec<T> {
    fn encode(&self) -> Value {
        array(self, T::encode)
    }
}
impl<T: Encode> Encode for BTreeMap<String, T> {
    fn encode(&self) -> Value {
        map(self, T::encode)
    }
}
impl<T: Encode> Encode for Option<T> {
    fn encode(&self) -> Value {
        maybe(self, T::encode)
    }
}
impl<A: Encode, E: Encode> Encode for Result<A, E> {
    fn encode(&self) -> Value {
        result(self, A::encode, E::encode)
    }
}
impl Encode for Value {
    fn encode(&self) -> Value {
        self.clone()
    }
}
impl Encode for String {
    fn encode(&self) -> Value {
        Value::String(self.clone())
    }
}
impl Encode for str {
    fn encode(&self) -> Value {
        Value::String(self.to_owned())
    }
}
impl Encode for Bytes {
    fn encode(&self) -> Value {
        Value::Bytes(self.0.clone())
    }
}
impl Encode for bool {
    fn encode(&self) -> Value {
        variant(if *self { "True" } else { "False" }, vec![])
    }
}
macro_rules! integers {
    ($($t:ty),*) => {$(
        impl Encode for $t {
            fn encode(&self) -> Value {
                Value::Number(self.to_string())
            }
        }
    )*};
}
integers!(i8, i16, i32, i64, u8, u16, u32, u64);
macro_rules! floats {
    ($($t:ty),*) => {$(
        impl Encode for $t {
            fn encode(&self) -> Value {
                if self.is_nan() {
                    variant("NaN", vec![])
                } else if self.is_infinite() {
                    variant(if *self > 0.0 { "Infinity" } else { "NegInfinity" }, vec![])
                } else {
                    // Debug is the shortest text that reads back as the same float.
                    Value::Number(format!("{self:?}"))
                }
            }
        }
    )*};
}
floats!(f32, f64);
impl Encode for Int {
    fn encode(&self) -> Value {
        Value::Number(self.as_str().to_owned())
    }
}
impl Encode for Decimal {
    fn encode(&self) -> Value {
        Value::Number(self.as_str().to_owned())
    }
}
impl Encode for Unknown {
    fn encode(&self) -> Value {
        variant(&self.tag, self.args.clone())
    }
}
impl Encode for AnyTag {
    fn encode(&self) -> Value {
        match self {
            AnyTag::Bare(tag) => variant(tag, vec![]),
            AnyTag::Other(u) => u.encode(),
        }
    }
}

// ── the compact writer ───────────────────────────────────────

/// One value on one line (spec §11, compact).
pub fn write(v: &Value) -> String {
    let mut out = String::new();
    line(v, &mut out);
    out
}

fn line(v: &Value, out: &mut String) {
    match v {
        Value::Number(n) => out.push_str(n),
        Value::String(s) => quote(s, out),
        Value::Bytes(b) => {
            out.push_str("x\"");
            for x in b {
                let _ = write!(out, "{x:02x}");
            }
            out.push('"');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, x) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                line(x, out);
            }
            out.push(']');
        }
        Value::Record(fields) => write_record(fields, out),
        Value::Variant { tag, args } => {
            out.push_str(tag);
            match args.as_slice() {
                [] => {}
                [Value::Record(fields)] => {
                    out.push(' ');
                    write_record(fields, out);
                }
                _ => {
                    out.push('(');
                    for (i, x) in args.iter().enumerate() {
                        if i > 0 {
                            out.push_str(", ");
                        }
                        line(x, out);
                    }
                    out.push(')');
                }
            }
        }
    }
}

fn write_record(fields: &[(String, Value)], out: &mut String) {
    if fields.is_empty() {
        return out.push_str("{}");
    }
    out.push_str("{ ");
    for (i, (k, v)) in fields.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        let bare = k.starts_with(|c: char| c.is_ascii_lowercase() || c == '_')
            && k.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_');
        if bare {
            out.push_str(k)
        } else {
            quote(k, out)
        }
        out.push_str(": ");
        line(v, out);
    }
    out.push_str(" }");
}

/// A `"…"` string with the minimal escapes.
fn quote(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 || matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}') => {
                let _ = write!(out, "\\u{{{:X}}}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}
