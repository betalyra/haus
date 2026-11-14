//! Encoding Rust values as haus: the [`Encode`] trait and the compact writer
//! (spec §11: one value per line, normal spacing), which checks what it writes.

use crate::de::{AnyTag, Bytes, Decimal, Int, Unknown};
use crate::{Codec, EncodeError, Limits, Secret, Segment, Value};
use std::borrow::Cow;
use std::collections::{BTreeMap, HashSet};
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
/// `Secret a`: the value in full (the receiver needs it).
pub fn secret<T>(s: &Secret<T>, f: impl FnOnce(&T) -> Value) -> Value {
    f(s.expose())
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
impl<T: Encode> Encode for Secret<T> {
    fn encode(&self) -> Value {
        secret(self, T::encode)
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
                    Value::Number(crate::float::text(*self))
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

/// One value on one line (spec §11, compact), with the default limits.
pub fn write(v: &Value) -> Result<String, EncodeError> {
    write_with(v, &Limits::default())
}

/// One value on one line, for a reader with `limits`. The value is checked as
/// it is written (spec §9.8), since one built in code may hold anything: number
/// literals (normalized as the parser reads them: `1E5` is written `1e5`), tag
/// names, unique keys, and the nesting depth and lengths of `limits`. An
/// integer longer than `limits.max_number_length` is written in hex, so
/// that the same reader takes it.
pub fn write_with(v: &Value, limits: &Limits) -> Result<String, EncodeError> {
    let mut out = String::new();
    Writer { out: &mut out, limits }.value(v, 0)?;
    Ok(out)
}

struct Writer<'a> {
    out: &'a mut String,
    limits: &'a Limits,
}

type W = Result<(), EncodeError>;

impl Writer<'_> {
    /// `v`, inside `depth` containers.
    fn value(&mut self, v: &Value, depth: usize) -> W {
        match v {
            Value::Number(n) => {
                let text = number(n, self.limits).map_err(EncodeError::new)?;
                self.out.push_str(&text);
            }
            Value::String(s) => {
                self.check_length(s)?;
                quote(s, self.out);
            }
            Value::Bytes(b) => {
                if b.len() > self.limits.max_string_length / 2 {
                    return Err(EncodeError::new(format!(
                        "byte string longer than {} characters",
                        self.limits.max_string_length
                    )));
                }
                self.out.push_str("x\"");
                for x in b {
                    let _ = write!(self.out, "{x:02x}");
                }
                self.out.push('"');
            }
            Value::Array(items) => {
                self.open(depth)?;
                self.out.push('[');
                self.items(items, depth + 1, Segment::Index)?;
                self.out.push(']');
            }
            Value::Record(fields) => self.record(fields, depth)?,
            Value::Variant { tag, args } => {
                if !is_tag(tag) {
                    return Err(EncodeError::new("not a tag name: A to Z, then letters, digits and _"));
                }
                self.out.push_str(tag);
                let within = |e: EncodeError| e.within(Segment::Tag(tag.clone()));
                match args.as_slice() {
                    [] => {}
                    [Value::Record(fields)] => {
                        self.out.push(' ');
                        self.record(fields, depth).map_err(within)?;
                    }
                    _ => {
                        self.open(depth)?;
                        self.out.push('(');
                        self.items(args, depth + 1, Segment::Index).map_err(within)?;
                        self.out.push(')');
                    }
                }
            }
        }
        Ok(())
    }

    /// Opening a container inside `depth` others.
    fn open(&self, depth: usize) -> W {
        if depth >= self.limits.max_depth {
            return Err(EncodeError::new(format!("nesting deeper than {} levels", self.limits.max_depth)));
        }
        Ok(())
    }

    /// Items separated by `, `, at `depth`.
    fn items(&mut self, items: &[Value], depth: usize, at: fn(usize) -> Segment) -> W {
        for (i, x) in items.iter().enumerate() {
            if i > 0 {
                self.out.push_str(", ");
            }
            self.value(x, depth).map_err(|e| e.within(at(i)))?;
        }
        Ok(())
    }

    fn record(&mut self, fields: &[(String, Value)], depth: usize) -> W {
        self.open(depth)?;
        if fields.is_empty() {
            self.out.push_str("{}");
            return Ok(());
        }
        // Keys are unique (spec §1): a record built in code might repeat one.
        if fields.len() > 1 {
            let mut seen = HashSet::with_capacity(fields.len());
            if let Some((k, _)) = fields.iter().find(|(k, _)| !seen.insert(k.as_str())) {
                return Err(EncodeError::new("the key is used twice in this record").within(Segment::Field(k.clone())));
            }
        }
        self.out.push_str("{ ");
        for (i, (k, v)) in fields.iter().enumerate() {
            if i > 0 {
                self.out.push_str(", ");
            }
            let within = |e: EncodeError| e.within(Segment::Field(k.clone()));
            self.check_length(k).map_err(within)?;
            key(k, self.out);
            self.out.push_str(": ");
            self.value(v, depth + 1).map_err(within)?;
        }
        self.out.push_str(" }");
        Ok(())
    }

    fn check_length(&self, s: &str) -> W {
        let max = self.limits.max_string_length;
        if s.len() > max && s.chars().count() > max {
            return Err(EncodeError::new(format!("string longer than {max} characters")));
        }
        Ok(())
    }
}

/// A tag name: `[A-Z][A-Za-z0-9_]*`.
fn is_tag(tag: &str) -> bool {
    tag.starts_with(|c: char| c.is_ascii_uppercase()) && tag.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

/// A key: bare if it is an identifier (`[a-z_][A-Za-z0-9_]*`), quoted otherwise.
pub(crate) fn key(k: &str, out: &mut String) {
    let bare = k.starts_with(|c: char| c.is_ascii_lowercase() || c == '_')
        && k.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_');
    if bare { out.push_str(k) } else { quote(k, out) }
}

/// The text a number is written as, for a reader with `limits`, or why it
/// can't be written: its normalized literal (spec §2), in hex if it is an
/// integer longer than the number limit.
fn number<'a>(text: &'a str, limits: &Limits) -> Result<Cow<'a, str>, String> {
    let too_long = || format!("number literal longer than {} characters", limits.max_number_length);
    let n: Cow<str> = if is_normalized(text) {
        text.into()
    } else if text.len() > limits.max_number_length {
        return Err(too_long());
    } else {
        // The exponent is checked below, on the normalized literal.
        let syntax = Limits { max_exponent: u64::MAX, ..*limits };
        crate::parser::number_literal(text, &syntax).ok_or("not a number literal")?.into()
    };
    if let Some((_, exp)) = n.split_once('e') {
        let digits = exp.trim_start_matches('-');
        if digits.len() > 19 || digits.parse::<u64>().map_or(true, |e| e > limits.max_exponent) {
            return Err(format!("exponent larger than {}", limits.max_exponent));
        }
    }
    if n.len() <= limits.max_number_length {
        return Ok(n);
    }
    let digits = n.strip_prefix('-').unwrap_or(&n);
    if !digits.bytes().all(|c| c.is_ascii_digit()) || hex_length_at_least(&n) > limits.max_number_length {
        return Err(too_long());
    }
    let hex = number_text(&n, limits.max_number_length);
    if hex.len() > limits.max_number_length {
        return Err(too_long());
    }
    Ok(hex.into_owned().into())
}

