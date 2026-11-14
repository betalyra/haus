//! Rust types from haus schemas, generated in `build.rs`.
//!
//! An application:
//!
//! ```no_run
//! // build.rs
//! haus_build::Config::new()
//!     .codec("@haus/money@1#Money", "crate::codecs::Cents")
//!     .compile("src/order.schema.haus")
//!     .unwrap();
//! ```
//!
//! ```ignore
//! // src/main.rs
//! mod order { haus::include_schema!("order"); }
//! let order: order::Root = haus::from_str(&text)?;
//! ```
//!
//! A schema package (`haus.package.haus` next to `Cargo.toml`, and
//! `links = "<crate name>"` in it) calls [`package`] instead. Crates that
//! depend on it directly can then `import @org/name (…)`: the package's
//! types are its crate's types (`haus_money::Money`), and their ids are
//! the same in every language (`@haus/money@1#Money`).

mod codegen;
mod packages;
pub mod roc;
mod schema;

use codegen::{Imported, STD_TIME};
use packages::{MANIFEST, Manifest};
use std::collections::HashMap;
use std::fmt::{self, Display};
use std::path::{Path, PathBuf};
use std::{env, fs};

pub use codegen::Codec;
pub use packages::Packages;

/// What went wrong, and where: `src/order.schema.haus:3:5: unknown type Strin`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    path: Option<PathBuf>,
    /// Line and column, 1-based.
    position: Option<(usize, usize)>,
    reason: String,
}

impl Error {
    fn new(reason: impl Display) -> Error {
        Error { path: None, position: None, reason: reason.to_string() }
    }

    /// An error about the file at `path`.
    fn at(path: &Path, reason: impl Display) -> Error {
        Error::new(reason).in_file(path)
    }

    /// The same error, in the file at `path`.
    fn in_file(self, path: &Path) -> Error {
        Error { path: Some(path.to_owned()), ..self }
    }
}

impl From<schema::Error> for Error {
    fn from(e: schema::Error) -> Error {
        Error { path: None, position: Some((e.line, e.column)), reason: e.reason }
    }
}

impl Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let path = self.path.as_ref().map(|p| p.display().to_string());
        let position = self.position.map(|(line, column)| format!("{line}:{column}"));
        match [path, position].into_iter().flatten().collect::<Vec<_>>().join(":") {
            at if at.is_empty() => f.write_str(&self.reason),
            at => write!(f, "{at}: {}", self.reason),
        }
    }
}

impl std::error::Error for Error {}

/// Something a schema allows but probably doesn't mean, with where it is:
/// `3:1: unknown attribute @since: this version of haus ignores it`. Build
/// scripts report warnings to Cargo.
pub type Warning = Error;

type Result<T, E = Error> = std::result::Result<T, E>;

/// How to generate code for a schema.
#[derive(Debug, Clone, Default)]
pub struct Config {
    codecs: Vec<Codec>,
    quiet: bool,
    without_attributes: bool,
}

impl Config {
    pub fn new() -> Config {
        Config::default()
    }

    /// Use the codec at `path` (a type implementing `haus::Codec`) for the type
    /// with this id: `.codec("std/time#Date", "crate::codecs::JiffDate")`.
    pub fn codec(mut self, id: impl Into<String>, path: impl Into<String>) -> Config {
        self.codecs.push(Codec { id: id.into(), path: path.into() });
        self
    }

    /// Don't report the schema's warnings ([`Warning`]) to Cargo.
    pub fn quiet(mut self) -> Config {
        self.quiet = true;
        self
    }

    /// Leave the schema's attributes out, as if they weren't written: the
    /// code decodes and encodes the same (spec §15), without `#[deprecated]`.
    /// For tests of that.
    #[doc(hidden)]
    pub fn without_attributes(mut self) -> Config {
        self.without_attributes = true;
        self
    }

    /// Generate `$OUT_DIR/<name>.rs` for `<name>.schema.haus`; include it with
    /// `haus::include_schema!("<name>")`.
    pub fn compile(&self, schema: impl AsRef<Path>) -> Result<()> {
        let schema = schema.as_ref();
        self.compile_as(schema, &stem(schema))
    }

    /// Like [`Config::compile`], to `$OUT_DIR/<name>.rs`: to compile one schema
    /// with different codecs.
    pub fn compile_as(&self, schema: impl AsRef<Path>, name: &str) -> Result<()> {
        let schema = schema.as_ref();
        let crate_dir = PathBuf::from(var("CARGO_MANIFEST_DIR")?);
        let path = crate_dir.join(schema).canonicalize().map_err(|e| Error::at(schema, e))?;
        // A file in this crate: `<crate>/<path>`; elsewhere: its name (like the TypeScript binding).
        let relative = crate_dir.canonicalize().ok().and_then(|dir| path.strip_prefix(dir).ok().map(Path::to_path_buf));
        let id = match relative {
            Some(relative) => format!("{}/{}", var("CARGO_PKG_NAME")?, relative.with_file_name(stem(&path)).display()),
            None => stem(&path),
        };
        self.emit(&path, &id, name)
    }

