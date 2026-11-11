//! Codecs (spec §13.4): an application's choice of Rust type for a named
//! haus type, selected by the type's id.
//!
//! ```
//! use haus::{Codec, time::Date};
//!
//! /// std/time#Date as (year, month, day).
//! pub struct Ymd;
//! impl Codec for Ymd {
//!     const ID: &'static str = Date::ID;
//!     type Base = Date;
//!     type Target = (u16, u8, u8);
//!     fn decode(d: Date) -> Result<Self::Target, String> {
//!         let p: Vec<&str> = d.as_str().split('-').collect();
//!         Ok((p[0].parse().unwrap(), p[1].parse().unwrap(), p[2].parse().unwrap()))
//!     }
//!     fn encode(&(y, m, d): &Self::Target) -> Date {
//!         Date::new(format!("{y:04}-{m:02}-{d:02}")).unwrap()
//!     }
//! }
//! ```
//!
//! haus-build replaces every use of the type `ID` with `Target`, and checks
//! at compile time that the schema has a type with that id.

use crate::{Decode, Encode};

pub trait Codec {
    /// The id of the type this codec is for: `@haus/money@1#Money`, `std/time#Date`.
    const ID: &'static str;
    /// That type, as decoded without the codec.
    type Base: Decode + Encode;
    /// The type the application gets.
    type Target;
    /// Runs after the base type has decoded: may reject more values, never fewer.
    fn decode(base: Self::Base) -> Result<Self::Target, String>;
    /// Back to the base type: encoding what was decoded gives an equal value.
    fn encode(value: &Self::Target) -> Self::Base;
}

/// String equality in a const context (for the generated id checks).
pub const fn same_id(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}
