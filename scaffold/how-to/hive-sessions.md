# How to: hive sessions

---
category: Infrastructure
level: beginner
tags: [hive, sessions, claude-code, opencode, multi-agent]
duration_min: 8
---
# How to: See every AI session running across your machines

## What this does

Shows every Claude Code, opencode and ollama session running anywhere in your Hive — which
machine, which model, which branch, and how long since it last did anything. Then lets you
send a message into any of them without knowing which machine they are on.

If you run agents on more than one computer, this is the view that tells you what is actually
happening right now.

## Prerequisites

- `iris auth login`
- At least one machine connected (`iris hive nodes list` shows it)

## Steps

**1. See what is running**

```bash
iris hive sessions
```

```
  node             status   age   provider     model                session
  AlexMaysnow1063  active   1m    claude_code  claude-opus-5        Fixing the intake review flow (main)
  MacBookPro       active   4m    claude_code  claude-opus-5        Refreshing the landing page (main)
  AlexMaysnow1063  idle     3h    opencode     iris/iris-ai         freelabel · b116f4a8 (main)

  34 shown · 25 active · 36 stale hidden (--all)
```

**Read the status column first.** `active` means it did something in the last half hour.
`idle` means today. `stale` means it has not moved in over a day — those are hidden by
default, which is why the summary line tells you how many were left out.

**2. Narrow it down**

```bash
iris hive sessions --node MacBookPro     # one machine
iris hive sessions --status idle         # only idle ones
iris hive sessions --all                 # include stale
iris hive sessions --json                # for scripts
```

**3. Send a message into a running session**

```bash
iris hive send-input <session-id> "run the tests and report back"
```

You do not name the machine. The session id is looked up across your fleet and the message
goes to whichever node holds it.

Get the id from `iris hive sessions --json`, or use the last 8 characters — a suffix works as
long as it is unambiguous.

## What the session names mean

Some sessions show something like `freelabel · b116f4a8` instead of a title. That is not a
bug. A session's name is whatever its first message happened to be, and on a real fleet that
includes raw tool ids, box-drawing characters and `New session - <timestamp>` — none of which
identify anything. When the reported name is unusable, you get the project and a short id
instead, which are stable and actually mean something.

## Common problems

**"That session is stale — it is unlikely to answer"**
`send-input` refuses rather than sending into something that stopped moving over a day ago.
Check with `iris hive sessions --all`; if you meant it, restart the session first.

**"matches N sessions — use the full id"**
Your suffix was ambiguous. Session ids share leading characters, so nothing here matches on a
prefix — pass more of the id.

**A machine shows sessions that are clearly gone**
Its daemon may have stopped reporting. See `iris hive doctor` and check the node's own
loopback health; a node that cannot report sessions keeps showing its last known list.

## Related

- `iris hive nodes list` — the machines themselves
- `iris hive run <node> "<cmd>"` — run a one-off command instead of talking to a session
- `iris hive doctor` — why a node is not reporting
