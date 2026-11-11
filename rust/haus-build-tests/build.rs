fn main() -> Result<(), haus_build::Error> {
    haus_build::Config::new().compile("features.schema.haus")
}
