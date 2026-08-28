#!/usr/bin/env bash
#
# verify-shipped-app.sh — measure the artifact a CLIENT receives, not one adjacent to it.
#
# Every false-green this project has hit came from a check that measured something NEXT TO
# the thing that mattered: CI green over an app that could not mount; a healthy model list
# over calls that all 401'd; a version string naming a build nobody installed; a symbol grep
# reporting "deployed" for a symbol that already existed; a fix committed to a branch nobody
# ships from. This script exists to be the one check that cannot do that.
#
# It starts from THE FRONT PAGE URL — the exact bytes a client downloads — and refuses to
# assert anything it has not observed in the running artifact.
#
# Usage:
#   scripts/verify-shipped-app.sh                      # verify what the front page serves now
#   scripts/verify-shipped-app.sh v1.3.214             # …and require it to BE that tag
#   scripts/verify-shipped-app.sh --tag desktop-v1.18.24
#       verify one SPECIFIC release. Required for prereleases: /releases/latest/ resolves
#       only to non-prereleases, so a prerelease is invisible to the default path — which
#       is exactly the property that keeps it off the front page.
#
set -uo pipefail
set +m   # no job-control chatter when we stop the sidecar

REPO="FREELABEL/iris-opencode"
ASSET="${ASSET:-IRIS-tauri-darwin-arm64.zip}"
EXPECT_TAG=""
PIN_TAG=""
case "${1:-}" in
  --tag) PIN_TAG="${2:?--tag needs a tag}"; EXPECT_TAG="$PIN_TAG" ;;
  "")    ;;
  *)     EXPECT_TAG="$1" ;;
esac
# The name lib.rs passes to .sidecar(). If the bundle disagrees, macOS fails at launch with
# "program not found" — the exact class of bug that shipped in Aug 2026. Derived, not assumed.
SIDECAR_NAME="$(grep -oE '\.sidecar\("[^"]+"\)' packages/desktop/src-tauri/src/lib.rs 2>/dev/null \
  | head -1 | sed -E 's/.*"(.*)".*/\1/')"
SIDECAR_NAME="${SIDECAR_NAME:-iris-cli}"

# Resolve symlinks in the work dir. On macOS `mktemp -d` returns /var/folders/... and /var is
# a symlink to /private/var — and Tauri's current_exe() REFUSES a path containing a symlink
# ("StartingBinary found current_exe() that contains a symlink on a non-allowed platform"), so
# the app panics resolving its own sidecar and never starts. That is a property of the test
# location, not of the build: nobody installs an app to /var/folders. Testing from a path no
# user has would fail every release for a reason no user would ever hit.
WORK="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$WORK"' EXIT
PORT=$((20000 + RANDOM % 20000))
FAIL=0

pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=1; }
info() { printf '    \033[90m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# The platform slug heyiris.io uses for whichever asset we were asked to verify.
case "$ASSET" in
  *darwin-arm64.dmg) SLUG="mac-arm64" ;;
  *darwin-x64.dmg)   SLUG="mac-intel" ;;
  *darwin-arm64.zip) SLUG="mac-arm64-zip" ;;
  *darwin-x64.zip)   SLUG="mac-x64-zip" ;;
  *windows*)         SLUG="windows" ;;
  *)                 SLUG="mac-arm64" ;;
esac

if [ -n "$PIN_TAG" ]; then
  URL="https://github.com/$REPO/releases/download/$PIN_TAG/$ASSET"
else
  # NOT /releases/latest/download/. That URL has no fallback by asset name — it resolves to
  # whichever release holds the one repo-wide "latest" flag, which the CLI series takes on
  # every publish. Asking it "what does the front page serve?" returned a CLI release's copy
  # of this asset for a week, and the answer looked entirely healthy. The front page asks
  # heyiris.io, so this must too, or it is not measuring what users get.
  URL="https://heyiris.io/download/$SLUG"
fi

step "1. $([ -n "$PIN_TAG" ] && echo "Which release are we verifying?" || echo "What does the front page actually serve?")"
if [ -n "$PIN_TAG" ]; then
  SERVED_TAG="$PIN_TAG"
  curl -sfIL -o /dev/null "$URL" || { fail "no such release asset: $PIN_TAG/$ASSET"; exit 1; }
  pass "pinned to $SERVED_TAG (not what the front page serves — prereleases are invisible there by design)"
