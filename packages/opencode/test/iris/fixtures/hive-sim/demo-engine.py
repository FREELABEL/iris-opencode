#!/usr/bin/env python3
"""Demo hive-simulations engine (#194084): follows the playbook's contract and writes the optional
event feed (HIVE_SIM_EVENTS). Standard library only. A fixture for tests and the live preview, not
a model of anything — the numbers are made up and say so.

  --refresh            "pull": write the demo dataset beside the run (in $TMPDIR)
  --worlds N --cohort N --days N
  HIVE_SIM_DEMO_SECONDS  how long the simulate step takes (default 10)
  HIVE_SIM_DEMO_BAD=1    corrupt one row so the tie-out fails
  HIVE_SIM_DEMO_NOISE=1  also write lines the feed must ignore
"""
import json
import os
import random
import statistics
import sys
import time

ARGS = sys.argv[1:]


def knob(name, default):
    flag = "--" + name
    if flag in ARGS:
        i = ARGS.index(flag)
        if i + 1 < len(ARGS):
            return int(ARGS[i + 1])
    return default


WORLDS = knob("worlds", 4000)
COHORT = knob("cohort", 1000)
DAYS = knob("days", 30)
TMP = os.environ.get("TMPDIR", "/tmp")
DATASET = os.path.join(TMP, "demo-dataset.json")
EVENTS = os.environ.get("HIVE_SIM_EVENTS")


def emit(obj):
    if not EVENTS:
        return
    with open(EVENTS, "a") as f:
        f.write(json.dumps(obj) + "\n")
        f.flush()


def build():
    rng = random.Random(7)
    rows = []
    for user in range(1, 241):
        series = [round(rng.lognormvariate(-1.0, 1.2), 4) for _ in range(rng.randint(1, DAYS))]
        rows.append({"user": user, "series": series, "median": statistics.median(series)})
    return {"pulled_at": "demo", "rows": rows}


if "--refresh" in ARGS:
    with open(DATASET, "w") as f:
        json.dump(build(), f)
    print("pulled %d rows" % len(build()["rows"]))
    sys.exit(0)

data = json.load(open(DATASET)) if os.path.exists(DATASET) else build()
if os.environ.get("HIVE_SIM_DEMO_BAD") == "1":
    data["rows"][192]["median"] = 4.193

# TIE-OUT before anything prints: the raw series must reproduce what the source computed from it.
for row in data["rows"]:
    got = statistics.median(row["series"])
    if abs(got - row["median"]) > 1e-9:
        sys.stderr.write("user %d: median $%.4f vs $%.4f\n" % (row["user"], row["median"], got))
        sys.exit(1)

print("DEMO ENGINE — numbers are made up")
print("MEASURED: daily spend per account (%dd pull), active days per account" % DAYS)
print("DRAWN: free-tier active days per month, conversion at the cap")
emit({"type": "inputs", "measured": ["daily spend per account", "active days per account"], "drawn": ["free-tier active days / month", "conversion at the cap"]})
if os.environ.get("HIVE_SIM_DEMO_NOISE") == "1":
    if EVENTS:
        with open(EVENTS, "a") as f:
            f.write("not json at all\n")
            f.write(json.dumps({"type": "progress", "done": "x"}) + "\n")
            f.write(json.dumps({"type": "mystery"}) + "\n")

pool = [v for row in data["rows"] for v in row["series"]]
caps = [0.25, 1.00, 5.00]
rng = random.Random(11)
seconds = float(os.environ.get("HIVE_SIM_DEMO_SECONDS", "10")) if WORLDS > 1 else 0
chunks = 20
results = {c: [] for c in caps}
for k in range(chunks):
    n = max(1, WORLDS // chunks)
    for _ in range(n):
        active = rng.randint(2, 14)
        draws = [rng.choice(pool) for _ in range(min(COHORT, 50))]
        for c in caps:
            results[c].append(sum(min(d, c) for d in draws) * active / 50.0)
    done = min(WORLDS, (k + 1) * n) if k < chunks - 1 else WORLDS
    emit({"type": "progress", "done": done, "total": WORLDS})
    print("simulated %d / %d worlds" % (done, WORLDS), flush=True)
    if k == chunks // 2:
        emit({"type": "table", "title": "Free cap ranking (median world)", "columns": ["cap", "median $/user", "lost in"], "rows": [["$%.2f" % c, "…", "…"] for c in caps]})
    if seconds:
        time.sleep(seconds / chunks)

rows = []
for c in caps:
    xs = sorted(results[c])
    rows.append(["$%.2f" % c, "%.3f" % xs[len(xs) // 2], "%d of %d" % (sum(1 for x in xs if x < 0.05), len(xs))])
print("")
print("RANKING (median world)  [MEASURED pool, DRAWN activity]")
for r in rows:
    print("  %-6s %8s   lost in %s" % tuple(r))
emit({"type": "table", "title": "Free cap ranking (median world)", "columns": ["cap", "median $/user", "lost in"], "rows": rows})
flip = "Free-tier active days per month flips the ranking: at 2-4 days the $0.25 cap wins, at 12+ the $5.00 cap wins."
print("")
print("THE FLIP")
print("  " + flip)
emit({"type": "flip", "text": flip, "input": "free-tier active days / month", "range": "2-4 vs 12+"})
