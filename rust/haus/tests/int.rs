//! `Int` is an integer of any size (prelude), kept as its exact digits.

const ABOVE_2_128: &str = "340282366920938463463374607431768211457"; // 2^128 + 1

#[test]
fn int_of_any_size_writes_back_unchanged() {
    let n: haus::Int = haus::from_str(ABOVE_2_128).unwrap();
    assert_eq!(n.as_str(), ABOVE_2_128);
    assert_eq!(haus::to_string(&n).as_deref(), Ok(ABOVE_2_128));
    assert_eq!(n.to_i128(), None);
    assert_eq!(n.to_i64(), None);

    let small: haus::Int = haus::from_str("-0x10").unwrap();
    assert_eq!((small.to_i64(), small.to_i128()), (Some(-16), Some(-16)));
    assert!(haus::from_str::<haus::Int>("1.5").is_err());
}

#[cfg(feature = "bigint")]
#[test]
fn int_converts_to_and_from_num_bigint() {
    use num_bigint::BigInt;
    let n: haus::Int = haus::from_str(ABOVE_2_128).unwrap();
    let big = BigInt::from(&n);
    assert_eq!(big, (BigInt::from(1) << 128) + 1);
    assert_eq!(haus::Int::from(-big.clone()).as_str(), format!("-{ABOVE_2_128}"));
    assert_eq!(haus::Int::from(big), n);
    assert_eq!(BigInt::from(haus::Int::from(0i64)), BigInt::from(0));
}
