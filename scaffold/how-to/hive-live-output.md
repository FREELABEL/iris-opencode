---
category: Infrastructure
level: beginner
tags: [hive, tasks, monitoring, realtime, debugging, logs, stream, streaming, live, watch, stdout, stderr, tail]
duration_min: 5
---
# How to: Watch a task while it runs

## What this does

Shows a running task's output as it happens, instead of a progress bar and then a wall of text
when it is over. A ten-minute task used to show nothing for ten minutes.

Open the Hive dashboard, expand a running task, and its output streams in — stdout in grey,
stderr in red, with a pulse on the header while it is live.

## Steps

**1. Start something that takes a while**

```bash
iris hive run <node> "for i in 1 2 3 4 5; do echo step \$i; sleep 3; done"
```

**2. Watch it**

Open the Hive dashboard, **Activity** tab, and expand the task. Output appears within about a
second of the machine printing it.

## What the view is telling you

**`Live output` with a pulsing dot** — the task is running and this is arriving now. Once it
finishes, the pane switches to the final result.

**`… N chunk(s) missed`** — a gap. Delivery is not ordered or guaranteed, so a chunk that never
arrived is announced rather than skipped. Without that marker a log with a hole in it looks
exactly like a continuous one, and you would read the wrong story out of it.

**`… N line(s) dropped — output faster than the wire`** — the machine printed faster than it
could send. The newest lines are kept, because that is what a watcher wants, and the count tells
you how much you did not see. This is a live view, not a transcript: the complete output still
arrives in the result when the task ends.

**`Running — waiting for output…`** — running, nothing printed yet. Different from "no output
available", which means a finished task that produced none.

## Limits worth knowing

- The pane holds the last **400 lines** per task. An unbounded buffer in a browser tab is a
  memory leak with a nice name.
- Chunks are capped at 8KB and batched about once a second. A task that prints a megabyte a
  second will be dropping most of it, and will say so.
- The full output is still capped at **50,000 bytes** in the stored result, tail-kept.

## Common problems

**Nothing appears, but the task is clearly running**
The machine may be on an older daemon. `iris hive nodes list` shows each node's daemon version;
update the node and restart it.

**Output appears only when the task finishes**
Same cause. The final result has always worked — it is the live half that needs the new daemon.

**stderr and stdout look interleaved oddly**
They are separate streams arriving independently, so ordering between them is approximate. Each
stream is in order relative to itself.

## Related

- `iris hive sessions` — what is running across every machine, not one task's output
- `iris hive nodes list` — daemon versions, and whether a node contains what it runs
- `iris hive doctor` — why a node is not reporting at all
