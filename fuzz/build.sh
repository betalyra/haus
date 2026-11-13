#!/bin/sh
# Build the parsers and std/time checkers under test (fuzz/README.md).
set -e
cd "$(dirname "$0")/.."
(cd spec/lean && lake build haus-ref)
(cd rust && cargo build -q --release -p haus-fmt --example fuzz_runner --example time_runner)
(cd python && uv sync -q)
(cd typescript && pnpm --filter ./packages/haus build >/dev/null)
mkdir -p fuzz/.build
(cd roc/fuzz && roc build --output=../../fuzz/.build/roc-runner runner.roc >/dev/null)
(cd roc/fuzz && roc build --output=../../fuzz/.build/roc-time-runner time_runner.roc >/dev/null)
echo "built: lean, rust, typescript, roc, python"
