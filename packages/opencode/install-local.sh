#!/usr/bin/env bash
# Build local iris binary, install to ~/.iris/bin/iris, fix codesign
set -e

cd "$(dirname "$0")"
BIN_SRC="dist/opencode-darwin-arm64/bin/iris"
BIN_DEST="$HOME/.iris/bin/iris"

echo "→ Building..."
bun run build --single 2>&1 | tail -3

if [ ! -f "$BIN_SRC" ]; then
  echo "✗ Build did not produce $BIN_SRC"
  exit 1
fi

echo "→ Installing to $BIN_DEST"
cp "$BIN_SRC" "$BIN_DEST"

echo "→ Stripping xattrs and re-signing (adhoc)..."
xattr -cr "$BIN_DEST" || true
codesign --force --sign - "$BIN_DEST"

echo "→ Verifying..."
"$BIN_DEST" --version
echo "✓ Installed"