/// Whether `text` is a normalized literal (spec §2), as the parser gives it:
/// `-?(0|[1-9][0-9]*)(.[0-9]+)?(e(0|-?[1-9][0-9]*))?`.
fn is_normalized(text: &str) -> bool {
    fn whole(s: &str) -> bool {
        s == "0" || (s.starts_with(|c: char| ('1'..='9').contains(&c)) && s.bytes().all(|c| c.is_ascii_digit()))
    }
    let (mantissa, exp) = text.split_once('e').map_or((text, None), |(m, e)| (m, Some(e)));
    let mantissa = mantissa.strip_prefix('-').unwrap_or(mantissa);
    let (int, frac) = mantissa.split_once('.').map_or((mantissa, None), |(i, f)| (i, Some(f)));
    whole(int)
        && frac.is_none_or(|f| !f.is_empty() && f.bytes().all(|c| c.is_ascii_digit()))
        && exp.is_none_or(|e| whole(e) || e.strip_prefix('-').is_some_and(|d| d != "0" && whole(d)))
}

/// A lower bound of the length of an integer's hex literal, without converting
/// it: d decimal digits have at least ⌊(d − 1) · log₁₆ 10⌋ + 1 hex digits.
fn hex_length_at_least(n: &str) -> usize {
    let sign = usize::from(n.starts_with('-'));
    let digits = n.len() - sign;
    // 0.830482 is just below log₁₆ 10 = 0.8304820237…, so this stays a lower bound.
    let hex = (digits as u128 - 1) * 830_482 / 1_000_000 + 1;
    sign + 2 + usize::try_from(hex).unwrap_or(usize::MAX)
}

/// A number's normalized literal, except an integer longer than `max` (the
/// number limit, spec §7), which is written in hex so that it parses again
/// (§11, §12).
pub(crate) fn number_text(n: &str, max: usize) -> Cow<'_, str> {
    let (sign, digits) = n.strip_prefix('-').map_or(("", n), |d| ("-", d));
    if n.len() > max && digits.bytes().all(|c| c.is_ascii_digit()) {
        format!("{sign}0x{}", decimal_to_hex(digits)).into()
    } else {
        n.into()
    }
}

/// Decimal digits as lowercase hex, without leading zeros.
fn decimal_to_hex(digits: &str) -> String {
    // Little-endian limbs of base 2^32.
    let mut limbs: Vec<u64> = vec![0];
    for d in digits.bytes() {
        let mut carry = u64::from(d - b'0');
        for limb in &mut limbs {
            let v = *limb * 10 + carry;
            *limb = v & 0xffff_ffff;
            carry = v >> 32;
        }
        if carry > 0 {
            limbs.push(carry);
        }
    }
    let first = format!("{:x}", limbs.last().copied().unwrap_or(0));
    limbs.iter().rev().skip(1).fold(first, |mut out, limb| {
        let _ = write!(out, "{limb:08x}");
        out
    })
}

/// A `"…"` string with the minimal escapes.
pub(crate) fn quote(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if matches!(u32::from(c), 0..0x20 | 0x7F..=0x9F)
                || matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}') =>
            {
                let _ = write!(out, "\\u{{{:X}}}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}
