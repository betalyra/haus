//! Decoding values into Rust types: the [`Decode`] trait, its implementations
//! for the prelude types, and the helpers that generated code calls.
//!
//! Decoding is linear in the input (spec §9): records are indexed once, and a
//! variant's case is chosen by its tag, never by trying cases in turn.

use crate::{Codec, DecodeError, Value};
use std::collections::{BTreeMap, HashMap};

type R<T> = Result<T, DecodeError>;

/// A Rust type that a haus value decodes to.
pub trait Decode: Sized {
    fn decode(v: &Value) -> R<Self>;
}

/// What a value is, for messages: `a string`, `the tag Open`.
pub fn describe(v: &Value) -> String {
    match v {
        Value::Number(n) => format!("the number {n}"),
        Value::String(_) => "a string".into(),
        Value::Bytes(_) => "a byte string".into(),
        Value::Array(_) => "an array".into(),
        Value::Record(_) => "a record".into(),
        Value::Variant { tag, args } if args.is_empty() => format!("the tag {tag}"),
        Value::Variant { tag, .. } => format!("{tag}(…)"),
    }
}

/// `expected <what>, found <v>`.
pub fn mismatch(what: &str, v: &Value) -> DecodeError {
    DecodeError::new(format!("expected {what}, found {}", describe(v)))
}

// ── records ──────────────────────────────────────────────────

/// A record, indexed by key once.
pub struct Record<'a> {
    fields: &'a [(String, Value)],
    index: HashMap<&'a str, &'a Value>,
    /// The payload of this tag, for error paths.
    tag: Option<&'a str>,
}

impl<'a> Record<'a> {
    /// `v` as a record; `what` names the expected type in errors.
    pub fn new(v: &'a Value, what: &str) -> R<Record<'a>> {
        match v {
            Value::Record(fields) => {
                Ok(Record { fields, index: fields.iter().map(|(k, v)| (k.as_str(), v)).collect(), tag: None })
            }
            _ => Err(mismatch(&format!("a record ({what})"), v)),
        }
    }

    fn at(&self, e: DecodeError) -> DecodeError {
        match self.tag {
            Some(tag) => e.tag(tag),
            None => e,
        }
    }

    /// A closed record has only the fields listed.
    pub fn closed(&self, known: &[&str]) -> R<()> {
        match self.fields.iter().find(|(k, _)| !known.contains(&k.as_str())) {
            Some((k, _)) => Err(self.at(DecodeError::new(format!("unknown field {k:?} in a closed record")))),
            None => Ok(()),
        }
    }

    pub fn required<T>(&self, key: &str, f: impl FnOnce(&Value) -> R<T>) -> R<T> {
        match self.index.get(key) {
            Some(v) => f(v).map_err(|e| self.at(e.field(key))),
            None => Err(self.at(DecodeError::new(format!("missing field {key}")))),
        }
    }

    /// `key?: T`: the field may be missing.
    pub fn optional<T>(&self, key: &str, f: impl FnOnce(&Value) -> R<T>) -> R<Option<T>> {
        self.index.get(key).map(|v| f(v).map_err(|e| self.at(e.field(key)))).transpose()
    }
}

// ── variants ─────────────────────────────────────────────────

/// `v` as a variant: its tag and payload.
pub fn variant<'a>(v: &'a Value, what: &str) -> R<(&'a str, &'a [Value])> {
    match v {
        Value::Variant { tag, args } => Ok((tag, args)),
        _ => Err(mismatch(&format!("a variant ({what})"), v)),
    }
}

/// The payload of `tag`: exactly `N` values.
pub fn args<'a, const N: usize>(tag: &str, args: &'a [Value]) -> R<&'a [Value; N]> {
    args.try_into().map_err(|_| {
        DecodeError::new(match N {
            0 => format!("{tag} takes no payload"),
            1 => format!("{tag} takes one value, found {}", args.len()),
            n => format!("{tag} takes {n} values, found {}", args.len()),
        })
    })
}

/// Decode payload value `i` of `tag`.
pub fn arg<T>(tag: &str, i: usize, v: &Value, f: impl FnOnce(&Value) -> R<T>) -> R<T> {
    f(v).map_err(|e| e.index(i).tag(tag))
}

