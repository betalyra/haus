//! Code generation for languages without build scripts.
//!
//!     haus-gen roc SCHEMA --module NAME [--out FILE] [--id ID] [--package DIR=ALIAS]... [--codec ID=MODULE]...
//!     haus-gen roc-package DIR [--out FILE] [--package DIR=ALIAS]...
//!
//! `--package DIR=ALIAS`: a schema package (its directory), and the alias the
//! Roc app or package imports its Roc package under. `--codec ID=MODULE`: the
//! Roc module MODULE is the codec for the type with this id. Without `--out`,
//! the module is written to standard output. `--without-attributes` leaves the
//! schema's attributes out, for tests that they don't matter (spec §15).

use haus_build::roc::RocConfig;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::{env, fs};

const USAGE: &str =
    "usage: haus-gen roc SCHEMA --module NAME [--out FILE] [--id ID] [--package DIR=ALIAS]... [--codec ID=MODULE]...
       haus-gen roc-package DIR [--out FILE] [--package DIR=ALIAS]...";

fn main() -> ExitCode {
    match run(&env::args().skip(1).collect::<Vec<_>>()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("haus-gen: {e}");
            ExitCode::FAILURE
        }
    }
}

/// The command line, parsed.
#[derive(Default)]
struct Args {
    config: RocConfig,
    module: Option<String>,
    out: Option<PathBuf>,
    id: Option<String>,
    /// The schema's warnings are about its attributes, which are left out.
    quiet: bool,
}

fn run(args: &[String]) -> Result<(), String> {
    let [command, input, flags @ ..] = args else { return Err(USAGE.into()) };
    let mut flags = flags.iter();
    let mut args = Args::default();
    while let Some(flag) = flags.next() {
        if flag == "--without-attributes" {
            args.config = args.config.without_attributes();
            args.quiet = true;
            continue;
        }
        let value = flags.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--module" => args.module = Some(value.clone()),
            "--out" => args.out = Some(value.into()),
            "--id" => args.id = Some(value.clone()),
            "--package" => {
                let (dir, alias) = value.split_once('=').ok_or("--package takes DIR=ALIAS")?;
                args.config = args.config.package(dir, alias);
            }
            "--codec" => {
                let (id, module) = value.split_once('=').ok_or("--codec takes ID=MODULE")?;
                args.config = args.config.codec(id, module);
            }
            _ => return Err(format!("unknown flag {flag}\n{USAGE}")),
        }
    }
    let code = match command.as_str() {
        "roc" => {
            let schema = Path::new(input);
            let name = schema.file_name().and_then(|f| f.to_str()).unwrap_or_default();
            let id = args.id.unwrap_or_else(|| name.trim_end_matches(".schema.haus").to_owned());
            let module = args.module.ok_or("--module is required")?;
            let text = fs::read_to_string(schema).map_err(|e| format!("{}: {e}", schema.display()))?;
            for w in haus_build::check(&text).unwrap_or_default().into_iter().filter(|_| !args.quiet) {
                eprintln!("haus-gen: warning: {}:{w}", schema.display());
            }
            args.config.generate(schema, &module, &id)
        }
        "roc-package" => args.config.generate_package(Path::new(input)).map(|(_, code)| code),
        _ => return Err(USAGE.into()),
    }
    .map_err(|e| e.to_string())?;
    match args.out {
        Some(out) => fs::write(&out, code).map_err(|e| format!("{}: {e}", out.display())),
        None => io::stdout().write_all(code.as_bytes()).map_err(|e| e.to_string()),
    }
}
