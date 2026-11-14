---
category: Infrastructure
level: beginner
tags: [hive, inventory, machines, on-prem, planning, gpu, local-models]
duration_min: 5
---
# How to: See what your own machines can run

## What this does

Shows every machine in your Hive in one list: whether it is online, its CPU, memory, GPU and free disk,
how many jobs it can take right now, and which AI models it is serving. Read it before deciding where
something should run, so you can use hardware you already own before paying for cloud.

## Before you start

- You are signed in to IRIS.
- At least one machine is connected. If none is, follow `iris how-to view hive-dispatch`.

## Step 1: See your machines

```bash
iris hive inventory
```

```
  ● office-pc     4 cores   31GB   1318GB free  no GPU
    3 free slots · hive/qwen3:14b
  ○ old-laptop    10 cores  16GB   ?            Apple M1 Pro

  1 of 2 online · 3 free slots · 1 models serving
```

A filled dot means online. An offline machine stays on the list but has no free slots. A `?` means the
machine never reported that value, or that its last reading can't be trusted because it is offline. It
does not mean zero.

## Step 2: Let an agent plan with it

Ask an IRIS agent to design something, for example "design a nightly job that summarizes these documents".
It checks your machines first, puts the work on what you own, and tells you if anything has to use cloud
and why. To read the same data in a script, add `--json`.

## If something goes wrong

- **"No machines yet":** connect one with `iris how-to view hive-dispatch`.
- **"Not authenticated":** run `iris auth login`.
- **A model is listed nowhere:** a model only counts once it is being served. Run `iris hive models` to see
  why, and `iris hive models serve on` on that machine to share it.
