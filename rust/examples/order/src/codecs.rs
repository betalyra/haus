//! Codecs: the application chooses Rust types for named haus types. Each one
//! decodes the type's base value first, so the schema's rules always run,
//! and encodes back to it, so the haus text never changes (spec §13.4).

use haus::{AnyTag, Codec, Decimal, time};
use haus_geo::LatLng;
use haus_money::Money;

/// Integer cents, as payment APIs want them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Amount {
    pub cents: i128,
    /// An ISO 4217 code: three letters A–Z.
    pub currency: String,
}

/// `Money(44.40, EUR)` ↔ `Amount { cents: 4440, currency: "EUR" }`. More than
/// 2 decimal places, or a currency that isn't ISO-shaped, is an error.
pub struct Cents;

impl Codec for Cents {
    const ID: &'static str = Money::ID;
    type Base = Money;
    type Target = Amount;

    fn decode(Money(amount, currency): Money) -> Result<Amount, String> {
        let cents = amount.scaled(2).ok_or_else(|| format!("{} has more than 2 decimal places", amount.as_str()))?;
        Ok(Amount { cents, currency: iso(currency)? })
    }

    fn encode(amount: &Amount) -> Money {
        Money(Decimal::from_scaled(amount.cents, 2), AnyTag::Bare(amount.currency.clone()))
    }
}

/// The @haus/money iso profile: a currency is three letters A–Z.
fn iso(currency: AnyTag) -> Result<String, String> {
    match currency {
        AnyTag::Bare(code) if code.len() == 3 && code.bytes().all(|b| b.is_ascii_uppercase()) => Ok(code),
        other => Err(format!("{other} is not a currency: three letters A–Z (ISO 4217)")),
    }
}

/// GeoJSON order: `LatLng(38.7223, -9.1393)` ↔ `[-9.1393, 38.7223]`. The swap happens here, once.
pub struct GeoJson;

impl Codec for GeoJson {
    const ID: &'static str = LatLng::ID;
    type Base = LatLng;
    type Target = [f64; 2];

    fn decode(LatLng(lat, lng): LatLng) -> Result<[f64; 2], String> {
        Ok([lng, lat])
    }

    fn encode(&[lng, lat]: &[f64; 2]) -> LatLng {
        LatLng(lat, lng)
    }
}

/// std/time types take codecs too: `Date("2026-11-09")` ↔ `jiff::civil::Date`.
pub struct JiffDate;

impl Codec for JiffDate {
    const ID: &'static str = time::Date::ID;
    type Base = time::Date;
    type Target = jiff::civil::Date;

    fn decode(date: time::Date) -> Result<jiff::civil::Date, String> {
        // The std/time profile already ran: this can't fail for a valid Date.
        date.as_str().parse().map_err(|e: jiff::Error| e.to_string())
    }

    fn encode(date: &jiff::civil::Date) -> time::Date {
        time::Date::new(date.to_string()).expect("jiff writes YYYY-MM-DD")
    }
}
