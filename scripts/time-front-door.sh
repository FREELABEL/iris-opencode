#!/usr/bin/env bash
# Time the front door: install → auth → browser, from a cold machine. (#181991)
#
# The "local developer ergonomics" row in the harness comparison sat unclaimable for
# weeks because nobody had run this. Not because it was hard — because it was nobody's.
# So it is a script now, and the number has an owner.
#
# ISOLATED BY DEFAULT. Everything lands in a throwaway HOME, so running this on a real
# machine cannot touch your ~/.iris, your shell config, or your LaunchAgents. That also
# makes it honest: a warm machine measures nothing.
#
# TELEMETRY OFF. The installer emits install_start/install_success (#179077) — the funnel
# instrument. A synthetic install must not land in it, or the measurement corrupts the
# thing it exists to inform.
#
# Usage:  scripts/time-front-door.sh [--full]
#           (default: --only-code, the minimum path to a browser UI)
#           (--full:  the whole installer — SDK, app, MCP, bridge, sandbox)
set -uo pipefail

MODE="--only-code --no-modify-path"
LABEL="only-code"
[ "${1:-}" = "--full" ] && { MODE="--no-modify-path"; LABEL="full"; }

COLD="$(mktemp -d)/home"
mkdir -p "$COLD"
PORT="${PORT:-3099}"

now() { python3 -c 'import time;print(f"{time.time():.3f}"); '; }
since() { python3 -c "print(f'{$(now)-$1:.1f}s')"; }

echo "front door timing · mode=$LABEL · HOME=$COLD"
echo

# ── 1. INSTALL ───────────────────────────────────────────────────────────────
T_INSTALL=$(now)
HOME="$COLD" IRIS_TELEMETRY=0 bash -c \
  "curl -fsSL https://heyiris.io/install-code | bash -s -- $MODE" \
  > "$COLD/install.log" 2>&1
INSTALL_RC=$?
echo "  install                 $(since $T_INSTALL)   (exit $INSTALL_RC)"
BIN="$COLD/.iris/bin/iris"
[ -x "$BIN" ] || { echo "  FAILED — no binary at $BIN"; tail -20 "$COLD/install.log"; exit 1; }

# ── 2. FIRST RUN (cold, unauthenticated) ─────────────────────────────────────
T_V=$(now)
VER=$(HOME="$COLD" "$BIN" --version 2>/dev/null | tail -1)
echo "  first run (--version)   $(since $T_V)   -> ${VER:-unknown}"

T_A=$(now)
HOME="$COLD" "$BIN" auth list >/dev/null 2>&1
echo "  auth list (signed out)  $(since $T_A)"

# ── 3. BROWSER ───────────────────────────────────────────────────────────────
T_S=$(now)
HOME="$COLD" "$BIN" serve --port "$PORT" > "$COLD/serve.log" 2>&1 &
SRV=$!
for _ in $(seq 1 90); do
  sleep 1
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/global/health" 2>/dev/null && break
done
echo "  serve -> listening      $(since $T_S)"

# A STATUS CODE CANNOT ANSWER THIS. The catch-all proxies every unmatched path to
# app.opencode.ai, which serves its SPA for ANY path — so /iris returns 200 with
# <title>OpenCode</title> on a build that has no /iris route at all. Measured that
# false positive on released v1.3.202 before this line existed. Assert the identity.
FD_BODY=$(curl -s --max-time 30 "http://127.0.0.1:$PORT/iris")
FD=$(curl -s -o /dev/null -w '%{http_code} %{time_starttransfer}' --max-time 30 "http://127.0.0.1:$PORT/iris")
FD_TITLE=$(printf '%s' "$FD_BODY" | grep -o '<title>[^<]*</title>' | head -1)
if printf '%s' "$FD_TITLE" | grep -q "IRIS"; then
  FD_OWNER="ours (local)"
else
  FD_OWNER="NOT OURS — proxied upstream. #181991 not in this build."
fi
echo "  GET /iris               ${FD#* }s   (HTTP ${FD%% *})  ${FD_TITLE}  ${FD_OWNER}"
WS=$(curl -s -o /dev/null -w '%{http_code} %{time_starttransfer}' --max-time 30 "http://127.0.0.1:$PORT/")
echo "  GET /  (workspace)      ${WS#* }s   (HTTP ${WS%% *})"

kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null

echo
echo "  TOTAL cold → browser    $(since $T_INSTALL)"
echo "  logs: $COLD/install.log"
