//! The haus data format.
//!
//! Without a schema, [`parse`] reads any haus text into [`Value`]s:
//!
//! ```
//! let values = haus::parse(r#"{ name: "Ada", born: Date("1815-12-10") }"#).unwrap();
//! assert_eq!(values[0].get("name"), Some(&haus::Value::String("Ada".into())));
//! ```
//!
//! That's a parser in the sense of spec §13.1: it reads the syntax and knows
//! no types. `Date("2026-02-30")` is just a tag with a string.
//!
//! With a schema, `haus-build` generates Rust types that implement [`Decode`]
//! and [`Encode`], and [`from_str`] / [`to_string`] check every rule of the
//! schema: closed records and variants, integer ranges, the std/time profile.
//! Writing checks the value too, since a [`Value`] built in code (the raw
//! value of an `Any`, say) may not be one a reader takes:
//!
//! ```
//! let fine = haus::Value::Number("1E5".into());
//! assert_eq!(haus::to_string(&fine).unwrap(), "1e5");
//! let wrong = haus::Value::Number("abc".into());
//! assert_eq!(haus::to_string(&wrong).unwrap_err().to_string(), "not a number literal");
//! ```

mod canonical;
mod codec;
pub mod de;
mod error;
mod float;
mod parser;
mod secret;
pub mod ser;
pub mod stream;
pub mod time;
mod value;

#[cfg(feature = "hash")]
pub use canonical::{Hasher, hash, hash_all};
pub use canonical::{canonical, compare, equals};
pub use codec::{Codec, same_id};
pub use de::{AnyTag, Bytes, Decimal, Decode, Int, Unknown};
pub use error::{DecodeError, EncodeError, Error, Segment, SyntaxError};
pub use parser::{Limits, parse_with};
pub use secret::Secret;
pub use ser::Encode;
pub use value::Value;

/// Include the Rust types haus-build generated for a schema:
/// `haus::include_schema!("order")` for `order.schema.haus`.
#[macro_export]
macro_rules! include_schema {
    ($name:literal) => {
        include!(concat!(env!("OUT_DIR"), "/", $name, ".rs"));
    };
}

/// Parse a file: zero or more top-level values, separated by commas.
pub fn parse(src: &str) -> Result<Vec<Value>, SyntaxError> {
    parse_with(src, &Limits::default())
}

/// Parse raw bytes, which must be UTF-8.
pub fn parse_bytes(src: &[u8]) -> Result<Vec<Value>, SyntaxError> {
    match std::str::from_utf8(src) {
        Ok(s) => parse(s),
        Err(e) => {
            let valid = std::str::from_utf8(&src[..e.valid_up_to()]).unwrap_or_default();
            Err(SyntaxError::at(valid, e.valid_up_to(), "invalid UTF-8"))
        }
    }
}

/// Read a file holding one value of type `T`.
pub fn from_str<T: Decode>(src: &str) -> Result<T, Error> {
    match parse(src)?.as_slice() {
        [v] => Ok(T::decode(v)?),
        vs => Err(DecodeError::new(format!("expected one value, found {}", vs.len())).into()),
    }
}

/// Read a stream: every top-level value as a `T`.
pub fn from_str_all<T: Decode>(src: &str) -> Result<Vec<T>, Error> {
    parse(src)?.iter().enumerate().map(|(i, v)| T::decode(v).map_err(|e| e.index(i).into())).collect()
}

/// Write one value on one line (the compact layout, spec §11). Fails if the
/// value isn't one a reader with the default limits takes, which only a
/// [`Value`] built in code can cause, such as the raw value of an `Any` or an
/// unknown variant (spec §9.8): see [`ser::write_with`].
pub fn to_string<T: Encode + ?Sized>(value: &T) -> Result<String, EncodeError> {
    to_string_with(value, &Limits::default())
}

/// [`to_string`], for a reader with `limits`: the value must be within them,
/// and integers longer than its number limit are written in hex.
pub fn to_string_with<T: Encode + ?Sized>(value: &T, limits: &Limits) -> Result<String, EncodeError> {
    ser::write_with(&value.encode(), limits)
}

/// Write a stream: one value per line, each followed by `,`. Errors say which value: `[3].total: …`.
pub fn to_string_all<T: Encode>(values: &[T]) -> Result<String, EncodeError> {
    values
        .iter()
        .enumerate()
        .map(|(i, v)| to_string(v).map(|line| line + ",\n").map_err(|e| e.within(Segment::Index(i))))
        .collect()
}
