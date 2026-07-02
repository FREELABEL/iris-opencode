---
name: agentic-loop
description: Loop engineering reference — run one self-prompting agentic-loop cycle (orchestrator → discover → plan → fan-out specialists → verify against goal → synthesize → write memory), then optionally wire the weekly schedule. Reproduces the Builder/Scout/Growth demo and generalizes to any goal.
version: 2
args:
  goal:
    type: string
    required: false
    default: "Grow a pickleball e-commerce store: ship a personality-quiz lead magnet, find ranked content opportunities, and produce a 48-hour growth plan."
    description: The loop's goal — set ONCE; the agents prompt themselves from here.
  bloq:
    type: number
    required: false
    description: Memory bloq id. When set, the cycle's next-steps are ingested into it for RAG recall on the next cycle.
  agent:
    type: number
    required: false
    description: Orchestrator agent id — required only for action=schedule, to wire the weekly cadence.
  action:
    type: string
    required: false
    default: run
    enum: [run, schedule]
    description: run = execute one loop cycle; schedule = also create the weekly schedule (needs --agent).
on-error: continue
timeout: 240
---

# Agentic Loop (loop engineering)

The canonical, runnable reference loop for `iris loop run`. It is the "fuel" the loop
engine runs: one cycle of the "set the goal once, the agents prompt themselves" pattern.

```
GOAL → DISCOVER/PLAN → EXECUTE (Builder · Scout · Growth) → VERIFY → SHIP/ITERATE
   + MEMORY (next-steps, outside the conversation)   + weekly SCHEDULE
```

**How the loop terminates (the VERDICT contract).** The final `step:verify` step ends its
output with exactly one line — `VERDICT: SHIP` when every goal condition is met, or
`VERDICT: ITERATE` otherwise. `iris loop run agentic-loop --until SHIP` re-runs this whole
playbook cycle after cycle, scans each cycle's step output for the last
`VERDICT: <token>` line (regex `/VERDICT:\s*([A-Za-z_-]+)/g`, last-match-wins,
token compared case-insensitively against `--until`), and stops the moment the verdict
equals the `--until` token (default `SHIP`) — or when `--max-cycles` is hit. So this
playbook is a genuine implement→verify loop: it converges when the verifier ships.
Point the engine at the verify step explicitly with `--verdict-step verify` if you extend
the playbook with other steps that might print the word.

Each specialist below is a `prompt` step you can later swap for a real agent fanned out
across the Hive — `iris hive run <node> "iris agents chat <specialistId> '…' --bloq <mem>"`
— for true parallel execution. See `iris how-to view agentic-loops`.

