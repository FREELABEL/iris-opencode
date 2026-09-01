#!/usr/bin/env bash
# first-run-report.sh — did the app actually finish setting itself up?
#
# Run this on a machine AFTER downloading IRIS and signing in. It answers one question with a
# verdict rather than a vibe: did the post-login chain (CLI -> daemon install -> register)
# complete, and is the daemon actually serving?
#
# It asserts nothing it has not observed. Every check names what it looked at, so a failure
# tells you WHICH link broke instead of "setup failed".
#
#   bash first-run-report.sh
#
set -uo pipefail
PASS=0; FAIL=0
ok(){ printf '  \033[32m✓\033[0m %-34s %s\n' "$1" "${2:-}"; PASS=$((PASS+1)); }
no(){ printf '  \033[31m✗\033[0m %-34s %s\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }

echo; echo "IRIS first-run report — $(hostname -s) — $(date '+%Y-%m-%d %H:%M')"; echo

# 1. The app itself
# The bundle has shipped under more than one name (IRIS.app, "IRIS Dev.app", OpenCode.app).
# Hardcoding one would report "not installed" for an app sitting right there, so glob.
APP=""
for a in /Applications/IRIS.app "/Applications/IRIS Dev.app" /Applications/OpenCode.app; do
  [ -d "$a" ] && { APP="$a"; break; }
done
if [ -n "$APP" ]; then
  V=$(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "?")
  ok "app installed" "v$V  ($(basename "$APP"))"
else no "app installed" "no IRIS app in /Applications — install it first"; fi

# 2. Credential — written by sign-in
ENVF="$HOME/.iris/sdk/.env"
if grep -q "^IRIS_API_KEY=." "$ENVF" 2>/dev/null; then
  PERM=$(stat -f '%A' "$ENVF" 2>/dev/null || stat -c '%a' "$ENVF" 2>/dev/null)
  [ "$PERM" = "600" ] && ok "signed in" "key present, mode $PERM" \
                      || no "signed in" "key present but mode $PERM (want 600)"
else no "signed in" "no IRIS_API_KEY in $ENVF — sign in from the app"; fi

# 3. CLI — installed by the post-login chain
IRIS=""
for c in "$HOME/.opencode/bin/iris" "$HOME/.iris/bin/iris" "$(command -v iris 2>/dev/null)"; do
  [ -n "$c" ] && [ -x "$c" ] && { IRIS="$c"; break; }
done
[ -n "$IRIS" ] && ok "CLI installed" "$("$IRIS" --version 2>/dev/null | head -1) at ${IRIS/#$HOME/~}" \
               || no "CLI installed" "no iris binary found"

# 4. Runtime deps — the two that silently kill the daemon
command -v tmux >/dev/null && ok "tmux" "$(tmux -V 2>/dev/null)" \
  || no "tmux" "MISSING — daemon exits immediately. brew install tmux"
NODE=$(command -v node 2>/dev/null)
for d in "$HOME"/.iris/runtime/node-*/bin; do [ -d "$d" ] && NODE="$d/node"; done
[ -n "$NODE" ] && ok "node" "$("$NODE" --version 2>/dev/null) at ${NODE/#$HOME/~}" \
               || no "node" "MISSING — re-run the installer"

# 5. Daemon installed (launchd) and RUNNING (the health endpoint, not the plist)
PLIST="$HOME/Library/LaunchAgents/net.freelabel.iris-bridge.plist"
[ -f "$PLIST" ] && ok "daemon installed" "launchd plist present" \
                || no "daemon installed" "no plist — run: iris daemon install"
if curl -sf --max-time 4 http://localhost:3200/health >/dev/null 2>&1; then
  ok "daemon serving" "health endpoint responds on :3200"
else
  no "daemon serving" "no response on :3200 — iris daemon start; iris daemon logs"
fi

# 6. Registered with the mesh — the step that makes this machine reachable
[ -s "$HOME/.iris/mesh-keys.json" ] && ok "node registered" "mesh keys present" \
  || no "node registered" "not registered — run: iris daemon register"

echo
if [ "$FAIL" -eq 0 ]; then
  printf '  \033[32mAll %d checks passed — this machine is fully set up.\033[0m\n\n' "$PASS"
else
  printf '  \033[31m%d of %d checks failed.\033[0m Each ✗ above names its own fix.\n\n' "$FAIL" "$((PASS+FAIL))"
fi
exit $(( FAIL > 0 ))