/// The record payload of `Tag { … }`.
pub fn payload<'a>(tag: &'a str, args: &'a [Value]) -> R<Record<'a>> {
    let [v] = self::args::<1>(tag, args)?;
    Record::new(v, tag).map(|r| Record { tag: Some(tag), ..r }).map_err(|e| e.tag(tag))
}

/// A tag a closed variant doesn't list.
pub fn unknown_tag(tag: &str, known: &[&str]) -> DecodeError {
    DecodeError::new(format!("unknown tag {tag}; expected one of {}", known.join(", ")))
}

/// A tag an open variant doesn't list: kept as it was (spec §9: untrusted).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unknown {
    pub tag: String,
    pub args: Vec<Value>,
}

impl Unknown {
    pub fn new(tag: &str, args: &[Value]) -> Unknown {
        Unknown { tag: tag.to_owned(), args: args.to_vec() }
    }
}

/// `< >`: a variant with any tag. A bare tag is its name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnyTag {
    Bare(String),
    Other(Unknown),
}

impl std::fmt::Display for AnyTag {
    /// The tag: `EUR`; a tag with a payload as `Tag(…)`.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AnyTag::Bare(tag) => f.write_str(tag),
            AnyTag::Other(u) => write!(f, "{}(…)", u.tag),
        }
    }
}

impl Decode for AnyTag {
    fn decode(v: &Value) -> R<Self> {
        let (tag, args) = variant(v, "a tag")?;
        Ok(if args.is_empty() { AnyTag::Bare(tag.to_owned()) } else { AnyTag::Other(Unknown::new(tag, args)) })
    }
}

// ── containers ───────────────────────────────────────────────

/// `Array a`.
pub fn array<T>(v: &Value, f: impl Fn(&Value) -> R<T>) -> R<Vec<T>> {
    match v {
        Value::Array(items) => items.iter().enumerate().map(|(i, x)| f(x).map_err(|e| e.index(i))).collect(),
        _ => Err(mismatch("an array", v)),
    }
}

/// `Map v`: a record used as a dictionary.
pub fn map<T>(v: &Value, f: impl Fn(&Value) -> R<T>) -> R<BTreeMap<String, T>> {
    match v {
        Value::Record(fields) => fields.iter().map(|(k, x)| Ok((k.clone(), f(x).map_err(|e| e.field(k))?))).collect(),
        _ => Err(mismatch("a record (Map)", v)),
    }
}

/// `Maybe a`: `None` or `Some(a)`.
pub fn maybe<T>(v: &Value, f: impl FnOnce(&Value) -> R<T>) -> R<Option<T>> {
    match variant(v, "Maybe")? {
        ("None", []) => Ok(None),
        ("Some", [x]) => f(x).map(Some).map_err(|e| e.index(0).tag("Some")),
        _ => Err(mismatch("None or Some(…)", v)),
    }
}

/// `Result e a`: `Err(e)` or `Ok(a)`.
pub fn result<A, E>(v: &Value, ok: impl FnOnce(&Value) -> R<A>, err: impl FnOnce(&Value) -> R<E>) -> R<Result<A, E>> {
    match variant(v, "Result")? {
        ("Ok", [x]) => ok(x).map(Ok).map_err(|e| e.index(0).tag("Ok")),
        ("Err", [x]) => err(x).map(Err).map_err(|e| e.index(0).tag("Err")),
        _ => Err(mismatch("Ok(…) or Err(…)", v)),
    }
}

/// A type decoded by a codec: its base type first, then the codec (spec §13.4).
pub fn codec<C: Codec>(v: &Value) -> R<C::Target> {
    C::decode(C::Base::decode(v)?).map_err(DecodeError::new)
}

impl<T: Decode> Decode for Vec<T> {
    fn decode(v: &Value) -> R<Self> {
        array(v, T::decode)
    }
}
impl<T: Decode> Decode for BTreeMap<String, T> {
    fn decode(v: &Value) -> R<Self> {
        map(v, T::decode)
    }
}
impl<T: Decode> Decode for Option<T> {
    fn decode(v: &Value) -> R<Self> {
        maybe(v, T::decode)
    }
}
impl<A: Decode, E: Decode> Decode for Result<A, E> {
    fn decode(v: &Value) -> R<Self> {
        result(v, A::decode, E::decode)
    }
}
impl<T: Decode> Decode for Box<T> {
    fn decode(v: &Value) -> R<Self> {
        T::decode(v).map(Box::new)
    }
}

