# How to: Build an agentic loop on IRIS (loop engineering)

## What this does

Builds a **self-running loop** where you set a goal once and IRIS agents discover →
plan → execute (in parallel) → verify → ship → decide what's next, on a schedule,
with memory that persists between cycles. This is "loop engineering": the human sets
the goal once; the agents prompt themselves. It is domain-agnostic — the same shape
drives a store-growth loop, a weekly research briefing, a content pipeline, or a
client-status loop.

This recipe is the IRIS realization of the orchestrator + specialists pattern. IRIS is
the **execution substrate** (agents, knowledge, parallel compute, schedules, memory).
The orchestrator that owns the goal can be a human at first, then an external agent
(see `drive-iris-from-claude-code.md`).

## The loop anatomy

```
GOAL  (human sets once)
  → DISCOVERY   agents find what needs doing
  → PLAN        break it into clear steps
  → EXECUTE     fan out N specialist agents, each does one thing (parallel)
  → VERIFY      a checker asks: did this hit the goal?
        yes → SHIP → "what next?" → iterate
        no  → iterate
  + MEMORY      lives OUTSIDE the conversation; tracks done / remaining
```

**Open vs closed loops (token economics — the key design lever):**

- **Open loop** — broad mandate ("find what we should do and do it"). Discovers novel
  directions but burns tokens and can wander. Only sane with a big budget.
- **Closed loop (recommended)** — bounded goal, known path, a clear check at each step,
  a constrained budget. Predictable cost. Start here.

## The IRIS mapping (concept → command)

| Loop concept | IRIS primitive |
|---|---|
| Goal (set once) | `agent.initial_prompt` (the `<agent_mission>`) / playbook args |
| Orchestrator | a human, an external agent (Claude Code), or an `iris playbook` |
| Specialist sub-agents | `iris agents create` (one per role) |
| Parallel execute (spin N) | `iris hive run` / `iris hive script` (distributed nodes) |
| Memory / next-steps file | `iris bloqs` (RAG KB) + `iris memory` (agent memory) |
| Verify the goal | `iris eval run <agentId>` |
| Weekly cadence | `iris schedules create --frequency weekly` |
| The loop body / synthesis | `iris playbook` or `iris schedules create --type code_workflow` |
| Source ingest (YouTube, etc.) | `iris transcribe <url>` |

The parts all exist. The honest caveats are in **"What is not first-class yet"** below —
read it before you promise a fully autonomous loop.

## Prerequisites

- IRIS CLI installed and authenticated (`iris-login` complete — see `iris-login.md`)
- For parallel execution: a Hive node online (`iris hive nodes list` shows green — see
  `hive-dispatch.md`)

## Step 1: Create the memory bloq (the next-steps file)

Memory lives outside the conversation so each cycle knows what's done and what's left.

```bash
$ iris bloqs create --name "Pickleball Growth — Loop Memory"
# → note the bloq id, e.g. 540
$ iris bloqs add-item 540 <list-id> "CYCLE LOG: (empty — first run)"
```

Seed any source material here too — e.g. transcribe a reference video and ingest it:

```bash
$ iris transcribe "https://www.youtube.com/watch?v=Ry3YyG22EUc" --json > blueprint.json
$ iris bloqs ingest 540 blueprint.json
```

## Step 2: Create the specialist agents (one per role)

Give each agent ONE job and a narrow mission. Example trio (a store-growth loop):

```bash
# Builder — one-shots a self-contained artifact
$ iris agents create --name "Builder" --type content \
    --prompt "You build one self-contained HTML artifact per run (a quiz, a landing page). Output only the file."

# Scout — researches ranked opportunities, writes them to memory
$ iris agents create --name "Scout" --type content \
    --prompt "Research real content opportunities (Reddit, trends, competitors). Score each on audience size, purchase intent, content gap. Output a ranked top-8 list. Run until there are 3+ fresh, unacted ideas."

# Growth — a marketing hire's first 48h, with a diminishing-returns self-check
$ iris agents create --name "Growth" --type content \
    --prompt "Do a marketing first-48h: link-placement audit, launch email, 3 platform-native captions, next lead-magnet rec. Self-check for repetition vs prior cycles."
```

