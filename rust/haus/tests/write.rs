//! The compact writer checks what it writes (spec §9.8): every value the
//! parser gives is written again, under the same limits, and parses back.

use haus::{Limits, Value, parse_with, ser};

fn roundtrip(text: &str, limits: &Limits) {
    let [value] = parse_with(text, limits).unwrap_or_else(|e| panic!("{text}: {e}")).try_into().unwrap();
    let written = ser::write_with(&value, limits).unwrap_or_else(|e| panic!("{text}: {e}"));
    assert_eq!(parse_with(&written, limits).unwrap(), [value], "{text}");
}

#[test]
fn writes_every_parsed_value_again() {
    let limits = Limits::default();
    for depth in [1, 255, 256] {
        roundtrip(&format!("{}1{}", "[".repeat(depth), "]".repeat(depth)), &limits);
        roundtrip(&format!("{}{{}}{}", "A { a: ".repeat(depth - 1), " }".repeat(depth - 1)), &limits);
        roundtrip(&format!("{}N{}", "C(1, ".repeat(depth), ")".repeat(depth)), &limits);
    }
    for text in ["0x".to_owned() + &"f".repeat(900), "-0x".to_owned() + &"F".repeat(900), "1e6144".into(), "-0".into()]
    {
        roundtrip(&text, &limits);
    }
    let raised = Limits { max_number_length: 3000, max_exponent: 9000, max_depth: 300, ..limits };
    for text in
        ["1".repeat(2500), "0x".to_owned() + &"f".repeat(2500), "1e9000".into(), "[".repeat(300) + &"]".repeat(300)]
    {
        roundtrip(&text, &raised);
    }
    let lowered = Limits { max_number_length: 20, max_string_length: 4, max_depth: 2, ..limits };
    for text in ["0xFFFFFFFFFFFFFFFFFF", "\"abcd\"", "x\"0102\"", "[[1]]", "A { a: [1] }"] {
        roundtrip(text, &lowered);
    }
}

#[test]
fn values_beyond_the_limits_are_not_written() {
    let error = |v: &Value, limits: &Limits| ser::write_with(v, limits).unwrap_err().to_string();
    let small = Limits { max_string_length: 4, max_depth: 2, ..Limits::default() };
    assert_eq!(error(&Value::String("abcde".into()), &small), "string longer than 4 characters");
    assert_eq!(ser::write_with(&Value::String("äöüß".into()), &small).as_deref(), Ok("\"äöüß\""));
    assert_eq!(error(&Value::Bytes(vec![1, 2, 3]), &small), "byte string longer than 4 characters");
    let nested = Value::Array(vec![Value::Array(vec![Value::Array(vec![])])]);
    assert_eq!(error(&nested, &small), "[0][0]: nesting deeper than 2 levels");
    let key = Value::Record(vec![("abcde".into(), Value::Number("1".into()))]);
    assert_eq!(error(&key, &small), ".abcde: string longer than 4 characters");
    for n in ["", "-", "1.", ".5", "01", "1e", "+1", "0x", "1 ", "1 // c", "NaN", "1e5.5"] {
        assert_eq!(error(&Value::Number(n.into()), &Limits::default()), "not a number literal", "{n:?}");
    }
    for (n, written) in [("1E+05", "1e5"), ("1e-0", "1e0"), ("-0x0", "0"), ("0b101", "5"), ("-1_0.5_0", "-10.50")] {
        assert_eq!(ser::write(&Value::Number(n.into())).as_deref(), Ok(written), "{n:?}");
    }
}