// ── scalars ──────────────────────────────────────────────────

impl Decode for Value {
    fn decode(v: &Value) -> R<Self> {
        Ok(v.clone())
    }
}

impl Decode for String {
    fn decode(v: &Value) -> R<Self> {
        match v {
            Value::String(s) => Ok(s.clone()),
            _ => Err(mismatch("a string", v)),
        }
    }
}

/// `Bytes`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub struct Bytes(pub Vec<u8>);

impl Decode for Bytes {
    fn decode(v: &Value) -> R<Self> {
        match v {
            Value::Bytes(b) => Ok(Bytes(b.clone())),
            _ => Err(mismatch("a byte string", v)),
        }
    }
}

impl Decode for bool {
    fn decode(v: &Value) -> R<Self> {
        match variant(v, "Bool")? {
            ("True", []) => Ok(true),
            ("False", []) => Ok(false),
            _ => Err(mismatch("True or False", v)),
        }
    }
}

/// The digits of a whole number literal (`-12`, `0`), or None (`1.5`, `1e3`).
/// `-0` is 0 (spec §15).
fn whole(text: &str) -> Option<&str> {
    let digits = text.strip_prefix('-').unwrap_or(text);
    let is_whole = !digits.is_empty() && digits.bytes().all(|c| c.is_ascii_digit());
    is_whole.then_some(if digits == "0" { digits } else { text })
}

macro_rules! integers {
    ($($t:ty => $name:literal),*) => {$(
        impl Decode for $t {
            fn decode(v: &Value) -> R<Self> {
                let Value::Number(text) = v else { return Err(mismatch(concat!("a number (", $name, ")"), v)) };
                let Some(n) = whole(text) else {
                    return Err(DecodeError::new(format!("expected a whole number ({}), found {text}", $name)));
                };
                n.parse().map_err(|_| DecodeError::new(format!(
                    "{text} is out of range for {} ({} to {})", $name, <$t>::MIN, <$t>::MAX
                )))
            }
        }
    )*};
}
integers!(i8 => "Int8", i16 => "Int16", i32 => "Int32", i64 => "Int64", u8 => "UInt8", u16 => "UInt16", u32 => "UInt32", u64 => "UInt64");

/// `Float32` and `Float64`: a number rounded to the nearest value of the type
/// directly from its exact decimal value (ties to even; Rust's `parse` does
/// that for both), or a tag `NaN`, `Infinity`, `NegInfinity` (spec §15). A
/// finite number too large for the type, one that rounds to an infinity, is
/// an error.
macro_rules! floats {
    ($($t:ty => $name:literal),*) => {$(
        impl Decode for $t {
            fn decode(v: &Value) -> R<Self> {
                match v {
                    Value::Number(text) => match text.parse::<$t>() {
                        Ok(x) if x.is_finite() => Ok(x),
                        Ok(_) => Err(DecodeError::new(format!("{text} is too large for {}", $name))),
                        Err(_) => Err(DecodeError::new(format!("{text} is not a {}", $name))),
                    },
                    Value::Variant { tag, args } if args.is_empty() && tag == "NaN" => Ok(<$t>::NAN),
                    Value::Variant { tag, args } if args.is_empty() && tag == "Infinity" => Ok(<$t>::INFINITY),
                    Value::Variant { tag, args } if args.is_empty() && tag == "NegInfinity" => Ok(<$t>::NEG_INFINITY),
                    _ => Err(mismatch(concat!("a number (", $name, ")"), v)),
                }
            }
        }
    )*};
}
floats!(f32 => "Float32", f64 => "Float64");

/// `Int`: an integer of any size, as its decimal digits. Writing it gives the
/// same digits back. Convert it with [`Int::to_i64`] / [`Int::to_i128`], or to
/// `num_bigint::BigInt` with the `bigint` feature. For a native integer that
/// must fit, the schema says `Int64` (decoded as `i64`, out of range is an error).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Int(String);

