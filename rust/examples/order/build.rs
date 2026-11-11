//! One schema, compiled twice: with its own types, and with the app's codecs.

fn main() -> Result<(), haus_build::Error> {
    let schema = "../../../examples/order.schema.haus";

    // The schema's own types: Money is haus_money::Money(Decimal, AnyTag).
    haus_build::Config::new().compile_as(schema, "plain")?;

    // The app's types: each codec replaces one named type, selected by its id.
    haus_build::Config::new()
        .codec("@haus/money@1#Money", "crate::codecs::Cents")
        .codec("@haus/geo@1#LatLng", "crate::codecs::GeoJson")
        .codec("std/time#Date", "crate::codecs::JiffDate")
        .compile_as(schema, "typed")
}
