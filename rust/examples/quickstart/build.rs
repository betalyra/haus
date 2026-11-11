//! Rust types for the shared thread schema (examples/thread.schema.haus).

fn main() -> Result<(), haus_build::Error> {
    haus_build::Config::new().compile("../../../examples/thread.schema.haus")
}
