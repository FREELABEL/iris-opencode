#!/usr/bin/env bash
# R4 (epic #192964): Desktop → Settings → Hive → "Allow access to this computer".
#   ON  → this machine is online in `iris hive nodes list` on ANOTHER machine within 30 s.
#   OFF → offline there within 30 s, and `iris hive send-input` to its sessions is refused.
# Drives the switch through the Desktop engine route the toggle uses (GET/PUT /iris/hive/remote-access).
# Exit 0 only when every step passes. Prints one JSON verdict.
#   --baseline-stop   also measure today's nearest thing (stopping the daemon) — RED evidence only.
cd "$(dirname "$0")" && source ./lib.sh
LIMIT=30; BASELINE=0; [ "${1:-}" = --baseline-stop ] && BASELINE=1
why=(); steps=()
NODE=$(local_node_id); [ -z "$NODE" ] && NODE="$(hostname -s)"
read -r E AUTH < <(engine) || true
put() { curl -s -m 120 -u "$AUTH" -H 'content-type: application/json' -X PUT -d "{\"allow\":$1}" "$E/iris/hive/remote-access"; }

code=$( [ -n "${E:-}" ] && curl -s -m 5 -o /dev/null -w '%{http_code}' -u "$AUTH" "$E/iris/hive/remote-access" || echo none)
steps+=("\"switch_route\": \"$code\"")
if [ "$code" != 200 ]; then
  why+=("no switch: GET /iris/hive/remote-access on the Desktop engine (${E:-no engine found}) → $code")
else
  # OFF
  put false >/dev/null; s=$(wait_state "$NODE" offline - $LIMIT); steps+=("\"off_to_offline_s\": \"$s\"")
  [ "$s" = timeout ] && why+=("OFF: still online on $OBS after ${LIMIT}s")
  # send-input to one of this node's sessions must be refused. Taken from the observer's list.
  sid=$(ssh -o BatchMode=yes "$OBS" "$OBS_IRIS hive nodes list --json" | python3 -c 'import sys,json
d=json.load(sys.stdin); n=[x for x in d["data"] if x["id"]==sys.argv[1]]
s=[a for x in n for a in (x.get("active_sessions") or []) if a.get("provider") in ("claude_code","opencode")]
print(s[0]["session_id"] if s else "")' "$NODE")
  if [ -z "$sid" ]; then
    why+=("OFF: no claude_code/opencode session of this node listed on $OBS to probe send-input with"); steps+=("\"send_input\": \"no-session\"")
  else
    out=$(ssh -o BatchMode=yes "$OBS" "$OBS_IRIS hive send-input $sid '[R4 probe, epic #192964] remote access is OFF; this must be refused' --json" 2>&1); rc=$?
    refused=$(printf '%s' "$out" | grep -qiE 'offline|remote access|refus|not online' && [ $rc -ne 0 -o -n "$(printf '%s' "$out" | grep -i '"ok": *false')" ] && echo yes || echo no)
    steps+=("\"send_input_rc\": $rc" "\"send_input_refused\": \"$refused\"")
    [ "$refused" = yes ] || why+=("OFF: send-input to $sid was not refused (rc=$rc): $(printf '%s' "$out" | tr '\n"' ' ' | cut -c1-200)")
  fi
  # ON
  t=$(iso_now); put true >/dev/null; s=$(wait_state "$NODE" online "$t" $LIMIT); steps+=("\"on_to_online_s\": \"$s\"")
  [ "$s" = timeout ] && why+=("ON: not online on $OBS within ${LIMIT}s")
fi

if [ $BASELINE = 1 ]; then
  # Today's only way to take a machine off: stop its daemon. How long until another machine sees it?
  ~/.iris/bin/iris-daemon stop >/dev/null 2>&1
  s=$(wait_state "$NODE" offline - 240); steps+=("\"baseline_daemon_stop_to_offline_s\": \"$s\"")
  t=$(iso_now); ~/.iris/bin/iris-daemon start >/dev/null 2>&1
  s=$(wait_state "$NODE" online "$t" 120); steps+=("\"baseline_daemon_start_to_online_s\": \"$s\"")
fi

verdict=$([ ${#why[@]} -eq 0 ] && echo PASS || echo FAIL)
{ printf '{\n "check": "R4",\n "epic": 192964,\n "at": "%s",\n "machine": "%s",\n "node": "%s",\n "observer": "%s",\n' "$(iso_now)" "$(hostname -s)" "$NODE" "$OBS"
  for s in "${steps[@]}"; do printf ' %s,\n' "$s"; done
  printf ' "verdict": "%s",\n "why": [' "$verdict"; sep=""; for w in ${why[@]+"${why[@]}"}; do printf '%s\n  %s' "$sep" "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$w")"; sep=","; done; printf '\n ]\n}\n'; }
[ $verdict = PASS ]
