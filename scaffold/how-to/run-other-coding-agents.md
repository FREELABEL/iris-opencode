---
category: Agents & Automation
level: intermediate
tags: [acp, claude-code, codex, gemini, opencode, agents, hive, sessions]
duration_min: 8
prerequisites: [iris-login]
---
# How to: Run Claude Code, Codex or Gemini from IRIS (and steer them from anywhere)

## What this does

`iris acp run` starts a real coding agent (Claude Code, Codex, Gemini CLI, opencode, or IRIS
itself) and talks to it over the **Agent Client Protocol (ACP)**. One command works for all of
them, so you can switch agents per task with one flag:

- the agent's answer streams as it is written;
- every file change it wants to make is shown as a diff;
- it stops and asks you before anything risky (an edit, a command).

Each agent runs under **its own login, settings and billing**. IRIS never holds your Claude or
OpenAI key.

With `--keep` the session stays open. You can type follow-ups, and it shows up in
`iris hive sessions` (and Desktop › Hive › Sessions), so you can message it or answer its
questions **from another machine or your phone**.

> Not the same as [Drive IRIS from Claude Code](drive-iris-from-claude-code.md). That one lets an
> outside agent use IRIS. This one lets IRIS drive the outside agent.

## Prerequisites

- `iris auth login`
- The agent you want, signed in with its own CLI (for example `claude` once, to log in)
- For Claude Code and Codex, their ACP adapter (step 1). Gemini CLI and opencode speak ACP natively.

## Steps

**1. See which agents this machine can drive**

```bash
iris acp agents
```

```
  · claude    Claude Code  not installed — npm install -g @agentclientprotocol/claude-agent-acp
  · codex     Codex        not installed — npm install -g @agentclientprotocol/codex-acp
  · gemini    Gemini CLI   not installed — npm install -g @google/gemini-cli
  ✓ opencode  opencode     opencode acp
  ✓ iris      IRIS         iris acp
```

IRIS never installs an adapter for you. It prints the command; you choose to run it.

**2. Ask an agent something**

```bash
iris acp run --agent claude "add a test for the date parser"
```

When the agent wants to edit a file, you see the diff and choose:

```
▸ Edit src/date.test.ts [edit]
--- src/date.test.ts
+++ src/date.test.ts
@@ -0,0 +1,6 @@
+import { parse } from "./date"
...
? Edit src/date.test.ts [edit]
  1) Allow
  2) Always allow
  3) Reject
  choose [1-3, y, n]:
```

Switch agents with the flag, same command: `--agent codex`, `--agent gemini`, `--agent iris`.

**3. Read-only and scripted runs**

```bash
iris acp run --agent codex --no "explain how auth works in src/server.ts"   # denies every request
iris acp run --agent gemini --yes "fix the lint errors"                     # allows each request once
iris acp run --agent claude --json "…"                                      # raw ACP updates, one JSON per line
```

When stdin is not a terminal (a script, a cron job), permission requests are **denied** unless
you pass `--yes`. `--yes` allows each request once and never picks "always allow". The agent
can only read and write files inside `--cwd` (default: the current folder).

**4. Keep the session open**

```bash
iris acp run --keep --agent claude "fix the flaky checkout test"
```

```
· session 7f3c…a91e is open — reachable from Hive:
    iris hive ask a91e2b4c "<message>"   ·   iris hive answer a91e2b4c <choice>
· type a follow-up below; Ctrl-D closes the session
›
```

Type follow-ups at `›`. Ctrl-C cancels the current turn, and a second Ctrl-C quits.
`iris acp sessions` lists what is open on this machine.

**5. Steer it from another machine or your phone**

```bash
iris hive sessions                                  # shows it, provider "acp"
iris hive ask a91e2b4c "also cover the refund path" # runs a turn in the running session, prints the reply
iris hive sessions --status needs_you               # a session waiting on a permission
iris hive answer a91e2b4c 1                         # 1 Allow · 2 Always allow · 3 Reject
```

Whichever answers first wins: you at the terminal, or you from Hive. In IRIS Desktop the same
sessions are under **Hive › Sessions**, with a message box and the waiting question's options.

To keep a session running without a terminal (on a server, for example), start it in the
background. Its permission requests then wait for `iris hive answer`:

```bash
nohup iris acp run --keep --agent claude "watch the CI and fix what breaks" > acp.log 2>&1 &
```

## Verify

- `iris acp agents` shows ✓ for the agent you want.
- `iris acp run --agent iris --no "Reply with exactly the word: pong"` prints `pong`.
- With `--keep`, `iris hive sessions` lists the session on this machine after the node's next
  heartbeat.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `` `claude-agent-acp` is not installed `` | The Claude Code adapter is missing | `npm install -g @agentclientprotocol/claude-agent-acp` |
| `auth` error on the first turn | The agent is not signed in | Sign in with its own CLI (`claude`, `codex login`, `gemini`), then retry |
| "not a terminal: permission requests are denied" | Running from a script | Pass `--yes` to allow each request once, or use `--keep` and answer from Hive |
| `iris hive ask` says the agent is still on its last turn | ACP sessions take one turn at a time | Wait for it to finish (`iris hive sessions` shows `working`), then send again |
| The session is not in `iris hive sessions` | The node's daemon is older than the `acp` provider, or `--keep` was not used | Update the node (`iris hive doctor`), and start the session with `--keep` |

Every message sent to a kept session runs a turn on that agent's account. ACP has no way to
leave a note without a turn.

## Related

- [Answer a waiting agent from anywhere](answer-agents-from-anywhere.md): the same `iris hive answer`, for Claude Code running in tmux
- [Drive IRIS from Claude Code](drive-iris-from-claude-code.md): the other direction
- ACP itself: https://agentclientprotocol.com
