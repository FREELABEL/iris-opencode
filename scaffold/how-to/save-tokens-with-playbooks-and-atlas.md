---
category: Agents & Automation
level: beginner
tags: [playbooks, atlas, tokens, cost, benchmarks, claude-code, skills]
duration_min: 10
prerequisites: []
---
# How to: Spend fewer tokens with playbooks and `iris atlas use` (measured)

## What this does

An agent that doesn't know how to do something spends tokens **finding out**: reading `--help`,
grepping, trying commands, retrying. An agent handed a long document spends tokens **reading all
of it** to find three lines. Playbooks fix the first; Atlas fixes the second.

We measured both on 2026-09-18: 40 headless runs in the table below, 61 in all, counting a first round that exposed the trap described further down. Short version:

| Task | Without | With | Tokens | Cost per correct answer | Correct |
|---|---|---|---|---|---|
| Find the right CLI command (NDA) | explore `--help` | playbook installed | **−63%** (148k → 54k) | **−39%** ($0.116 → $0.071) | 4/5 → **5/5** |
| Answer a process question | search for it | playbook installed | **−44%** (112k → 63k) | **−55%** ($0.240 → $0.108) | 2/5 → **5/5** |
| Answer from a short call (≈2,000 words) | paste the transcript | `iris atlas use <item>` | +73% (25k → 44k) | −20% ($0.040 → $0.032) | 5/5 → 5/5 |
| Answer from a day of calls (≈16,700 words) | paste the transcripts | `iris atlas use <item>` | −17% (53k → 44k) | **−79%** ($0.154 → $0.032) | 5/5 → 5/5 |

*Medians of 5 runs per cell. Tokens are all input tokens (fresh + cached). Claude Sonnet via Claude
Code. Cost is Claude Code's own reported cost.*

**And one result that matters more than the savings:** a playbook whose skill copy is *missing its
commands* made things **worse**, not better: 2/5 correct and 228k tokens, against 4/5 and 148k
with no playbook at all. See "The trap" below.

---

## Why it saves tokens

```
WITHOUT A PLAYBOOK                          WITH A PLAYBOOK
agent ─▶ iris --help           (reads)     agent ─▶ skill already knows:
      ─▶ iris agreements --help (reads)           "iris agreements raise --name … --email …"
      ─▶ grep the repo          (reads)          ─▶ answer
      ─▶ tries a flag, fails    (reads)
      ─▶ answer (sometimes wrong)
   ~7 turns · ~150k tokens                     ~3 turns · ~54k tokens
```

Every turn re-sends the whole conversation, so the cost of exploring **compounds**. Knowing the
answer up front removes the turns, not just the reading.

Atlas works the other way round. The expensive part is the **size of what the agent has to read**.
A day of call transcripts is ~22,000 tokens every time anyone asks a question about it. The
distilled Atlas item is a few hundred, and `iris atlas use` pulls only that.

---

## When it doesn't help (be honest about this)

- **One short source, one question:** pasting it can be *cheaper in tokens*. Fetching from Atlas
  costs an extra turn, and each turn re-sends the ~22k-token Claude Code base. It was still 20%
  cheaper in dollars (cached tokens cost less), but the token count went up. Atlas pays off when the
  source is **large** or **reused**, and it gets better every time the same notes are asked about
  again.
- **Loading a playbook costs something the first time** it's written to the cache. On the process
  question, the playbook run cost *more per run* ($0.108 vs $0.079). The cheap runs without it were
  cheap because most of them **gave up** ("I couldn't find this"). Per *correct* answer, the
  playbook was less than half the price. **Measure cost per correct answer, not cost per run.**

---

## The trap: a playbook that lost its commands

`iris playbook sync` and `install` write a Claude Code skill (`SKILL.md`) from the playbook, and
**drop the bodies of `### step:` blocks** (#186125). If the only place a command appears is inside a
step, the skill says *"there are steps"* and the agent can't see them. It goes looking, doesn't find
them, and guesses:

> "The skill file cuts off before its Steps section … Best guess, unverified: `--company` …"

Three of five runs said that, and invented flags. **Fix:** put the commands a person or agent needs in
a normal section **above** `## Steps`, a short "Commands" table. After that fix, the same task went
to 5/5 correct in 3 turns.

Check yours:
```bash
grep -c "<a command from your playbook>" ~/.claude/skills/<name>/SKILL.md   # must be ≥ 1
```

---

## Steps

### 1. Put the know-how in a playbook
Anything an agent has to work out more than once (which command, which flags, the rules of a
process) goes in a playbook. See `playbook-sops-and-skills.md`.

### 2. Keep the commands in prose, above `## Steps`
A short table of the commands and the rules. The steps can repeat them; the prose is what the
agent actually sees.

### 3. Install it where every agent looks
```bash
iris playbook install <name>          # works from any folder: IRIS app, terminal and Claude Code
```
Installs are global (`~/.iris/playbooks` + `~/.claude/skills`, CLI 1.3.274+), so the agent finds it
without being told.

### 4. Distil calls and documents into Atlas once
Don't re-paste the transcript. File the **decisions and facts** as an Atlas item (a meeting note, a
brand brief, a status card):
```bash
iris bloqs add-item <board> <list> --title "…" --text "…"
```

### 5. Point agents at the item, not the source
```bash
iris atlas use <item-id>              # prints just that item as markdown, to pipe into any agent
```
In a prompt: *"The call notes are in Atlas item 12345 — read them with `iris atlas use 12345`."*

### 6. Measure your own
Run the same question 5+ times with and without, and compare **median tokens** and **cost per
correct answer**. One run proves nothing: in our data a single run of the *same* condition ranged
from 81k to 1.6M tokens.

---

## How we measured (so you can repeat it)

- `claude -p "<question>" --model sonnet --output-format json --no-session-persistence`, in an empty
  folder, 5 runs per condition, 5 in parallel. Tokens and cost come from the JSON `usage` and
  `total_cost_usd`.
- **Playbook off:** `--disable-slash-commands` (no skills). **Playbook on:** skills enabled, the
  playbook installed globally. Same prompt, word for word.
- **Atlas off:** the transcript pasted into the prompt. **Atlas on:** the prompt names the item and
  the `iris atlas use` command.
- Every answer was checked for the right facts; a confident wrong answer counts as wrong.
- Allowed tools: Bash, Read, Grep, Glob, Skill. Every command that creates, sends or deletes was
  blocked. IRIS MCP tools were not allowed in either condition; a few "without" runs asked for them
  and gave up. That is part of why "without" is less accurate, and it's what a locked-down agent
  looks like.

**Caveats:** one model (Sonnet), four tasks, one day. The ~22k-token Claude Code base cost is in
every number; for a bare API call the percentages would be larger. These are our tasks; yours will
differ, which is why step 6 exists.

---

## Related

- `playbook-sops-and-skills.md` — writing a playbook that people and agents both use
- `drive-iris-from-claude-code.md` — IRIS from Claude Code
- `meetings.md` — turning a call into filed notes
- Playbooks: https://heyiris.io/playbooks/iris-atlas · https://heyiris.io/playbooks/iris-memory
