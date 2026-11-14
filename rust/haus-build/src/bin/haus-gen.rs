//! Code generation for languages without build scripts.
//!
//!     haus-gen roc SCHEMA --module NAME --out FILE [--id ID] [--package DIR=ALIAS]... [--codec ID=MODULE]...
//!     haus-gen roc-package DIR --out FILE [--package DIR=ALIAS]...
//!
//! `--package DIR=ALIAS`: a schema package (its directory), and the alias the
//! Roc app or package imports its Roc package under. `--codec ID=MODULE`: the
//! Roc module MODULE is the codec for the type with this id.

use haus_build::roc::RocConfig;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::{env, fs};

const USAGE: &str =
    "usage: haus-gen roc SCHEMA --module NAME --out FILE [--id ID] [--package DIR=ALIAS]... [--codec ID=MODULE]...
       haus-gen roc-package DIR --out FILE [--package DIR=ALIAS]...";

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
}

fn run(args: &[String]) -> Result<(), String> {
    let [command, input, flags @ ..] = args else { return Err(USAGE.into()) };
    let args = flags.chunks(2).try_fold(Args::default(), |mut a, pair| {
        let [flag, value] = pair else { return Err(format!("{} needs a value", pair[0])) };
        match flag.as_str() {
            "--module" => a.module = Some(value.clone()),
            "--out" => a.out = Some(value.into()),
            "--id" => a.id = Some(value.clone()),
            "--package" => {
                let (dir, alias) = value.split_once('=').ok_or("--package takes DIR=ALIAS")?;
                a.config = a.config.package(dir, alias);
            }
            "--codec" => {
                let (id, module) = value.split_once('=').ok_or("--codec takes ID=MODULE")?;
                a.config = a.config.codec(id, module);
            }
            _ => return Err(format!("unknown flag {flag}\n{USAGE}")),
        }
        Ok(a)
    })?;
    let out = args.out.ok_or("--out is required")?;
    let code = match command.as_str() {
        "roc" => {
            let schema = Path::new(input);
            let name = schema.file_name().and_then(|f| f.to_str()).unwrap_or_default();
            let id = args.id.unwrap_or_else(|| name.trim_end_matches(".schema.haus").to_owned());
            let module = args.module.ok_or("--module is required")?;
            let text = fs::read_to_string(schema).map_err(|e| format!("{}: {e}", schema.display()))?;
            for w in haus_build::check(&text).unwrap_or_default() {
                eprintln!("haus-gen: warning: {}:{w}", schema.display());
            }
            args.config.generate(schema, &module, &id)
        }
        "roc-package" => args.config.generate_package(Path::new(input)).map(|(_, code)| code),
        _ => return Err(USAGE.into()),
    }
    .map_err(|e| e.to_string())?;
    fs::write(&out, code).map_err(|e| format!("{}: {e}", out.display()))
}
