#!/bin/sh
# Build iris-mic for ONE Rust target and stage it where Tauri's externalBin expects it.
#   build-sidecar.sh aarch64-apple-darwin  <sidecars-dir>
#   build-sidecar.sh x86_64-apple-darwin   <sidecars-dir>
# Output: <sidecars-dir>/iris-mic-<rust-target>. Tauri strips the triple when it bundles, so the app
# gets Contents/MacOS/iris-mic beside the iris-cli sidecar (capture.ts micHelperPath finds it there),
# and signs it with the app's identity and entitlements.
set -eu
TARGET="${1:?rust target}"; OUT="${2:?sidecars dir}"
case "$TARGET" in
  aarch64-apple-darwin) SWIFT=arm64-apple-macos12.0 ;;
  x86_64-apple-darwin) SWIFT=x86_64-apple-macos12.0 ;;
  *) echo "iris-mic is macOS only (got $TARGET)" >&2; exit 1 ;;
esac
# Resolve the output BEFORE changing directory: CI passes a path relative to the repo root, and
# resolving it after the cd wrote the helper inside this folder, where Tauri never looks (release
# run 39180060453: "resource path sidecars/iris-mic-aarch64-apple-darwin doesn't exist").
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
cd "$(dirname "$0")"
# Info.plist is embedded in the binary: a bare command-line tool has no bundle to carry a microphone
# usage string, and macOS reads it from the binary itself.
swiftc -O -target "$SWIFT" iris-mic.swift -o "$OUT/iris-mic-$TARGET" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
chmod +x "$OUT/iris-mic-$TARGET"
echo "built $OUT/iris-mic-$TARGET ($(lipo -archs "$OUT/iris-mic-$TARGET"))"
