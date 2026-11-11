//! Errors in schemas: where they are and what they say.

use haus_build::{Codec, Packages, generate};

fn error(schema: &str) -> String {
    generate(schema, "test/schema", &[], &Packages::none()).expect_err("an error").to_string()
}

#[test]
fn syntax() {
    assert_eq!(error("type A = { a: String"), "1:21: expected '}', found end of file");
    assert_eq!(error("type A = { a String }"), "1:14: expected ':', found 'String'");
    assert_eq!(error("type a = String"), "1:6: expected a type name, found 'a'");
    assert_eq!(error("type A = closed [ ]"), "1:17: expected '{' or '<' after closed, found '['");
    assert_eq!(error("type A = String\n= Int"), "2:1: expected 'type' or 'import', found '='");
    assert_eq!(error("/* never closed\ntype A = String"), "2:16: expected */ closing the comment, found end of file");
}

#[test]
fn rules() {
    assert_eq!(error("type A = { a: String, a: Int }"), "1:23: duplicate field a");
    assert_eq!(error("type A = < X | X >"), "1:16: duplicate tag X");
    assert_eq!(error("type A = closed < >"), "1:17: a closed variant needs at least one tag");
    assert_eq!(error("type A = String\ntype A = Int"), "2:6: A is defined twice");
    assert_eq!(error("type A = Strin"), "1:10: unknown type Strin");
    assert_eq!(
        error("type A = { total: Money }"),
        "1:19: unknown type Money (import it with: import @haus/money (Money))"
    );
    assert_eq!(error("type A = Array"), "1:10: Array takes 1 argument(s), found 0");
    assert_eq!(error("type A = { a: b }"), "1:15: unknown type parameter b");
}

#[test]
fn spreads() {
    assert_eq!(
        error("type E r = < A | ...r >"),
        "1:21: row parameters (...r) aren't supported; spread a named type instead: ...UserEvent"
    );
    assert_eq!(error("type E = < A >\ntype B = < A | ...E >"), "2:19: duplicate tag A");
    assert_eq!(error("type E = { x: Int }\ntype B = < ...E >"), "2:15: E is not a variant, so it can't be spread here");
    assert_eq!(error("type B = < ...Missing >"), "1:15: unknown type Missing");
    assert_eq!(
        error("type P a = < A a >\ntype B = < ...P >"),
        "2:15: P has parameters (P a); only a type without parameters can be spread"
    );
    assert_eq!(
        error("type A = < X | ...B >\ntype B = < Y | ...A >"),
        "2:6: type B spreads itself (directly or through another type)"
    );
    assert_eq!(
        error("import std/time (Date)\ntype B = < ...Date >"),
        "2:15: Date is imported; haus-build can spread only types defined in this file so far"
    );
}

#[test]
fn imports() {
    assert_eq!(
        error("import std/time (Data)"),
        "1:1: std/time has no type Data (it has Date, Time, DateTime, Instant, ZonedDateTime, Duration, YearMonth, TimeZone)"
    );
    assert!(
        error("import @acme/ids (UserId)")
            .starts_with("1:1: package @acme/ids not found among this crate's dependencies")
    );
}

#[test]
fn codecs() {
    let e = generate(
        "type A = String",
        "test/schema",
        &[Codec { id: "test/schema#B".into(), path: "crate::B".into() }],
        &Packages::none(),
    )
    .unwrap_err();
    assert_eq!(e.to_string(), "1:1: a codec for test/schema#B, but the schema has no such type (it has test/schema#A)");
}
