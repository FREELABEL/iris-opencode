#!/bin/sh
# Build iris-mic for the machine's own architecture. Output: ./iris-mic (gitignored).
# A release build must sign it with the app's identity and ship it beside the sidecar (micHelperPath).
set -e
cd "$(dirname "$0")"
swiftc -O iris-mic.swift -o iris-mic
echo "built $(pwd)/iris-mic"