All AI steps use **gpt-4.1-nano** (cheap, closed-loop economics). Memory persists to a
local next-steps file (the video's "memory outside the conversation") and, if `--bloq` is
given, is ingested into that knowledge base for recall next cycle.

## Steps

### step:plan Orchestrator — discover & plan

```yaml
mode: prompt
model: gpt-4.1-nano
```

You are the ORCHESTRATOR of an autonomous agentic loop. The human set this goal ONCE:

GOAL: ${{args.goal}}

Read any prior memory if present at ./agentic-loop/next-steps.md (assume empty on cycle 1).
Decompose the goal into THREE concrete tasks, one for each specialist:
- BUILDER: one self-contained artifact to ship this cycle.
- SCOUT: a research target (find ranked, unacted opportunities).
- GROWTH: a distribution / activation action.

Output a tight numbered brief (one short paragraph per specialist). Keep it closed-loop:
bounded scope, a clear success check for each. No preamble.

### step:build Builder — one-shot the artifact

```yaml
mode: prompt
model: gpt-4.1-nano
depends: plan
```

You are the BUILDER specialist. Do exactly your task from the plan:

${{steps.plan.output}}

Produce ONE self-contained artifact (e.g. the spec + copy for a single-file HTML
personality quiz with an email capture before the result). Output the artifact itself,
ready to ship. No commentary.

### step:scout Scout — ranked opportunities

```yaml
mode: prompt
model: gpt-4.1-nano
depends: build
```

You are the SCOUT specialist. Do your task from the plan:

${{steps.plan.output}}

Research real content/market opportunities. Output a ranked top-5 list; for each, score
audience size, purchase intent, content gap (1-5 each) and a one-line why. LOOP CONDITION:
flag whether there are at least 3 FRESH, unacted ideas. End with: "FRESH_IDEAS: <n>".

### step:growth Growth — 48-hour activation + self-check

```yaml
mode: prompt
model: gpt-4.1-nano
depends: scout
```

You are the GROWTH specialist (a sharp marketing hire's first 48 hours). Using the
builder artifact and the scout's ranked list:

BUILDER: ${{steps.build.output}}
SCOUT: ${{steps.scout.output}}

Produce: (1) a site link-placement audit, (2) one launch email, (3) three platform-native
social captions, (4) the next lead-magnet recommendation. Then a DIMINISHING-RETURNS
SELF-CHECK: are these meaningfully different from a generic playbook? End with:
"NEXT_LEAD_MAGNET: <defined|undefined>".

### step:verify Verification — did we hit the goal? (emits the VERDICT the loop reads)

```yaml
mode: prompt
model: gpt-4.1-nano
depends: growth
```

You are the VERIFICATION agent. The loop's GOAL was:

${{args.goal}}

Evaluate the cycle's outputs against concrete loop conditions:
- Builder shipped a usable artifact?
- Scout surfaced 3+ fresh unacted ideas (see FRESH_IDEAS)?
- Growth defined the next lead magnet (see NEXT_LEAD_MAGNET)?

BUILDER: ${{steps.build.output}}
SCOUT: ${{steps.scout.output}}
GROWTH: ${{steps.growth.output}}

For each condition output MET or NOT MET with one-line evidence. Then a final line — this is
the token `iris loop run` reads to decide whether to stop or run another cycle:
"VERDICT: SHIP" if all met, else "VERDICT: ITERATE" plus the single most important gap to
close next cycle. Be strict — default to ITERATE if uncertain.

### step:synthesize Orchestrator — unified plan + next-steps

```yaml
mode: prompt
model: gpt-4.1-nano
depends: verify
```

You are the ORCHESTRATOR again. Synthesize the three specialists and the verifier into ONE
unified action plan for the human, then write the NEXT-STEPS for the following cycle.

VERIFY: ${{steps.verify.output}}
BUILDER: ${{steps.build.output}}
SCOUT: ${{steps.scout.output}}
GROWTH: ${{steps.growth.output}}

Output two sections:
1. "## This cycle" — the unified plan (what to ship/do now), 5 bullets max.
2. "## Next steps" — the carry-forward for next cycle (what's unacted, what to verify), so
   the loop knows where it left off. Be specific; this becomes the memory.

### step:write-memory Persist memory (+ ingest to bloq)

```yaml
mode: shell
depends: synthesize
```

```bash
set -e
mkdir -p ./agentic-loop
MEM="./agentic-loop/next-steps.md"
python3 - "$MEM" <<'PY'
import sys
mem = sys.argv[1]
entry = """\
## Cycle — goal: ${{args.goal}}

${{steps.synthesize.output}}

---
"""
with open(mem, "a") as f:
    f.write(entry)
print(f"Memory appended -> {mem}")
PY

BLOQ="${{args.bloq}}"
if [ -n "$BLOQ" ] && [ "$BLOQ" != "0" ] && [ "$BLOQ" != "null" ]; then
  echo "Ingesting memory into bloq $BLOQ for RAG recall next cycle…"
  iris bloqs ingest "$BLOQ" "$MEM" && echo "Ingested into bloq $BLOQ" || echo "(bloq ingest skipped — check the bloq id)"
else
  echo "No --bloq given; memory is the local file only. Pass --bloq <id> to make it RAG-recallable."
fi
```

### step:schedule Wire the weekly cadence

```yaml
mode: shell
if: ${{args.action}} == schedule
depends: synthesize
```

```bash
AGENT="${{args.agent}}"
if [ -n "$AGENT" ] && [ "$AGENT" != "0" ] && [ "$AGENT" != "null" ]; then
  echo "Creating weekly schedule for orchestrator agent $AGENT…"
  iris schedules create \
    --type code_workflow \
    --frequency weekly \
    --agent "$AGENT" \
    --name "Agentic Loop — weekly cycle" \
    --prompt "Run one agentic-loop cycle: read ./agentic-loop/next-steps.md, delegate to Builder/Scout/Growth, verify the goal, synthesize, and write next-steps." \
    && echo "Weekly schedule created." \
    || echo "Schedule create failed — see output above."
else
  echo "action=schedule needs --agent <orchestratorId>. To wire it yourself:"
  echo "  iris schedules create --type code_workflow --frequency weekly --agent <id> \\"
  echo "    --name 'Agentic Loop — weekly cycle' --prompt 'Run one agentic-loop cycle…'"
fi
```

### step:summary Cycle summary

```yaml
mode: shell
depends: synthesize
```

```bash
echo "============================================"
echo " AGENTIC LOOP — CYCLE COMPLETE"
echo "============================================"
echo " Goal:   ${{args.goal}}"
echo " Action: ${{args.action}}"
echo " Memory: ./agentic-loop/next-steps.md"
echo "--------------------------------------------"
echo "${{steps.verify.output}}" | grep -i "VERDICT" || echo " (verdict in the verify step output)"
echo "============================================"
echo " Loop it:  iris loop run agentic-loop --until SHIP --max-cycles 5"
echo " Re-run:   iris playbook run agentic-loop   (one cycle)"
echo " Weekly:   iris playbook run agentic-loop --action schedule --agent <id>"
```
