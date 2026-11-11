//! Print the error for each file given: `cargo run --example errors -- FILE…`
fn main() {
    for path in std::env::args().skip(1) {
        let name = std::path::Path::new(&path).file_stem().unwrap().to_string_lossy().into_owned();
        match haus::parse_bytes(&std::fs::read(&path).unwrap()) {
            Ok(_) => println!("{name}: ok"),
            Err(e) => println!("{name}: {e}"),
        }
    }
}
