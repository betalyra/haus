//! The code haus-build generates, for every kind of type (features.schema.haus, next to Cargo.toml).

mod features {
    haus::include_schema!("features");
}

use features::{AppEvent, Item, Kind, Login, Person, Scores, Shape, Tree};
use haus::{DecodeError, Error, Unknown, Value, from_str, to_string};

const ADA: &str = r#"{ name: "Ada", email: Some("ada@example.com"), type: Member { since: Date("1843-01-01") }, createdAt: Instant("2026-11-09T14:30:00Z"), address: { street: "St James's Square", city: "London" }, scores: { maths: 100 }, check: Ok(7), friends: [], shape: Circle(1.5), tree: Node(Leaf, Node(Leaf, Leaf)) }"#;

fn decode_error<T: haus::Decode + std::fmt::Debug>(text: &str) -> DecodeError {
    match from_str::<T>(text) {
        Err(Error::Decode(e)) => e,
        other => panic!("expected a decode error, got {other:?}"),
    }
}

#[test]
fn decodes_into_rust_types() {
    let ada: Person = from_str(ADA).unwrap();
    assert_eq!(ada.name, "Ada");
    assert_eq!(ada.nickname, None);
    assert_eq!(ada.email.as_deref(), Some("ada@example.com"));
    assert!(matches!(&ada.r#type, Kind::Member { since } if since.as_str() == "1843-01-01"));
    assert_eq!(ada.created_at.as_str(), "2026-11-09T14:30:00Z");
    assert_eq!(ada.address.city, "London");
    assert_eq!(ada.scores["maths"], 100);
    assert_eq!(ada.check, Ok(7));
    assert_eq!(ada.shape, Shape::Circle(1.5));
    assert_eq!(
        ada.tree,
        Tree::Node(Box::new(Tree::Leaf), Box::new(Tree::Node(Box::new(Tree::Leaf), Box::new(Tree::Leaf))))
    );
}

#[test]
fn encodes_back_to_the_same_text() {
    let ada: Person = from_str(ADA).unwrap();
    assert_eq!(to_string(&ada), ADA);
}

#[test]
fn recursion_and_generics() {
    let with_best = ADA.replace("friends: []", &format!("friends: [{ADA}], best: {ADA}"));
    let ada: Person = from_str(&with_best).unwrap();
    assert_eq!(ada.friends[0].name, "Ada");
    assert_eq!(ada.best.as_ref().map(|b| b.name.as_str()), Some("Ada"));

    let scores: Scores = from_str(r#"{ items: [1, 2, 3], next: "page-2" }"#).unwrap();
    assert_eq!(scores.items.iter().map(haus::Int::to_i128).collect::<Vec<_>>(), [Some(1), Some(2), Some(3)]);
    assert_eq!(scores.next.as_deref(), Some("page-2"));
}

#[test]
fn open_variants_keep_unknown_tags() {
    let shape: Shape = from_str("Triangle(1, 2, 3)").unwrap();
    let three = ["1", "2", "3"].map(|n| Value::Number(n.into())).to_vec();
    assert_eq!(shape, Shape::Unknown(Unknown { tag: "Triangle".into(), args: three }));
    assert_eq!(to_string(&shape), "Triangle(1, 2, 3)");
}

#[test]
fn errors_say_where() {
    let unknown = decode_error::<Person>(&ADA.replace("Member { since: Date(\"1843-01-01\") }", "Guest"));
    assert_eq!(unknown.to_string(), ".type: unknown tag Guest; expected one of Admin, Member");

    let date = decode_error::<Person>(&ADA.replace("1843-01-01", "1843-02-30"));
    assert_eq!(
        date.to_string(),
        r#".type(Member).since(Date)[0]: "1843-02-30" is not a valid Date: 1843-02 has no day 30"#
    );

    let range = decode_error::<Person>(&ADA.replace("maths: 100", "maths: 300"));
    assert_eq!(range.to_string(), ".scores.maths: 300 is out of range for Int8 (-128 to 127)");

    let closed = decode_error::<Person>(&ADA.replace("{ name", "{ age: 36, name"));
    assert_eq!(closed.to_string(), "unknown field \"age\" in a closed record");

    let missing = decode_error::<Person>(&ADA.replace("name: \"Ada\", ", ""));
    assert_eq!(missing.to_string(), "missing field name");

    let deep = decode_error::<Person>(&ADA.replace("Node(Leaf, Leaf)", "Node(Leaf, 1)"));
    assert_eq!(deep.to_string(), ".tree(Node)[1](Node)[1]: expected a variant (Tree), found the number 1");
}

#[test]
fn spreads_copy_tags_and_fields() {
    let event: AppEvent = from_str(r#"Failed { reason: "timeout" }"#).unwrap();
    assert!(matches!(&event, AppEvent::Failed { reason } if reason == "timeout"));
    assert!(matches!(from_str::<AppEvent>("Placed { order: 7 }").unwrap(), AppEvent::Placed { .. }));
    // AppEvent is closed, although BaseEvent (which it spreads) is open.
    assert!(from_str::<AppEvent>("Shipped").is_err());

    let item: Item = from_str(r#"{ id: 1, label: "a" }"#).unwrap();
    assert_eq!(item.label, "a");
    assert_eq!(to_string(&item), r#"{ id: 1, label: "a" }"#);
    assert!(from_str::<Item>(r#"{ id: 1, label: "a", extra: 2 }"#).is_err());
}

#[test]
fn secrets_stay_hidden() {
    let text = r#"{ user: "ada", password: "hunter2", pin: 1234, extra: [1, Some { a: 19.90 }] }"#;
    let login: Login = from_str(text).unwrap();
    assert_eq!(login.password.expose(), "hunter2");
    assert_eq!(login.pin.as_ref().map(|p| *p.expose()), Some(1234));
    let debug = format!("{login:?}");
    assert!(debug.contains("password: <redacted>") && !debug.contains("hunter2") && !debug.contains("1234"), "{debug}");
    // Encoding writes secrets in full, and Any as it was.
    assert_eq!(to_string(&login), text);

    // Errors name the place and the type, never the value.
    let e = decode_error::<Login>(r#"{ user: "ada", password: 4711 }"#);
    assert_eq!(e.to_string(), ".password: not a valid Secret String (the value is hidden)");
    let e = decode_error::<Login>(r#"{ user: "ada", password: "x", pin: 98765 }"#);
    assert_eq!(e.to_string(), ".pin: not a valid Secret UInt16 (the value is hidden)");
    assert!(!e.to_string().contains("98765"));
}

#[test]
#[allow(deprecated)]
fn deprecated_fields_still_decode() {
    let login: Login = from_str(r#"{ user: "ada", password: "x", name: "Ada" }"#).unwrap();
    assert_eq!(login.name.as_deref(), Some("Ada"));
}

#[test]
#[allow(deprecated)]
fn deprecated_single_tag_variants_still_decode() {
    let legacy: features::Legacy = from_str("Only(7)").unwrap();
    assert_eq!(legacy.0.to_i128(), Some(7));
    assert_eq!(to_string(&legacy), "Only(7)");
}