> Known issue (#146506): `--model` / `--system-prompt` / `--heartbeat-tools` may not
> persist on `create`. The reliable path is `create → iris agents pull <id> → edit
> settings.{model,system_prompt} → iris agents push <id>`. See `drive-iris-from-claude-code.md`.

Attach the memory bloq per call with `--bloq 540` when you chat (see Step 4).

## Step 3: Run specialists in parallel (the EXECUTE step)

Fan the specialists out across Hive nodes so they run concurrently, not in series:

```bash
$ iris hive run <node> "iris agents chat <builderId> 'Build this run's artifact' --bloq 540"
$ iris hive run <node> "iris agents chat <scoutId> 'Find 8 ranked opportunities' --bloq 540"
$ iris hive run <node> "iris agents chat <growthId> 'Do the 48h growth pass' --bloq 540"
```

Single-machine? Run them as background jobs and join, or run sequentially — the loop
logic is identical, only the wall-clock changes.

## Step 4: Verify against the goal (the VERIFY step)

Define the loop's exit conditions as eval-style checks and run them. The verify step is
what makes the loop a loop instead of a one-shot.

```bash
$ iris eval run <orchestratorAgentId>
# 7/7 → goal conditions met → SHIP. Anything less → iterate.
```

Loop conditions are concrete and checkable, e.g.: *are there 3+ unacted content ideas?
is the site linked to the quiz? is the next lead magnet defined?* If unmet → keep going.

## Step 5: Synthesize + schedule the loop (the cadence)

The orchestrator reads memory, collects the three specialists' outputs, synthesizes one
unified plan, writes next-steps back to memory, and the schedule re-triggers the whole
cycle weekly.

```bash
$ iris schedules create --type agent_task --frequency weekly \
    --agent <orchestratorAgentId> --name "Pickleball Growth Loop" \
    --prompt "Read bloq 540 memory. Collect Builder/Scout/Growth outputs. Synthesize one weekly action plan. Write next_steps back to memory. Verify the loop conditions; if unmet, queue another cycle."
```

For a scripted loop body (explicit fan-out + synthesis in code), use a code workflow
instead of a single agent prompt:

```bash
$ iris schedules create --type code_workflow --frequency weekly \
    --agent <orchestratorAgentId> --name "Pickleball Growth Loop (scripted)"
```

## Four ready-made loop shapes (the pattern is domain-agnostic)

1. **Freelancer** — every Fri 4pm: read project folders, load per-client memory, draft
   personalized status updates to a review folder (human QA), log what was sent. *Loop:
   did every active client get an update?*
2. **Researcher** — every Sun overnight: fetch the 5 biggest weekly developments in a
   field, score by relevance, drop below-threshold, write a plain-English briefing,
   dedupe vs the last 3 weeks. *Loop: 2+ genuinely new developments?*
3. **Shop owner** — monthly on the 1st: read sales data, find 3 high-traffic/low-
   conversion SKUs, rewrite their descriptions, write promo copy for the top 3, log every
   change + reason.
4. **Creator** — every Mon AM: read the ideas list, pull last-90-day performance, find
   over/under-performers, check trends, rank ideas, output top-5 + flag ones competitors
   already covered. *(Caveat from the source: AI is unreliable at predicting which topics
   will perform — keep a human in this judgment.)*

## Just run the loop (the fast path)

You don't have to wire Steps 1-5 by hand. Two commands give you the whole loop:

```bash
# Burst: run the reference loop, iterating until the verifier says SHIP (bounded budget)
$ iris loop run agentic-loop --until SHIP --max-cycles 5

# Autonomous: tie it to a heartbeat — one cycle per firing, memory kept in a bloq
$ iris loop schedule agentic-loop --agent <id> --frequency weekly --bloq <memId>
```

`iris loop run` re-runs the `agentic-loop` playbook, reads the `VERDICT: SHIP|ITERATE`
line from its verify step, and stops on SHIP or when `--max-cycles` is hit. `iris loop
schedule` registers the recurring version where the cadence is the outer loop. Author
your own loopable playbook by emitting a `VERDICT:` line from a verify step (see
`iris playbook show agentic-loop`).

## Native agent→agent delegation (G1)

An agent can now hand a sub-task to ANOTHER of your agents in-engine — no playbook or
external orchestrator needed. Enable it on the orchestrator agent and name its specialists:

```bash
# turn on delegation for the orchestrator agent
$ iris agents pull <orchestratorId>
#   → edit settings.include_delegation = true, then:
$ iris agents push <orchestratorId>
```

Then the orchestrator's prompt can say *"delegate research to your **Scout** agent and
drafting to your **Builder** agent, then synthesize."* The model calls the
`delegate_to_agent` tool ({agent_name|agent_id, message}); the platform runs that agent
and returns its answer. Guards: same-user scoping, no self-delegation, and a depth cap
(orchestrator → A → B; B can't delegate further). This is what `iris loop schedule` uses
for the recurring single-orchestrator loop.

## What is not first-class yet (be honest — don't promise these)

The substrate is now solid end-to-end. The remaining sharp edge:

- **Closed-loop *token* budget (G3, partial)** — `iris loop --max-cycles` bounds a run by
  cycles and `delegate_to_agent` is depth-capped, but a finer per-loop *token* ceiling /
  kill-on-spend isn't surfaced yet. Keep loops closed and bounded.

Fixed June 2026 (no longer caveats): native delegation via `delegate_to_agent` (G1);
verify→iterate is first-class via `iris loop` (G2); persistent memory attach works
(`iris agents update --bloq`); heartbeat execution flows; multi-bloq RAG retrieves
per-bloq; `iris eval`, `iris transcribe`, `iris monitor`, and `--no-rag` all work.

`iris transcribe` (ingest), `iris eval` (verify), and `--no-rag` were fixed June 2026 and
work in current builds.

## Related recipes

- `drive-iris-from-claude-code.md` — the orchestrator's manual (BYO orchestrator)
- `hive-dispatch.md` — connect a machine + run the parallel EXECUTE step
- `pulse.md` — scheduled autonomous agent runs (the cadence engine)
- `atlas-datasets.md` — structured memory if a bloq isn't the right shape
