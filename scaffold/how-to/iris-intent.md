---
category: Getting Started
level: beginner
tags: [intent, find, commands, decide, jev, agents]
duration_min: 5
---
# How to: Ask IRIS which commands to run (`iris intent`)

## What this does
Say what you want in plain English and get back the IRIS commands that do it — the best one
first, arguments filled in where your request supplies them, and a ranked list of everything
else that could help.

`iris find` is a **search**: it lists what matches your words. `iris intent` **decides**: it picks
the command for the job. The decision is made by Decide, powered by Jev, in one call of about
a quarter of a second.

How it works, with the measurements: https://heyiris.io/p/iris-intent-how-it-works

## Prerequisites
- IRIS CLI **v1.3.289 or later** — check with `iris --version`, update with `iris upgrade`
- Signed in (`iris auth`)
- For the best picks, the local Decide service (powered by Jev) running on this machine.
  Without it, `iris intent` still answers, using the platform classifier and then plain search
  order — and says so.

## Steps

### 1. Ask in your own words
```bash
$ iris intent "find places to eat in austin texas"

  geo nearby  (decide:jev · 91% · 321ms)
  find places of a kind near an address (pediatrician, urgent care, daycare)

  → iris geo nearby <address>
  → iris web-search "places to eat in austin texas"
  → iris atlas search "places to eat in austin texas"
  ────────────────────────────────────────────
  also relevant (5)  ranked by Decide
   60%  iris venues enrich <id>
   54%  iris leads discover
   …
```
The first line is the pick and how sure Decide was. The `→` lines are ready to run: a web search
and an Atlas search are added when Decide is confident they would help. Anything in `<angle
brackets>` is a value your request didn't give — fill it in yourself.

### 2. Ask for a multi-step job
Join steps with **and** or **then**; each step gets its own pick:
```bash
$ iris intent "transcribe this video and build a website from it"
  → iris transcribe
  → iris genesis compose <description..>
```
Add the video's URL to the transcribe step. Big jobs can also come back as a **playbook** — a
guided, multi-step procedure such as `iris playbook run genesis-bespoke` — instead of a single
command.

### 3. See more options (5–30)
```bash
$ iris intent "build a website for my coffee shop" --top 20
```
Every candidate gets its own "would this help?" score in the same call, so asking for 20 costs
no more time than asking for 5.

### 4. Let a model write the arguments (slower)
```bash
$ iris intent "find places to eat in austin texas" --fill
  → iris geo nearby "Austin, Texas"
  → iris web-search "best places to eat in Austin Texas"
  → iris atlas search "favorite foods"
  → iris atlas search "family"
```
`--fill` asks a nano model to write concrete arguments, including Atlas searches for things you
have saved that shape the answer. It adds **3–12 seconds**. It can only fill arguments for the
commands Decide picked; it can't swap in a different command.

### 5. Run it
```bash
$ iris intent "check platform health" --run
```
Runs the first command. If it still has a `<placeholder>`, it stops and prints the command for
you to complete instead of guessing.

### 6. Use it from an agent or a script
```bash
$ iris intent "connect my instagram" --json
```
Returns `choice`, `run`, `commands[]`, `related[]` (with a `relevance` score each),
`decided_by`, `fell_back[]` (why any engine was skipped) and `timing` (`decide_ms`, `fill_ms`,
`total_ms`).

## Options

| Flag | What it does |
|---|---|
| `--top N` | How many related commands to list, 5–30 (default 10) |
| `--fill` | A nano model writes the arguments and personal Atlas searches (+3–12 s) |
| `--run` | Run the first command, unless it still needs an argument |
| `--json` | Machine-readable answer, with timings and fallbacks |
| `--via decide\|platform\|keyword` | Force one engine; `keyword` is plain search order |
| `--limit N` | How many search candidates Decide chooses between (default 12) |
| `--choices a,b` | The older mode: sort a message into your own labels |

## How it decides
1. **Candidates** — the same index `iris find` uses gives the top commands for each step, plus
   two playbooks and the two lookups that help almost anything (`web-search`, `atlas search`).
2. **Decide (Jev)** — one call answers every question at once: which command, would the web
   help, would your saved notes help, and a yes/no "would this help" for ~40 more.
3. **Arguments** — from your request by default (its topic for a search, a URL for `<url>`), or
   written by a model with `--fill`.
4. **Guard** — every line must run the command Decide picked, with no shell operators outside
   quotes.

## Troubleshooting
- **"fell back to keyword order — Decide: not running"** — the Decide service isn't reachable
  on this machine. The answer is plain search order. If yours runs somewhere else, point at it
  with `DECIDE_URL=http://host:port`.
- **It's slow** — without `--fill` a decision is about 0.2–0.4 s plus CLI start-up (~0.7 s).
  If it takes several seconds, you probably passed `--fill`.
- **The first line is a command group or the wrong tool** — check the `also relevant` list;
  the right command is often there. `iris find "<words>"` shows the raw search results.
- **Arguments are the whole sentence** — for a request like "build a website for my coffee
  shop", the default fill uses your words as-is. Add `--fill` for a better query.

## Related
- `iris find "<words>"` — search every capability (commands, how-tos, playbooks, skills)
- `iris how-to view spreadsheets-excel-and-csv` and the other recipes — step-by-step guides
