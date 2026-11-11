#!/bin/sh
# Regenerate the Roc modules of the examples and the schema packages from
# their schemas. haus-gen is part of haus-build, so this needs Rust (cargo).
set -e
cd "$(dirname "$0")"
gen() { cargo run -q --manifest-path ../../rust/Cargo.toml -p haus-build --bin haus-gen -- "$@"; }

# The official schema packages, as Roc packages.
gen roc-package ../../extensions/money --out ../../extensions/money/roc/HausMoney.roc
gen roc-package ../../extensions/geo --out ../../extensions/geo/roc/HausGeo.roc

# The examples, from the shared files in ../../examples.
gen roc ../../examples/thread.schema.haus --module Thread --out quickstart/Thread.roc
gen roc ../../examples/logs.schema.haus --module Logs --out logs/Logs.roc
gen roc ../../examples/order.schema.haus --module Order --out order/Order.roc \
  --package ../../extensions/money=money --package ../../extensions/geo=geo
gen roc ../../examples/order.schema.haus --module Typed --out order/Typed.roc \
  --package ../../extensions/money=money --package ../../extensions/geo=geo \
  --codec "@haus/money@1#Money=Cents" --codec "@haus/geo@1#LatLng=GeoJson" --codec "std/time#Date=CivilDate"

for f in ../../extensions/money/roc/HausMoney.roc ../../extensions/geo/roc/HausGeo.roc quickstart/Thread.roc logs/Logs.roc order/Order.roc order/Typed.roc; do
  roc fmt "$f" >/dev/null
done