impl Int {
    pub fn as_str(&self) -> &str {
        &self.0
    }
    /// The value, if it fits.
    pub fn to_i64(&self) -> Option<i64> {
        self.0.parse().ok()
    }
    /// The value, if it fits.
    pub fn to_i128(&self) -> Option<i128> {
        self.0.parse().ok()
    }
}

#[cfg(feature = "bigint")]
impl From<num_bigint::BigInt> for Int {
    fn from(n: num_bigint::BigInt) -> Self {
        Int(n.to_string())
    }
}

#[cfg(feature = "bigint")]
impl From<&Int> for num_bigint::BigInt {
    fn from(n: &Int) -> Self {
        // An Int holds decimal digits with an optional minus sign, which always parse.
        n.0.parse().expect("an Int is a decimal integer")
    }
}

#[cfg(feature = "bigint")]
impl From<Int> for num_bigint::BigInt {
    fn from(n: Int) -> Self {
        (&n).into()
    }
}

impl From<i64> for Int {
    fn from(n: i64) -> Self {
        Int(n.to_string())
    }
}

impl From<i128> for Int {
    fn from(n: i128) -> Self {
        Int(n.to_string())
    }
}

impl Decode for Int {
    fn decode(v: &Value) -> R<Self> {
        match v {
            Value::Number(text) => match whole(text) {
                Some(n) => Ok(Int(n.to_owned())),
                None => Err(DecodeError::new(format!("expected a whole number (Int), found {text}"))),
            },
            _ => Err(mismatch("a number (Int)", v)),
        }
    }
}

/// `Decimal`: an exact decimal as written, scale kept (`19.90` is not `19.9`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Decimal(String);

impl Decimal {
    /// The literal: `19.90`, `-1e10`.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The value in units of 10^-`scale`, if that is exact and fits:
    /// `44.40` at scale 2 is `4440`; `19.999` at scale 2 is None.
    pub fn scaled(&self, scale: u32) -> Option<i128> {
        let (negative, text) = match self.0.strip_prefix('-') {
            Some(rest) => (true, rest),
            None => (false, self.0.as_str()),
        };
        let (mantissa, exp) = match text.split_once('e') {
            Some((m, e)) => (m, e.parse::<i64>().ok()?),
            None => (text, 0),
        };
        let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
        let digits = format!("{int}{frac}");
        // value = digits × 10^shift
        let shift = exp - i64::try_from(frac.len()).ok()? + i64::from(scale);
        let digits = if shift >= 0 {
            digits + &"0".repeat(usize::try_from(shift).ok().filter(|&s| s <= 40)?)
        } else {
            let cut = digits.len().saturating_sub(usize::try_from(-shift).ok()?);
            let (kept, dropped) = digits.split_at(cut);
            if dropped.bytes().any(|d| d != b'0') {
                return None;
            }
            kept.to_owned()
        };
        let n: i128 = if digits.is_empty() { 0 } else { digits.parse().ok()? };
        Some(if negative { -n } else { n })
    }

    /// `n` × 10^-`scale`, written with exactly `scale` decimal places: (4440, 2) is `44.40`.
    pub fn from_scaled(n: i128, scale: u32) -> Decimal {
        let digits = format!("{:0>width$}", n.unsigned_abs(), width = scale as usize + 1);
        let (int, frac) = digits.split_at(digits.len() - scale as usize);
        let sign = if n < 0 { "-" } else { "" };
        Decimal(if frac.is_empty() { format!("{sign}{int}") } else { format!("{sign}{int}.{frac}") })
    }
    /// A decimal from a literal; None if `text` isn't a decimal number.
    pub fn parse(text: &str) -> Option<Decimal> {
        match crate::parse(text).ok()?.as_slice() {
            [Value::Number(n)] => Some(Decimal(n.clone())),
            _ => None,
        }
    }
}

impl Decode for Decimal {
    fn decode(v: &Value) -> R<Self> {
        match v {
            Value::Number(text) => Ok(Decimal(text.clone())),
            _ => Err(mismatch("a number (Decimal)", v)),
        }
    }
}
