---
category: Agents & Automation
level: beginner
tags: [hive, answer, away, needs-you, claude-code, phone, sessions]
duration_min: 6
---
# How to: Answer a waiting agent from anywhere

## What this does

When a Claude Code session on one of your machines stops to ask you a question ("Which layout?",
"Run it on production?"), IRIS shows it as **needs you** — with the question and its options —
and lets you answer it from any other machine, or from your phone, without opening that terminal.

## Prerequisites

- `iris auth login`, and the machine is in your Hive (`iris hive nodes list`)
- The agent runs **inside tmux** (or you turn on away mode before you leave — see step 3)

## Steps

**1. Install the answer hook — once per machine**

```bash
iris hive answers install
```

This adds one entry to `~/.claude/settings.json` and changes nothing else in it (a backup is
kept as `settings.json.bak-iris`). Remove it any time with `iris hive answers uninstall`.

**2. See what is waiting on you**

```bash
iris hive sessions --status needs_you
```

```
  node             status     age   provider     model        session
  MacBookPro       needs you  2m    claude_code  claude-opus  Pricing page (main)
                             ? Which layout for the pricing section?
                               1. Three tiers (Recommended)
                               2. One plan
                               3. A table
```

**3. Going away from the machine? Turn on away mode first**

```bash
iris hive away on --for 2h
```

In away mode, a new question waits for a remote answer instead of appearing on screen (for up to
30 minutes each), so it can be answered from anywhere. `iris hive away off` puts things back.

**4. Answer it — by option number or by label**

```bash
iris hive answer <session-id> 2
```

```
  ✓ answered via the waiting hook · MacBookPro
    Which layout for the pricing section? → One plan
```

The last 8 characters of the session id are enough.

## From your phone

Connect IRIS to the Claude app (Settings → Connectors) and ask it: "what is waiting on me in my
Hive?" then "answer it with option 2". It runs the same two commands as you.

## Common problems

**"the question is on a screen this machine cannot type into"** — the session is not running
inside tmux and away mode was off when it asked. Answer it on that machine, and next time run the
agent inside tmux or turn on `iris hive away` before you leave.

**"that session is not waiting on a question right now"** — it was already answered, on screen or
by someone else.

**Multi-question prompts or a typed (free-text) answer** — these go through away mode only; they
are never typed as keystrokes.
