//! `@haus/geo`: points and boxes on the earth, generated from
//! `geo.schema.haus` (the same file as for every other language).
//!
//! ```
//! let lisbon: haus_geo::LatLng = haus::from_str("LatLng(38.7223, -9.1393)").unwrap();
//! assert_eq!((lisbon.0, lisbon.1), (38.7223, -9.1393));
//! ```

haus::include_schema!("geo");
