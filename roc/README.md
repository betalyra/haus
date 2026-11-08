# haus for Roc

Built against the Roc nightly compiler (2026-11-03).

| Path | Contents |
|---|---|
| `package/` | The haus package: `Value.roc` holds the data model and a hand-written parser (`Value.parse_all`, `Value.parse`, `Value.parse_bytes`) |
| `package/Decode.roc` | Building blocks for decoding a `Value` into your own types (`Decode.all`, `Decode.record`, `Decode.field`, `Decode.optional_field`, `Decode.maybe`, `Decode.list`, `Decode.u64`, `Decode.bytes`, `Decode.money`, …). Error paths like `$[1].amount[0]` are built automatically |
| `package/ConformanceTest.roc` | Generated from `../test-suite` by `scripts/gen_conformance.py`. Re-run the script after changing the suite |
| `examples/shop/` | Showcase: decoding haus into Roc's structural tag unions and records, with handlers that work on any union or record containing certain tags or fields (row polymorphism) |

```sh
cd package && roc test ConformanceTest.roc && roc test Decode.roc
cd examples/shop && roc test main.roc   # tests
cd examples/shop && roc run.roc         # runnable demo (uses the basic-cli platform)
```

`run.roc` reads `../../../examples/events.haus` relative to the working
directory, so run it from `examples/shop`.

Not ported yet: incremental streaming. `parse_all` takes the complete text.
