---
category: Agents & Automation
level: beginner
tags: [agents, desktop, picker, sync, local, permissions]
duration_min: 3
---
# How to: Use your IRIS agents in IRIS Desktop

## What this does
Every agent on your IRIS account appears in the IRIS Desktop agent picker. Picked from there,
an agent works on your own computer with full tools — it reads and edits your files, runs
commands, and searches the web — while its facts (your records, knowledge and memory) still
come from IRIS. Your data stays on your machine; only the agent's questions go to IRIS.

## Steps
1. Preview what will change (writes nothing):
   `iris agents desktop-sync --dry-run`
2. Add your agents:
   `iris agents desktop-sync`
3. Restart IRIS Desktop. Your agents are in the agent picker, named `iris-<agent name>`.

Run step 2 again whenever you add, rename or remove an agent. Agents that are gone are removed;
nothing else changes.

## Only some agents
`iris agents desktop-sync --agent 12,34` adds just those two. This form never removes anything.

## What the agents may do
Everything, with no prompts — except three commands that cannot be undone, which ask first:
`rm -rf`, `git push` and `git reset --hard`.

## If something looks wrong
- **"Not logged in"** — run `iris auth login`, then step 2 again.
- **An agent did not appear** — restart IRIS Desktop; it reads agents when it starts.
- **"hand-written — left alone"** — you made a file with that name yourself. The sync never
  overwrites it. Delete it if you want the sync to manage that agent.
- **People and test agents are skipped** on purpose; only agents you would pick are added.
