# Shared by r4.sh / r5.sh (epic #192964, W2). Run ON the Desktop machine ("A"); every
# observation of the Hive is made from a SECOND machine over ssh ("OBS"), never from A itself.
set -uo pipefail
OBS="${OBS:-iris-hive-001}"
OBS_IRIS="${OBS_IRIS:-~/.iris/bin/iris}"
now() { python3 -c 'import time;print(f"{time.time():.3f}")'; }
iso_now() { python3 -c 'import datetime;print(datetime.datetime.now(datetime.timezone.utc).isoformat())'; }

# This machine's node id, from its own daemon. Empty when the daemon is down or not enrolled.
local_node_id() {
  curl -s -m 2 http://localhost:3200/health 2>/dev/null | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("node_id") or "")
except Exception: print("")'
}

# "<connection_status> <last_heartbeat_at>" for node $1 (id or name), as OBS sees it; "absent" if unlisted.
obs_node() {
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$OBS" "$OBS_IRIS hive nodes list --json" 2>/dev/null |
    python3 -c 'import sys,json
want=sys.argv[1]
try: d=json.load(sys.stdin)
except Exception: print("error -"); sys.exit()
rows=[n for n in d.get("data",[]) if want in (n.get("id"),n.get("name"))]
rows.sort(key=lambda n:n.get("last_heartbeat_at") or "", reverse=True)
print("%s %s" % (rows[0].get("connection_status"), rows[0].get("last_heartbeat_at")) if rows else "absent -")' "$1"
}

# Poll OBS until node $1 reaches state $2 (online|offline), with a heartbeat after $3 (iso, for online).
# Prints elapsed seconds, or "timeout" after $4 seconds.
wait_state() {
  local node="$1" want="$2" after="$3" limit="$4" t0 st hb
  t0=$(now)
  while :; do
    read -r st hb < <(obs_node "$node")
    if [ "$want" = online ] && { [ "$st" = online ] || [ "$st" = busy ]; } && [[ "$hb" > "$after" ]]; then break; fi
    if [ "$want" = offline ] && { [ "$st" = offline ] || [ "$st" = absent ]; }; then break; fi
    if python3 -c "import sys;sys.exit(0 if $(now)-$t0>$limit else 1)"; then echo timeout; return 1; fi
    sleep 2
  done
  python3 -c "print(round($(now)-$t0,1))"
}

# The running Desktop engine: port + basic-auth from ~/.iris/servers/<port>.json whose pid is alive
# and is an app engine (not the CLI's `iris serve --service`). ENGINE_PORT overrides.
engine() {
  python3 - "${ENGINE_PORT:-}" <<'PY'
import json,glob,os,sys,subprocess
want=sys.argv[1]
best=None
for f in glob.glob(os.path.expanduser("~/.iris/servers/*.json")):
  try: d=json.load(open(f))
  except Exception: continue
  if want and str(d.get("port"))!=want: continue
  try: cmd=subprocess.run(["ps","-o","command=","-p",str(d["pid"])],capture_output=True,text=True).stdout
  except Exception: continue
  if not cmd or ("--service" in cmd and not want): continue
  if best is None or os.path.getmtime(f)>best[0]: best=(os.path.getmtime(f),d)
if best: d=best[1]; print(f'http://127.0.0.1:{d["port"]} {d["username"]}:{d["password"]}')
PY
}
