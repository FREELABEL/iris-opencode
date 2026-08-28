#!/usr/bin/env bash
# Regenerate every icon Tauri bundles, from the squircle master.
#
# Only five files per set are actually bundled (see tauri.conf.json / tauri.prod.conf.json):
# 32x32.png, 128x128.png, 128x128@2x.png, icon.icns, icon.ico. The Square*Logo.png files are
# Microsoft Store assets, which are full-bleed square BY DESIGN — a squircle inside the
# Store's own mask looks wrong, so they are deliberately left alone.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:?usage: regen-icons.sh <source-1024.png>}"
TMP="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$TMP"' EXIT

python3 scripts/make-icon.py "$SRC" "$TMP"
MASTER="$TMP/icon-1024.png"

for SET in dev prod; do
  DIR="src-tauri/icons/$SET"
  python3 - "$MASTER" "$DIR" "$TMP" <<'PY'
import sys, os
from PIL import Image
master, out, tmp = sys.argv[1], sys.argv[2], sys.argv[3]
im = Image.open(master).convert("RGBA")
def w(size, path):
    im.resize((size, size), Image.LANCZOS).save(path)
w(32,  f"{out}/32x32.png")
w(128, f"{out}/128x128.png")
w(256, f"{out}/128x128@2x.png")   # @2x of 128
w(512, f"{out}/icon.png")
# .ico carries its own sizes; Windows picks the closest.
im.resize((256,256), Image.LANCZOS).save(f"{out}/icon.ico",
    sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
# .iconset for iconutil
iso = f"{tmp}/{os.path.basename(out)}.iconset"
os.makedirs(iso, exist_ok=True)
for name, size in [("16x16",16),("16x16@2x",32),("32x32",32),("32x32@2x",64),
                   ("128x128",128),("128x128@2x",256),("256x256",256),
                   ("256x256@2x",512),("512x512",512),("512x512@2x",1024)]:
    im.resize((size,size), Image.LANCZOS).save(f"{iso}/icon_{name}.png")
print(f"  {out}: pngs + ico written")
PY
  iconutil -c icns "$TMP/$SET.iconset" -o "$DIR/icon.icns"
  echo "  $DIR/icon.icns written"
done
echo "done"
