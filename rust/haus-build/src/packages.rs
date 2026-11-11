//! Schema packages among a crate's direct dependencies (spec §13.3).
//!
//! A package crate's build script calls `haus_build::package()`, which tells
//! Cargo where its manifest is (`cargo::metadata=haus_package=…`). Cargo
//! passes that only to crates that depend on it directly, as
//! `DEP_<LINKS>_HAUS_PACKAGE`: no registry, no network, no transitive lookups.

use crate::{Error, Result, read, rerun_if_changed, schema, var};
use std::collections::HashMap;
use std::env;
use std::path::Path;

pub const MANIFEST: &str = "haus.package.haus";

/// `haus.package.haus`: `{ name: "@haus/money", version: "1.2.0", schema: "money.schema.haus" }`.
pub struct Manifest {
    pub name: String,
    pub version: String,
    pub schema: String,
}

impl Manifest {
    pub fn read(dir: &Path) -> Result<Manifest> {
        let path = dir.join(MANIFEST);
        let value = haus::parse(&read(&path)?)
            .map_err(|e| Error::at(&path, e))?
            .into_iter()
            .next()
            .ok_or_else(|| Error::at(&path, "empty manifest"))?;
        let field = |key: &str| match value.get(key) {
            Some(haus::Value::String(s)) => Ok(s.clone()),
            _ => Err(Error::at(&path, format!("the manifest needs a string field {key}"))),
        };
        Ok(Manifest { name: field("name")?, version: field("version")?, schema: field("schema")? })
    }

    pub fn major(&self) -> &str {
        self.version.split('.').next().unwrap_or_default()
    }

    /// `@haus/money@1`.
    pub fn id(&self) -> String {
        format!("{}@{}", self.name, self.major())
    }
}

pub struct Package {
    pub manifest: Manifest,
    /// The Rust crate with its types: `haus_money`.
    pub krate: String,
    /// Its types and their number of parameters.
    pub types: HashMap<String, usize>,
}

/// The schema packages among a crate's direct dependencies.
#[derive(Default)]
pub struct Packages(Vec<Package>);

impl Packages {
    /// None: for schemas without package imports.
    pub fn none() -> Packages {
        Packages::default()
    }

    /// The direct dependencies that are schema packages.
    pub fn from_env() -> Result<Packages> {
        env::vars()
            .filter_map(|(key, dir)| Some((key.strip_prefix("DEP_")?.strip_suffix("_HAUS_PACKAGE")?.to_owned(), dir)))
            .map(|(links, dir)| Package::load(Path::new(&dir), var(&format!("DEP_{links}_HAUS_CRATE"))?))
            .collect::<Result<_>>()
            .map(Packages)
    }

    /// With the package in `dir`, whose types are in the crate `krate`.
    pub fn with(mut self, dir: &Path, krate: &str) -> Result<Packages> {
        self.0.push(Package::load(dir, krate.to_owned())?);
        Ok(self)
    }

    /// The one package called `name`.
    pub(crate) fn find(&self, name: &str) -> Result<&Package, String> {
        match self.0.iter().filter(|p| p.manifest.name == name).collect::<Vec<_>>().as_slice() {
            [one] => Ok(one),
            [] => Err(format!(
                "package {name} not found among this crate's dependencies: \
                 add the crate that provides it (its build script calls haus_build::package)"
            )),
            [a, b, ..] => Err(format!("two dependencies call themselves {name}: {} and {}", a.krate, b.krate)),
        }
    }
}

impl Package {
    fn load(dir: &Path, krate: String) -> Result<Package> {
        let manifest = Manifest::read(dir)?;
        let path = dir.join(&manifest.schema);
        rerun_if_changed(&path);
        let file = schema::parse(&read(&path)?).map_err(|e| Error::from(e).in_file(&path))?;
        let types = file.types.into_iter().map(|t| (t.name, t.params.len())).collect();
        Ok(Package { manifest, krate, types })
    }
}
