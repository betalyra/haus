//! The same order, decoded with the schema's own types and with the app's
//! codecs. The same steps as typescript/examples/order, on the same files.
//! Run: cargo run -p haus-example-order

mod codecs;

/// The schema's own types.
mod plain {
    haus::include_schema!("plain");
}

/// The same schema with the app's codecs (see build.rs).
mod typed {
    haus::include_schema!("typed");
}

const ORDER: &str = include_str!("../../../../examples/order.haus");

fn main() -> Result<(), haus::Error> {
    // Without codecs: Money is haus_money::Money(Decimal, AnyTag).
    let plain: plain::Root = haus::from_str(ORDER)?;
    let haus_money::Money(amount, currency) = &plain.total;
    println!("plain:  {} pays {} {currency}", plain.customer.0, amount.as_str());

    // With codecs: the fields have the codecs' types.
    let typed: typed::Root = haus::from_str(ORDER)?;
    println!(
        "typed:  {} pays {} cents, deliver to [lng, lat] {:?}",
        typed.customer.0, typed.total.cents, typed.deliver_to
    );
    println!("placed: {}, a {:?}", typed.placed, typed.placed.weekday());

    // Variants are enums: match on them.
    match &typed.status {
        typed::Status::Shipped { tracking } => println!("status: shipped, tracking {tracking}"),
        typed::Status::Pending | typed::Status::Cancelled => println!("status: not on its way"),
    }

    // Encoding with the same codecs gives back the same haus text.
    println!("{}", haus::to_string(&typed)?);

    // Codecs add rules on top of the schema's: Eur is a valid tag, but not ISO-shaped.
    let eur = ORDER.replace("EUR", "Eur");
    if haus::from_str::<plain::Root>(&eur).is_ok() {
        println!("Eur without codecs: accepted");
    }
    if let Err(e) = haus::from_str::<typed::Root>(&eur) {
        println!("Eur with codecs: {e}");
    }
    if let Err(e) = haus::from_str::<typed::Root>(&ORDER.replace("44.40", "44.405")) {
        println!("44.405 with codecs: {e}");
    }
    Ok(())
}
