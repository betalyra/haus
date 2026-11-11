//! Streams: values arrive in chunks split anywhere (the same cases as the
//! TypeScript binding's StreamReader tests).

use haus::stream::{Options, Reader, decode, encode, values};
use haus::{Limits, SyntaxError, Value};
use std::fs;
use std::path::Path;

fn tag(t: &str) -> Value {
    Value::Variant { tag: t.into(), args: vec![] }
}

/// All values of `bytes`, read in chunks of `size` bytes.
fn chunked(bytes: &[u8], size: usize) -> Result<Vec<Value>, SyntaxError> {
    let mut reader = Reader::default();
    let mut out = bytes.chunks(size).map(|c| reader.push(c)).collect::<Result<Vec<_>, _>>()?.concat();
    out.extend(reader.finish()?);
    Ok(out)
}

fn suite(dir: &str) -> Vec<Vec<u8>> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-suite").join(dir);
    let mut paths: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "haus"))
        .collect();
    paths.sort();
    paths.iter().map(|p| fs::read(p).unwrap()).collect()
}

#[test]
fn any_chunking_gives_the_same_values() {
    for bytes in suite("valid") {
        let whole = haus::parse_bytes(&bytes).unwrap();
        for size in (1..10).chain([bytes.len().max(1)]) {
            assert_eq!(chunked(&bytes, size).unwrap(), whole, "chunk size {size}: {}", String::from_utf8_lossy(&bytes));
        }
    }
}

#[test]
fn invalid_input_is_rejected_in_any_chunking() {
    for bytes in suite("invalid") {
        for size in [1, 5, bytes.len().max(1)] {
            assert!(chunked(&bytes, size).is_err(), "chunk size {size} accepted: {}", String::from_utf8_lossy(&bytes));
        }
    }
}

#[test]
fn emits_each_value_as_soon_as_its_comma_arrives() {
    let mut r = Reader::default();
    assert_eq!(r.push(b"UserCreated { id: 1 ").unwrap(), []);
    assert_eq!(r.push(b"}").unwrap(), []); // a payload could still follow
    assert_eq!(r.push(b",\nHeart").unwrap().len(), 1);
    assert_eq!(r.push(b"beat").unwrap(), []);
    assert_eq!(r.finish().unwrap(), [tag("Heartbeat")]);
}

#[test]
fn does_not_split_on_commas_inside_strings_comments_or_payloads() {
    let text = "\"a,b\", /* , */ Pair(1, 2), // ,\n\"\"\"\n  x,\n  \"\"\",";
    let all = chunked(text.as_bytes(), 1).unwrap();
    assert_eq!(all[0], Value::String("a,b".into()));
    assert!(matches!(&all[1], Value::Variant { tag, args } if tag == "Pair" && args.len() == 2));
    assert_eq!(all[2], Value::String("x,".into()));
}

#[test]
fn reads_comments_between_values_split_anywhere() {
    let text = "// header, with a comma\nA { x: 1 }, // after A, [unbalanced\n/* block, with } and \" and /* nested, */ */\nB(2),\n\n// before C\nC { s: \"// not a comment\" } /* before the comma */ ,\n// trailing comment, {";
    let whole = haus::parse(text).unwrap();
    assert_eq!(whole.len(), 3);
    let bytes = text.as_bytes();
    for k in 0..=bytes.len() {
        let mut r = Reader::default();
        let mut got = r.push(&bytes[..k]).unwrap();
        got.extend(r.push(&bytes[k..]).unwrap());
        got.extend(r.finish().unwrap());
        assert_eq!(got, whole, "split at {k}");
    }
}

#[test]
fn errors_have_positions_in_the_whole_stream() {
    let mut r = Reader::default();
    r.push(b"A,\nB,\n").unwrap();
    let e = r.push(b"{ ok: true },").unwrap_err();
    assert_eq!((e.line, e.column), (3, 7));
}

#[test]
fn require_terminator_reports_a_cut_off_last_value() {
    let mut r = Reader::new(Options { require_terminator: true, ..Options::default() });
    assert_eq!(r.push(b"1000,\n100").unwrap().len(), 1);
    assert!(r.finish().unwrap_err().reason.contains("truncated"));
}

#[test]
fn max_value_length_bounds_memory_for_a_value_that_never_ends() {
    let mut r = Reader::new(Options { max_value_length: 100, ..Options::default() });
    let e = r.push(format!("[{}", "1, ".repeat(100)).as_bytes()).unwrap_err();
    assert!(e.reason.contains("value longer than 100"));
}

#[test]
fn limits_apply_to_each_value() {
    let limits = Limits { max_number_length: 5, ..Limits::default() };
    let mut r = Reader::new(Options { limits, ..Options::default() });
    assert!(r.push(b"12345, 123456,").unwrap_err().reason.contains("number literal longer than 5"));
}

#[test]
fn utf8_split_across_chunks() {
    let bytes = "\"Olá 😀\",".as_bytes();
    assert_eq!(chunked(bytes, 1).unwrap(), [Value::String("Olá 😀".into())]);
}

#[test]
fn reads_from_io_and_decodes() {
    let input = "Some(1),\nNone,\nSome(3),\n".as_bytes();
    assert_eq!(values(input).count(), 3);
    let decoded: Vec<Option<u8>> = decode(input).collect::<Result<_, _>>().unwrap();
    assert_eq!(decoded, [Some(1), None, Some(3)]);

    let e = decode::<Option<u8>, _>("Some(1),\nSome(300),\n".as_bytes()).find_map(Result::err).unwrap();
    assert_eq!(e.to_string(), "[1](Some)[0]: 300 is out of range for UInt8 (0 to 255)");
}

#[test]
fn encodes_one_value_per_line() {
    let mut out = Vec::new();
    encode(&mut out, [Some(1u8), None]).unwrap();
    assert_eq!(String::from_utf8(out).unwrap(), "Some(1),\nNone,\n");
}
