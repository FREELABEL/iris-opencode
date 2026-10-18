#!/bin/sh
# Build iris-mic as a universal (arm64 + x86_64) binary. Output: ./iris-mic (gitignored).
# A release build must sign it with the app's identity and ship it beside the sidecar (micHelperPath).
set -e
cd "$(dirname "$0")"
swiftc -O -target arm64-apple-macos12.0 iris-mic.swift -o iris-mic.arm64
swiftc -O -target x86_64-apple-macos12.0 iris-mic.swift -o iris-mic.x86_64
lipo -create iris-mic.arm64 iris-mic.x86_64 -output iris-mic
rm -f iris-mic.arm64 iris-mic.x86_64
echo "built $(pwd)/iris-mic: $(lipo -archs iris-mic)"
