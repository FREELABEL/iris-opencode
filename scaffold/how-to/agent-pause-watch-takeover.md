---
category: Agents
level: beginner
tags: [agents, pause, resume, stop, kill-switch, watch, live, stuck, take-over, hand-back, desktop, monitoring]
duration_min: 5
---
# How to: See what an agent is doing, take over, or stop it

## What this does

Answers "is it stuck?" — and lets you step in. You can watch an agent's current step and its
recent tool calls live, pause it after the step it is on, give it a new instruction and hand it
back, or stop it everywhere at once.

## Watch it

```bash
iris agents watch 42          # follows the run: current step, each tool call as it finishes
iris agents watch 42 --once   # print the current view and exit
```

In **IRIS Desktop**, open **Agents › Live**. It shows the step, how long it has been on it, and
the last 10 tool calls (argument names only — never values). It also flags *"the same call 3
times in a row"* and *"no activity for 10 minutes"*.

## Take over and hand back

```bash
iris agents take-over 42                                 # pauses after the current step
iris agents hand-back 42 -m "skip the archive folder"    # continues the same run, with your note
```

The Desktop **Take over** / **Hand back** buttons do the same thing.

## Pause, resume, stop

```bash
iris agents pause 42                   # refused in chat, Slack, SMS, email, schedules — everywhere
iris agents resume 42                  # also releases approvals that were held while paused
iris agents pause --all --bloq 550     # every agent in a workspace you own
iris agents stop 42                    # permanent; asks first
```

A paused agent answers with the reason instead of going silent.
