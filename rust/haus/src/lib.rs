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

mod canonical;
mod codec;
pub mod de;
mod error;
mod parser;
pub mod ser;
pub mod stream;
pub mod time;
mod value;

#[cfg(feature = "hash")]
pub use canonical::hash;
pub use canonical::{canonical, compare, equals};
pub use codec::{Codec, same_id};
pub use de::{AnyTag, Bytes, Decimal, Decode, Int, Unknown};
pub use error::{DecodeError, Error, Segment, SyntaxError};
pub use parser::{Limits, parse_with};
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

/// Write one value on one line (the compact layout, spec §11).
pub fn to_string<T: Encode + ?Sized>(value: &T) -> String {
    ser::write(&value.encode())
}

/// Write a stream: one value per line, each followed by `,`.
pub fn to_string_all<T: Encode>(values: &[T]) -> String {
    values.iter().map(|v| to_string(v) + ",\n").collect()
}
