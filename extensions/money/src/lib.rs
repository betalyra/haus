//! `@haus/money`: exact amounts with a currency, generated from
//! `money.schema.haus` (the same file as for every other language).
//!
//! ```
//! let m: haus_money::Money = haus::from_str("Money(19.90, EUR)").unwrap();
//! assert_eq!(m.0.as_str(), "19.90");
//! assert_eq!(m.1, haus::AnyTag::Bare("EUR".into()));
//! ```

haus::include_schema!("money");
