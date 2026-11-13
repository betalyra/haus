#!/bin/sh
# Install the Roc nightly named by $ROC_NIGHTLY (see workflows/ci.yml) and
# put it on the PATH of the following steps.
set -eu
asset="roc_nightly-linux_x86_64-${ROC_NIGHTLY#nightly-}.tar.gz"
curl -fsSL -o /tmp/roc.tar.gz "https://github.com/roc-lang/nightlies/releases/download/$ROC_NIGHTLY/$asset"
mkdir -p "$HOME/roc"
tar -xzf /tmp/roc.tar.gz -C "$HOME/roc"
# Find the binary rather than assume the archive's layout.
bin=$(find "$HOME/roc" -type f -name roc -perm -u+x | head -n 1)
[ -n "$bin" ] || { echo "no roc binary in $asset" >&2; exit 1; }
dirname "$bin" >> "$GITHUB_PATH"
"$bin" version
