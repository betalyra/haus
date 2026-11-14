#!/bin/sh
# Build the parsers, std/time checkers and schema decoders under test (fuzz/README.md).
set -e
cd "$(dirname "$0")/.."
(cd spec/lean && lake build haus-ref)
(cd rust && cargo build -q --release -p haus-fmt --example fuzz_runner --example time_runner)
(cd python && uv sync -q)
(cd typescript && pnpm --filter ./packages/haus build >/dev/null && pnpm --filter ./packages/effect build >/dev/null)
(cd fuzz/schema-rust && cargo build -q --release)
mkdir -p fuzz/.build
(cd roc/fuzz && roc build --output=../../fuzz/.build/roc-runner runner.roc >/dev/null)
(cd roc/fuzz && roc build --output=../../fuzz/.build/roc-time-runner time_runner.roc >/dev/null)
node fuzz/roc/gen_schemas.ts >/dev/null
(cd fuzz/roc && roc build --output=../.build/roc-schema-runner schema_runner.roc >/dev/null)
echo "built: lean, rust, typescript, effect, roc, python"