else
  SERVED_TAG="$(curl -sIL "$URL" | grep -i '^location' | grep -oE 'releases/download/[a-z-]*v[0-9][0-9.]*' | head -1 | cut -d/ -f3)"
  if [ -z "$SERVED_TAG" ]; then fail "heyiris.io/download/$SLUG did not resolve to any release"; exit 1; fi
  case "$SERVED_TAG" in
    desktop-v*) pass "front page serves $SERVED_TAG" ;;
    *) fail "front page resolved to $SERVED_TAG — that is NOT a desktop release. The CLI series has taken the download again."; exit 1 ;;
  esac
fi
info "$URL"
if [ -n "$EXPECT_TAG" ]; then
  [ "$SERVED_TAG" = "$EXPECT_TAG" ] \
    && pass "and that is the tag we expected ($EXPECT_TAG)" \
    || fail "EXPECTED $EXPECT_TAG BUT CLIENTS GET $SERVED_TAG — the release did not reach the front page"
fi

step "2. Download and unpack the real bytes"
curl -sL -o "$WORK/app.zip" "$URL" || { fail "download failed"; exit 1; }
SIZE=$(( $(stat -f%z "$WORK/app.zip" 2>/dev/null || stat -c%s "$WORK/app.zip") / 1000000 ))
[ "$SIZE" -gt 10 ] || { fail "artifact is only ${SIZE}MB — not a real app bundle"; exit 1; }
pass "downloaded ${SIZE}MB"
unzip -q -o "$WORK/app.zip" -d "$WORK/x" || { fail "artifact will not unzip"; exit 1; }
APP="$(find "$WORK/x" -maxdepth 2 -name '*.app' | head -1)"
[ -n "$APP" ] || { fail "no .app bundle inside"; exit 1; }
pass "unpacked $(basename "$APP")"

step "3. Does the app name itself honestly?"
# The bundle version and the engine version are set by DIFFERENT things and have disagreed in
# production. Check both, and compare them to each other — the disagreement is the bug.
PLIST_V="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null)"
WANT="${SERVED_TAG#desktop-v}"; WANT="${WANT#v}"
if [ "$PLIST_V" = "$WANT" ]; then
  pass "bundle version $PLIST_V matches the release"
else
  fail "BUNDLE SAYS $PLIST_V — the release is $WANT"
  info "a user reporting a bug will quote $PLIST_V, and you will debug the wrong build"
fi

step "4. Is the sidecar bundled under the name the app resolves?"
if [ -x "$APP/Contents/MacOS/$SIDECAR_NAME" ]; then
  pass "found '$SIDECAR_NAME' (the name lib.rs resolves)"
else
  fail "lib.rs resolves '$SIDECAR_NAME' but the bundle ships: $(ls "$APP/Contents/MacOS/" | tr '\n' ' ')"
  info "this fails at launch with 'program not found' and nothing catches it before a client does"
  exit 1
fi

# Run the sidecar as a NEW USER would, not as the operator. On 2026-08-27 this script
# reported "iris provider, 27 models" on a laptop that has a hand-built
# ~/.config/opencode/opencode.json — a file NO shipped artifact creates. Under an isolated
# HOME the same build serves the `opencode` provider instead. The check certified a product
# that does not exist for anyone but the person running it.
FRESH_HOME="$WORK/home"
mkdir -p "$FRESH_HOME"
export HOME="$FRESH_HOME"
export XDG_CONFIG_HOME="$FRESH_HOME/.config"
export XDG_DATA_HOME="$FRESH_HOME/.local/share"
export XDG_STATE_HOME="$FRESH_HOME/.local/state"

