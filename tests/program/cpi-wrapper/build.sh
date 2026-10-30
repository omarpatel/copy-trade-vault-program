#!/usr/bin/env bash
# Builds the CPI wrapper test fixture and copies it to tests/program/fixtures/cpi_wrapper.so
# (committed, so the suite runs without building it). Run in WSL:
#   bash tests/program/cpi-wrapper/build.sh
set -euo pipefail
cd "$(dirname "$0")"
cargo build-sbf --sbf-out-dir target/deploy
cp target/deploy/cpi_wrapper.so ../fixtures/cpi_wrapper.so
echo "fixtures/cpi_wrapper.so $(stat -c %s ../fixtures/cpi_wrapper.so) bytes"
