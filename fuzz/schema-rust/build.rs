//! Generates the Rust types of every schema the fuzzer uses (test-suite/schema
//! and fuzz/schema), and `roundtrip(suite, type, value)`: decode a value with a
//! type named by a string, then encode the result.

use std::path::{Path, PathBuf};
use std::{env, fs};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
    let dirs = [manifest.join("../../test-suite/schema"), manifest.join("../schema")];
    let mut schemas: Vec<(String, PathBuf)> = Vec::new();
    for dir in &dirs {
        println!("cargo::rerun-if-changed={}", dir.display());
        for entry in fs::read_dir(dir)? {
            let path = entry?.path();
            let file = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
            if let Some(name) = file.strip_suffix(".schema.haus") {
                schemas.push((name.to_owned(), path));
            }
        }
    }
    schemas.sort();
    let mut code = String::from("/// Decode `v` with `ty` of the schema `suite`, then encode the result; None if there is no such type.\n");
    code += "pub fn roundtrip(suite: &str, ty: &str, v: &::haus::Value) -> Option<Result<::haus::Value, ::haus::DecodeError>> {\n    match suite {\n";
    for (name, _) in &schemas {
        code += &format!("        {name:?} => {name}::roundtrip(ty, v),\n");
    }
    code += "        _ => None,\n    }\n}\n\n";
    for (name, path) in &schemas {
        haus_build::Config::new().quiet().compile_as(path, &format!("suite_{name}"))?;
        code += &module(name, &fs::read_to_string(path)?);
    }
    fs::write(Path::new(&env::var("OUT_DIR")?).join("schemas.rs"), code)?;
    Ok(())
}

/// The names of a schema's non-generic definitions: `type Name = …` at the
/// start of a line, leaving out streams.
fn definitions(text: &str) -> Vec<&str> {
    text.lines()
        .filter_map(|line| line.strip_prefix("type "))
        .filter_map(|def| def.split_once('='))
        .filter(|(_, ty)| !ty.trim_start().starts_with("Stream "))
        .map(|(name, _)| name.trim())
        .filter(|name| !name.is_empty() && !name.contains(char::is_whitespace))
        .collect()
}

fn module(name: &str, text: &str) -> String {
    let arms: String = definitions(text)
        .iter()
        .map(|t| format!("            {t:?} => <{t} as ::haus::Decode>::decode(v).map(|x| ::haus::Encode::encode(&x)),\n"))
        .collect();
    format!(
        r#"#[allow(deprecated, dead_code, clippy::all)]
pub mod {name} {{
    include!(concat!(env!("OUT_DIR"), "/suite_{name}.rs"));

    pub fn roundtrip(ty: &str, v: &::haus::Value) -> Option<Result<::haus::Value, ::haus::DecodeError>> {{
        Some(match ty {{
{arms}            _ => return None,
        }})
    }}
}}

"#
    )
}