step "5. Run it — a real round-trip, not a status code"
# A bundle built for another architecture cannot be booted here, and Rosetta does NOT help:
# Bun's standard x64 binaries use AVX2, which Rosetta 2 does not implement, so an x86_64
# sidecar dies with SIGILL on an arm64 Mac no matter what. That is a property of THIS
# MACHINE, not of the build — reporting it as a defect would condemn a perfectly good
# artifact, which is exactly the confusion this script exists to prevent.
BUNDLE_ARCH="$(file "$APP/Contents/MacOS/$SIDECAR_NAME" | grep -oE 'x86_64|arm64' | head -1)"
HOST_ARCH="$(uname -m)"
if [ "$BUNDLE_ARCH" = "x86_64" ] && [ "$HOST_ARCH" = "arm64" ]; then
  info "bundle is x86_64 and this host is arm64 — SKIPPING the boot test."
  info "Rosetta cannot run Bun's AVX2 binaries; this must be verified on real Intel hardware."
  info "Everything checkable without executing it has passed."
  step "$([ $FAIL -eq 0 ] && echo $'\033[33mPARTIALLY VERIFIED — boot test needs an Intel Mac\033[0m' || echo $'\033[31mSHIPPED APP HAS DEFECTS A CLIENT WILL HIT\033[0m')"
  exit $FAIL
fi

# Launch the APP, not the sidecar on its own. The app's startup is where the provider config
# and AGENTS.md are seeded, so booting the sidecar directly tests a machine state no user is
# ever in — it reported "no iris provider" for a build that seeds it correctly, and would have
# blocked every release had promotion been gated on it. Running a COMPONENT of the artifact
# instead of the artifact is the same mistake this script exists to catch, in miniature.
APP_BIN="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist" 2>/dev/null)"
APP_BIN="${APP_BIN:-IRIS}"
"$APP/Contents/MacOS/$APP_BIN" >"$WORK/serve.log" 2>&1 &
SC=$!; stop_sidecar() { kill $SC 2>/dev/null; wait $SC 2>/dev/null; }
trap 'stop_sidecar; rm -rf "$WORK"' EXIT

# The app picks its own free port, so read the one it chose rather than dictating one.
PORT=""
for _ in $(seq 1 60); do
  PORT="$(grep -oE 'listening on http://127\.0\.0\.1:[0-9]+' "$WORK/serve.log" 2>/dev/null | grep -oE '[0-9]+$' | head -1)"
  if [ -n "$PORT" ] && curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/doc"; then break; fi
  sleep 0.5
done
if [ -z "$PORT" ]; then
  fail "the app never reported a listening port"
  info "$(head -5 "$WORK/serve.log" 2>/dev/null)"
fi

# EVERY unknown path on this server returns the SPA's index.html with HTTP 200. Asserting on
# status codes would be green against a build whose API is entirely unreachable. So parse.
probe() { curl -s -m 10 "http://127.0.0.1:$PORT$1"; }
is_json() { case "$1" in '{'*|'['*) return 0;; *) return 1;; esac; }

H="$(probe /global/health)"
if ! is_json "$H"; then
  fail "/global/health returned the SPA fallback, not JSON — the API is not serving"
  info "$(echo "$H" | head -c 60)"
else
  ENGINE_V="$(echo "$H" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("version",""))' 2>/dev/null)"
  echo "$H" | grep -q '"healthy":true' && pass "engine reports healthy" || fail "engine reports unhealthy: $H"
  [ "$ENGINE_V" = "$WANT" ] \
    && pass "engine version $ENGINE_V matches the release" \
    || fail "engine version $ENGINE_V != release $WANT"
fi

step "6. Are there models a NEW USER can actually use?"
# A provider COUNT was green here once while every call 401'd. Counting is not verifying, so
# assert models exist under the provider we ship — the smallest claim that implies a usable app.
P="$(probe /config/providers)"
if ! is_json "$P"; then
  fail "/config/providers did not return JSON"
else
  echo "$P" | python3 -c '
import json,sys
d=json.load(sys.stdin)
ps=d.get("providers", d if isinstance(d,list) else [])
iris=[p for p in ps if "iris" in str(p.get("id","")).lower()]
if not iris:
    print("FAIL no iris provider; got: " + ",".join(str(p.get("id")) for p in ps)); sys.exit(1)
n=len(iris[0].get("models",{}) or {})
if n==0: print("FAIL iris provider present but ZERO models"); sys.exit(1)
print(f"OK iris provider, {n} models")
' > "$WORK/p.txt" 2>&1
  R="$(cat "$WORK/p.txt")"
  case "$R" in OK*) pass "${R#OK }";; *) fail "${R#FAIL }";; esac
fi

stop_sidecar

