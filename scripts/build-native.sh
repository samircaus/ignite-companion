#!/bin/zsh
# Builds the page renderer (Apple Vision handwriting recognition + PNG drawing). macOS only.
set -euo pipefail
cd "${0:a:h}/.."
out="${COMPANION_IGNITE_RENDER_BIN:-$HOME/Library/Application Support/Ignite Companion/native/ignite-render}"
mkdir -p "${out:h}"
/usr/bin/swiftc -O -o "$out.new" native/ignite-render.swift
mv "$out.new" "$out"
echo "ignite-render built at $out"
