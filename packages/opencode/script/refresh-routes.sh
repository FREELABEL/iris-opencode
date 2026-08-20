#!/bin/sh
# Refresh routes.snapshot.json from the live services.
#
# check-routes.ts matches every irisFetch() path against this snapshot. When a route is
# ADDED to fl-api or fl-iris-api, the snapshot goes stale and the check reports a brand-new,
# perfectly good endpoint as dead. That is the failure mode to expect from this design, and
# it is the cheap one: a false positive that blocks a push, rather than a false negative that
# ships a broken command.
#
# Reads from PRODUCTION rather than a local checkout on purpose — the snapshot should
# describe what the CLI will actually talk to, not what happens to be on this laptop.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "reading route tables from production..."
railway ssh -s fl-api      -- php artisan route:list --json > /tmp/routes-fl.raw
railway ssh -s fl-iris-api -- php artisan route:list --json > /tmp/routes-iris.raw

python3 - "$DIR" <<'PY'
import json, re, sys
out = {"generated_note": "Snapshot of the fl-api + fl-iris-api route tables. Refresh with script/refresh-routes.sh.", "routes": []}
seen = set()
for path, svc in (("/tmp/routes-fl.raw", "fl-api"), ("/tmp/routes-iris.raw", "iris-api")):
    raw = open(path).read()
    # railway ssh prepends its own noise (including log lines with bracketed
    # timestamps like "[2026-08-20 ...]", which broke a plain first-"[" search) —
    # anchor on the actual start of the route array instead.
    data = json.loads(raw[raw.index('[{"domain"'):])
    for r in data:
        uri = "/" + re.sub(r"\{[^}]+\}", "{}", r["uri"].lstrip("/"))
        for m in r["method"].split("|"):
            if m == "HEAD" or (m, uri) in seen:
                continue
            seen.add((m, uri))
            out["routes"].append({"method": m, "uri": uri, "service": svc})
out["routes"].sort(key=lambda r: (r["uri"], r["method"]))
json.dump(out, open(sys.argv[1] + "/routes.snapshot.json", "w"), indent=0)
print(f"  {len(out['routes'])} routes")
PY

echo "done — commit script/routes.snapshot.json"
