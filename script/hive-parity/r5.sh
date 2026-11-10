#!/usr/bin/env bash
# R5 (epic #192964): signing in to Desktop on a machine that is not enrolled makes it appear in
# `iris hive nodes list` on ANOTHER machine, without anyone running the CLI.
#
# What it does, on the Desktop machine:
#   1. un-enrolls it: stops the daemon and sets the node key aside (~/.iris/config.json is backed up
#      to config.json.r5-<ts>; restored automatically on FAIL),
#   2. runs the app's REAL post-sign-in path: writes ~/.iris/setup-pending (what save_iris_token
#      writes) and relaunches the app (resume_pending_setup runs at launch) — no email code needed,
#      because the account key is already in ~/.iris/sdk/.env,
#   3. waits up to LIMIT s for OBS to list this machine with a heartbeat newer than step 1, and for a
#      node key to be back in config.json.
#   APP=/Applications/IRIS.app (default) or a preview build. LIMIT=180.
# Never run the CLI by hand during it — that is the point.
cd "$(dirname "$0")" && source ./lib.sh
APP="${APP:-/Applications/IRIS.app}"; LIMIT="${LIMIT:-180}"; NAME="$(hostname -s)"
CFG="$HOME/.iris/config.json"; BK="$CFG.r5-$(date +%s)"
why=(); steps=()
grep -q '^IRIS_API_KEY=.' "$HOME/.iris/sdk/.env" || { echo "not signed in (~/.iris/sdk/.env has no IRIS_API_KEY) — sign in once first"; exit 2; }

t0=$(iso_now)
~/.iris/bin/iris-daemon stop >/dev/null 2>&1
cp -p "$CFG" "$BK"
python3 - "$CFG" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p))
for k in ("node_api_key","node_id","node_api_key_previous"): d.pop(k,None)
json.dump(d,open(p,"w"),indent=2)
PY
steps+=("\"unenrolled\": \"daemon stopped, node key removed (backup $BK)\"")

# The app's own hand-off from sign-in to setup, then a relaunch — exactly what the sign-in window does.
: > "$HOME/.iris/setup-pending"
osascript -e "quit app \"$APP\"" >/dev/null 2>&1; sleep 4
pkill -f "$APP/Contents/MacOS/IRIS" 2>/dev/null; sleep 1
open -a "$APP"
steps+=("\"app\": \"$APP $(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null)\"")

s=$(wait_state "$NAME" online "$t0" "$LIMIT"); steps+=("\"signin_to_online_s\": \"$s\"")
[ "$s" = timeout ] && why+=("not online on $OBS within ${LIMIT}s of the app's post-sign-in setup")
key=$(python3 -c "import json;print('yes' if json.load(open('$CFG')).get('node_api_key') else 'no')")
steps+=("\"node_key_back\": \"$key\"")
[ "$key" = yes ] || why+=("no node key in ~/.iris/config.json after setup")
steps+=("\"daemon_log\": $(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$(tail -400 ~/.iris/logs/daemon.stdout.log 2>/dev/null | grep -iE 'enrol|register|node key|heal' | tail -4 | cut -c1-240)")")

verdict=$([ ${#why[@]} -eq 0 ] && echo PASS || echo FAIL)
if [ $verdict = FAIL ]; then
  cp -p "$BK" "$CFG"; ~/.iris/bin/iris-daemon start >/dev/null 2>&1
  steps+=("\"restored\": \"config.json from backup, daemon started\"")
fi
{ printf '{\n "check": "R5",\n "epic": 192964,\n "at": "%s",\n "machine": "%s",\n "observer": "%s",\n' "$(iso_now)" "$NAME" "$OBS"
  for s in "${steps[@]}"; do printf ' %s,\n' "$s"; done
  printf ' "verdict": "%s",\n "why": [' "$verdict"; sep=""; for w in ${why[@]+"${why[@]}"}; do printf '%s\n  %s' "$sep" "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$w")"; sep=","; done; printf '\n ]\n}\n'; }
[ $verdict = PASS ]