    /// For a schema package crate: generate its types, with ids from its
    /// manifest, and tell dependent crates where it is.
    pub fn package(&self) -> Result<()> {
        let dir = PathBuf::from(var("CARGO_MANIFEST_DIR")?);
        let manifest = Manifest::read(&dir)?;
        let schema = dir.join(&manifest.schema);
        self.emit(&schema, &manifest.id(), &stem(&schema))?;
        rerun_if_changed(&dir.join(MANIFEST));
        println!("cargo::metadata=haus_package={}", dir.display());
        println!("cargo::metadata=haus_crate={}", var("CARGO_PKG_NAME")?.replace('-', "_"));
        Ok(())
    }

    fn emit(&self, schema: &Path, id: &str, name: &str) -> Result<()> {
        rerun_if_changed(schema);
        let text = read(schema)?;
        let mut file = schema::parse(&text).map_err(|e| Error::from(e).in_file(schema))?;
        if self.without_attributes {
            file = schema::without_attributes(file);
        }
        if !self.quiet {
            for w in &file.warnings {
                println!("cargo::warning={}", Error::from(w.clone()).in_file(schema));
            }
        }
        let code =
            generate_file(&file, &text, id, &self.codecs, &Packages::from_env()?).map_err(|e| e.in_file(schema))?;
        let out = PathBuf::from(var("OUT_DIR")?).join(format!("{name}.rs"));
        fs::write(&out, code).map_err(|e| Error::at(&out, e))
    }
}

/// [`Config::package`] with no codecs: the whole build script of a schema package.
pub fn package() -> Result<()> {
    Config::new().package()
}

/// Check a schema on its own, without its imports (spec §14): its syntax and
/// the rules that need no other file. Returns its warnings.
pub fn check(text: &str) -> Result<Vec<Warning>> {
    Ok(schema::parse(text)?.warnings.into_iter().map(Error::from).collect())
}

/// The Rust code for a schema, without touching the environment.
pub fn generate(text: &str, id: &str, codecs: &[Codec], packages: &Packages) -> Result<String> {
    generate_file(&schema::parse(text)?, text, id, codecs, packages)
}

fn generate_file(file: &schema::File, text: &str, id: &str, codecs: &[Codec], packages: &Packages) -> Result<String> {
    let imports = file
        .imports
        .iter()
        .map(|imp| resolve(imp, packages).map_err(|reason| schema::error(text, imp.pos, reason).into()))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .try_fold(HashMap::new(), |mut all, (name, t)| match all.insert(name.clone(), t) {
            Some(_) => Err(Error::new(format!("{name} is imported twice"))),
            None => Ok(all),
        })?;
    Ok(codegen::generate(file, &codegen::Input { text, id, imports: &imports, codecs })?)
}

/// The types an import brings in, by name.
fn resolve(imp: &schema::Import, packages: &Packages) -> Result<Vec<(String, Imported)>, String> {
    let names = imp.names.iter().map(|(n, _)| n.as_str());
    match imp.module.as_str() {
        "std/time" => names
            .map(|n| {
                if !STD_TIME.contains(&n) {
                    return Err(format!("std/time has no type {n} (it has {})", STD_TIME.join(", ")));
                }
                let imported = Imported { id: format!("std/time#{n}"), path: format!("::haus::time::{n}"), params: 0 };
                Ok((n.to_owned(), imported))
            })
            .collect(),
        "std/money" => {
            Err("std/money is no longer a standard module; it is the package @haus/money: import @haus/money (Money)"
                .into())
        }
        module if module.starts_with('@') => {
            let (name, major) = match module.rsplit_once('@').filter(|(n, _)| !n.is_empty()) {
                Some((n, v)) => (n, Some(v)),
                None => (module, None),
            };
            let pkg = packages.find(name)?;
            if let Some(major) = major.filter(|m| *m != pkg.manifest.major()) {
                return Err(format!(
                    "{module} wants major version {major}, but version {} was found",
                    pkg.manifest.version
                ));
            }
            names
                .map(|n| match pkg.types.get(n) {
                    Some(&params) => {
                        let id = format!("{}#{n}", pkg.manifest.id());
                        Ok((n.to_owned(), Imported { id, path: format!("::{}::{n}", pkg.krate), params }))
                    }
                    None => Err(format!("{name} has no type {n}")),
                })
                .collect()
        }
        module => {
            Err(format!("can't import {module}: haus-build imports std/time and schema packages (@org/name) so far"))
        }
    }
}

/// Tells Cargo to rerun the build script when `path` changes (only in a build script).
fn rerun_if_changed(path: &Path) {
    if env::var_os("OUT_DIR").is_some() {
        println!("cargo::rerun-if-changed={}", path.display());
    }
}

fn read(path: &Path) -> Result<String> {
    fs::read_to_string(path).map_err(|e| Error::at(path, e))
}

fn var(key: &str) -> Result<String> {
    env::var(key).map_err(|_| Error::new(format!("{key} is not set: haus-build runs in a build script")))
}

/// `order` for `src/order.schema.haus`.
fn stem(path: &Path) -> String {
    let file = path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
    file.strip_suffix(".schema.haus").unwrap_or(&file).to_owned()
}
