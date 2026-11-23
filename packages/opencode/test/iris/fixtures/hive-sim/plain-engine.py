#!/usr/bin/env python3
"""A hive-simulations engine that does NOT write the event feed (#194084): the view must still
show its steps, its header's MEASURED/DRAWN and its output. Standard library only; made-up numbers.
  HIVE_SIM_DEMO_SECONDS  how long the simulate step takes (default 6)
"""
import os
import random
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
rows = [3, 1, 4, 1, 5, 9, 2, 6]
if sum(rows) != 31:
    sys.stderr.write("tie-out: rows sum to %d, the source says 31\n" % sum(rows))
    sys.exit(1)
print("PLAIN ENGINE (no event feed) — numbers are made up")
print("MEASURED: weekly orders per store | DRAWN: price elasticity")
seconds = float(os.environ.get("HIVE_SIM_DEMO_SECONDS", "6")) if WORLDS > 1 else 0
rng = random.Random(3)
for k in range(12):
    print("world batch %d/12: mean %.2f" % (k + 1, rng.gauss(10, 2)), flush=True)
    if seconds:
        time.sleep(seconds / 12)
print("RANKING: keep price > raise 5% > raise 10%")
print("FLIP: elasticity below -1.4 puts 'keep price' last.")
