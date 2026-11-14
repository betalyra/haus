//! `Secret a` (spec §15): the same data as `a`, in a type that keeps it out
//! of logs and error messages.
//!
//! ```
//! use haus::Secret;
//!
//! let key: Secret<String> = haus::from_str(r#""sk-123""#).unwrap();
//! assert_eq!(format!("{key:?}"), "<redacted>");
//! assert_eq!(key.expose(), "sk-123");
//! assert_eq!(haus::to_string(&key), r#""sk-123""#);
//! ```

use crate::{Decode, DecodeError, Value};
use std::fmt;

/// A value that `Debug` and `Display` print as `<redacted>`. Get it with
/// [`Secret::expose`] or [`Secret::into_inner`]. Encoding writes it in full:
/// the receiver needs it.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct Secret<T>(T);

impl<T> Secret<T> {
    pub fn new(value: T) -> Secret<T> {
        Secret(value)
    }

    /// The value.
    pub fn expose(&self) -> &T {
        &self.0
    }

    /// The value, taking it out.
    pub fn into_inner(self) -> T {
        self.0
    }
}

impl<T> From<T> for Secret<T> {
    fn from(value: T) -> Self {
        Secret(value)
    }
}

impl<T> fmt::Debug for Secret<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

impl<T> fmt::Display for Secret<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

/// Errors say only that the value isn't a valid `Secret` (see [`crate::de::secret`]).
impl<T: Decode> Decode for Secret<T> {
    fn decode(v: &Value) -> Result<Self, DecodeError> {
        crate::de::secret(v, "Secret", T::decode)
    }
}

#[cfg(test)]
mod tests {
    use super::Secret;
    use crate::{DecodeError, Error, Value, from_str};

    #[test]
    fn printing_hides_the_value() {
        let key = Secret::new("sk-123".to_owned());
        assert_eq!(format!("{key:?}"), "<redacted>");
        assert_eq!(format!("{key}"), "<redacted>");
        assert_eq!(format!("{:?}", Some(&key)), "Some(<redacted>)");
        assert_eq!(key.expose(), "sk-123");
        assert_eq!(key.clone().into_inner(), "sk-123");
        assert_eq!(key, Secret::from("sk-123".to_owned()));
    }

    #[test]
    fn errors_hide_the_value() {
        let decode_error = |text: &str| match from_str::<Secret<u8>>(text) {
            Err(Error::Decode(e)) => e,
            other => panic!("expected a decode error, got {other:?}"),
        };
        for text in ["300", "1.5", "\"1234\"", "[1, 2]"] {
            let e = decode_error(text);
            assert_eq!(e, DecodeError::new("not a valid Secret (the value is hidden)"), "{text}");
        }
        let nested = crate::de::Record::new(&crate::parse("{ pin: 9999 }").unwrap()[0], "Config")
            .and_then(|r| r.required("pin", <Secret<u8> as crate::Decode>::decode))
            .unwrap_err();
        assert_eq!(nested.to_string(), ".pin: not a valid Secret (the value is hidden)");
        assert!(!nested.to_string().contains("9999"));
        // A secret whose inner error has a path of its own (a key of the data) loses it too.
        let map = from_str::<Secret<std::collections::BTreeMap<String, u8>>>("{ hunter2: 300 }").unwrap_err();
        assert!(!map.to_string().contains("hunter2") && !map.to_string().contains("300"), "{map}");
    }

    #[test]
    fn encodes_in_full() {
        let key: Secret<String> = from_str("\"sk-123\"").unwrap();
        assert_eq!(crate::Encode::encode(&key), Value::String("sk-123".into()));
    }
}
