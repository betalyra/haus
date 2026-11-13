//! The canonical form, equality and hashing (spec §12): the same cases as
//! the TypeScript binding (typescript/packages/haus/test/canonical.test.ts).

use haus::{Value, canonical, equals};

fn parse(src: &str) -> Value {
    haus::from_str(src).unwrap()
}

fn c(src: &str) -> String {
    canonical(&parse(src))
}

#[test]
fn writes_the_spec_example() {
    assert_eq!(
        c(r#"Order { total: 19.90, id: 0xFF, "x-y": 1e+5, p: Point(1, 2) }"#),
        r#"Order{id:255,p:Point(1,2),total:19.90,"x-y":1e5}"#
    );
}

#[test]
fn ignores_layout_comments_order_and_spelling() {
    let a = parse(r#"{ b: [1_000, 0b11], /* c */ a: Tag({ x: x"0B 34" }) }"#);
    let b = parse(r#"{a:Tag{x:x"0b34"},b:[1000,3]}"#);
    assert_eq!(canonical(&a), r#"{a:Tag{x:x"0b34"},b:[1000,3]}"#);
    assert!(equals(&a, &b));
}

#[test]
fn keeps_what_equality_tells_apart() {
    assert!(!equals(&parse("1.0"), &parse("1")));
    assert!(!equals(&parse("{}"), &parse("{ x: None }")));
    assert!(!equals(&parse(r#""caf\u{E9}""#), &parse(r#""cafe\u{301}""#)));
    assert!(!equals(&parse("-0"), &parse("0")));
    assert!(equals(&parse("-0x0"), &parse("0")));
}

#[test]
fn escapes_only_what_it_must() {
    assert_eq!(c(r#""tab\tquote\" \u{41} \u{1b} \u{202e} café 😀""#), r#""tab\tquote\" A \u{1B} \u{202E} café 😀""#);
    assert_eq!(c("\"\"\"\n  two\n  lines\n  \"\"\""), r#""two\nlines""#);
}

#[test]
fn sorts_keys_by_code_point() {
    assert_eq!(c(r#"{ "😀": 1, "�": 2, a: 3, "Z": 4 }"#), r#"{"Z":4,a:3,"�":2,"😀":1}"#);
}

#[test]
fn writes_a_single_record_payload_as_tag_braces() {
    assert_eq!(c("[None, Some(1), Circle({ r: 1 }), Pair({ a: 1 }, 2)]"), "[None,Some(1),Circle{r:1},Pair({a:1},2)]");
}

#[test]
fn keeps_a_huge_hex_integer_in_hex() {
    let big = format!("0x{}", "f".repeat(900));
    assert_eq!(c(&big), big);
    // and the compact writer does the same (spec §11), so its output parses again
    assert_eq!(haus::ser::write(&parse(&big)), big);
}

#[test]
fn compare_orders_by_the_canonical_bytes() {
    let mut vs: Vec<Value> = ["9", "10", "[]", "\"\u{FFFD}\"", "\"😀\"", "{ b: 1, a: 2 }", "Some(1)", "-1"]
        .iter()
        .map(|s| parse(s))
        .collect();
    vs.sort_by(haus::compare);
    let got: Vec<String> = vs.iter().map(canonical).collect();
    assert_eq!(got, ["\"\u{FFFD}\"", "\"😀\"", "-1", "10", "9", "Some(1)", "[]", "{a:2,b:1}"]);
    assert_eq!(haus::compare(&parse("{ b: 1, a: 2 }"), &parse("{ a: 2, b: 1 }")), std::cmp::Ordering::Equal);
    assert_eq!(haus::compare(&parse("1.0"), &parse("1")), std::cmp::Ordering::Greater);
}

#[cfg(feature = "hash")]
#[test]
fn hash_is_sha256_of_the_canonical_form() {
    assert_eq!(haus::hash(&parse("{ a: 1 }")), "f09a9231c12685ac5f0b6f0b06c9154f13dc3a5b3548db5142c19bde1383f261");
    assert_eq!(
        haus::hash(&parse(r#"Order { total: 19.90, id: 0xFF, "x-y": 1e+5, p: Point(1, 2) }"#)),
        "d324549b0e26394cc4f2a1fc7ac2647179da2d244c66763381c9cb63dbf8a104"
    );
    assert_eq!(haus::hash(&parse("{ x: 1, y: [2] }")), haus::hash(&parse("{ y: [ 2, ], x: 1 }")));
}
