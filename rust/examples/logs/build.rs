//! Rust types for the shared log schema (examples/logs.schema.haus).

fn main() -> Result<(), haus_build::Error> {
    haus_build::Config::new().compile("../../../examples/logs.schema.haus")
}