step "7. Can this release actually deliver the NEXT one?"
# For every build before desktop-v1.18.37 the answer was no: the app shipped an updater pubkey,
# a "Check For Updates..." menu item and a whole UI, while the endpoint returned 404 and the
# releases carried no manifest at all. So every fix reached users only by asking each of them to
# re-download by hand. An update mechanism nobody has watched succeed is a claim, not a feature.
MANIFEST_URL="https://github.com/$REPO/releases/download/$SERVED_TAG/latest.json"
MJ="$(curl -sfL --max-time 20 "$MANIFEST_URL" || true)"
if ! is_json "$MJ"; then
  fail "no latest.json on $SERVED_TAG — installed clients cannot auto-update to it"
else
  # The pubkey compiled into the app must be the one whose private half signed this manifest,
  # or the client downloads the update, checks it, and silently rejects it.
  PUBKEY="$(python3 -c 'import json;print(json.load(open("packages/desktop/src-tauri/tauri.prod.conf.json"))["plugins"]["updater"]["pubkey"])' 2>/dev/null || true)"
  printf '%s' "$MJ" | PUBKEY="$PUBKEY" TAG="$SERVED_TAG" python3 -c '
import base64, json, os, sys
m = json.load(sys.stdin)
want = os.environ["TAG"].replace("desktop-v", "")
got = m.get("version")
if got != want:
    print("FAIL manifest says " + str(got) + " but this release is " + want); sys.exit(1)
plats = m.get("platforms") or {}
need = {"darwin-aarch64", "darwin-x86_64", "windows-x86_64"}
missing = need - set(plats)
if missing:
    print("FAIL manifest is missing " + ", ".join(sorted(missing))); sys.exit(1)
# minisign layout: 2-byte algorithm, then an 8-byte key id, then the key/signature. The id is
# NOT present as hex text anywhere in the signature -- an earlier version of this check looked
# for the printed "2A10681A..." comment string and would have failed every release. Compare the
# actual bytes. (The comment shows the same 8 bytes little-endian, which is why they look
# unrelated at a glance.)
def keyid(b64):
    return base64.b64decode(b64)[2:10]

want_id = None
try:
    want_id = keyid(base64.b64decode(os.environ["PUBKEY"]).decode().splitlines()[1])
except Exception:
    print("::warning::could not parse the app pubkey; skipping the key-match check")

for name, p in plats.items():
    url = p.get("url", "")
    if not p.get("signature"):
        print("FAIL " + name + " has an empty signature"); sys.exit(1)
    if "/releases/download/" not in url:
        print("FAIL " + name + " url is not pinned to a tag: " + url); sys.exit(1)
    if want_id:
        try:
            got_id = keyid(base64.b64decode(p["signature"]).decode().splitlines()[1])
        except Exception:
            print("FAIL " + name + " signature is not a parseable minisign blob"); sys.exit(1)
        if got_id != want_id:
            print("FAIL " + name + " was signed by key " + got_id[::-1].hex().upper()
                  + " but the app only trusts " + want_id[::-1].hex().upper()
                  + " - every client would download this update and reject it"); sys.exit(1)
shown = want_id[::-1].hex().upper() if want_id else "unchecked"
print("OK manifest " + want + ", " + str(len(plats)) + " platforms, signed by " + shown)
' > "$WORK/m.txt" 2>&1
  R="$(cat "$WORK/m.txt")"
  case "$R" in OK*) pass "${R#OK }";; *) fail "${R#FAIL }";; esac

  # And the binary it points at must exist. A manifest naming a 404 fails at download time,
  # on the client, silently.
  MYURL="$(printf '%s' "$MJ" | python3 -c 'import json,sys;p=json.load(sys.stdin)["platforms"];print(p.get("darwin-aarch64",{}).get("url",""))' 2>/dev/null || true)"
  if [ -n "$MYURL" ] && curl -sfIL -o /dev/null --max-time 30 "$MYURL"; then
    pass "the payload it names is downloadable"
  else
    fail "manifest points at a URL that does not resolve: $MYURL"
  fi
fi

step "$([ $FAIL -eq 0 ] && echo $'\033[32mSHIPPED APP VERIFIED\033[0m' || echo $'\033[31mSHIPPED APP HAS DEFECTS A CLIENT WILL HIT\033[0m')"
exit $FAIL
