# How to: Drive IRIS from Claude Code (bring-your-own orchestrator)

## What this does

Lets an **external agent** — Claude Code today, or Codex / OpenClaw / a custom agent /
even a human at first — act as the orchestrator that drives IRIS as an **execution
substrate**. IRIS does not ship its own orchestrator. You bring yours. IRIS provides the
agents, knowledge bases, parallel compute (Hive), schedules, and memory; the orchestrator
owns the goal, delegates, reads results, and decides what's next.

This is the model behind the agentic loop (see `agentic-loops.md`). This recipe is the
**contract**: how the orchestrator learns what IRIS can do and calls it reliably.

## The contract (how the orchestrator learns IRIS)

The orchestrator discovers and drives IRIS through four surfaces. Treat them as the API:

| Surface | What it gives the orchestrator |
|---|---|
| `iris guide` | 11 categorized topic maps (crm, atlas, knowledge, pages, agents, integrations, finance, compute, system, …) |
| `iris how-to <recipe>` | step-by-step recipes in `~/.iris/how-to/` — the CLI system prompt reads these FIRST |
| `<command> --help` | the per-command flag contract (yargs) |
| **MCP** (`iris mcp serve`) | the machine-readable tool surface an agent calls programmatically |

Rule: if a surface lies (advertises a flag/command that doesn't work), the orchestrator
drives blind. Prefer the recipes and verified `--help`; when in doubt, dry-run the
command before trusting its flags.

## Prerequisites

- IRIS CLI installed and authenticated (`iris-login` — see `iris-login.md`)
- Claude Code (or your orchestrator) installed and able to run shell commands
- Optional but recommended: the IRIS MCP server wired into your orchestrator (below)

## Two ways to drive IRIS

### A) Shell (works everywhere, today)

Your orchestrator just runs `iris …` commands and reads stdout. Add `--json` to any
list/get for structured output the orchestrator can parse:

```bash
$ iris agents list --json
$ iris bloqs get 540 --json
$ iris eval run 632          # returns a pass count the orchestrator can branch on
```

This is the lowest-friction path and the one to start with.

### B) MCP (machine-readable tool surface)

Expose IRIS as MCP tools so the orchestrator calls them as first-class tools:

```bash
$ iris mcp serve
```

Then register that MCP server with your orchestrator (for Claude Code, add it to the
MCP server config). The orchestrator now sees IRIS tools (leads, bloqs, pages, agents,
schedules, hive, memory, …) in its tool list.

> Known issue (#145946): some MCP tools connect but 401 on execution if the bridge token
> isn't present. The CLI reads `~/.iris/bridge-token` and retries on 401 — make sure that
> file exists (it's written during `iris-login`). If MCP execution 401s, fall back to the
> shell path (A) while it's being fixed.

## The substrate primitives the orchestrator composes

| You want to… | Command |
|---|---|
| Spin up a specialist agent | `iris agents create --name … --prompt …` |
| Talk to an agent (one stateless turn) | `iris agents chat <id> "…" --bloq <id>` |
| Give an agent project memory | `iris bloqs create` / `iris bloqs ingest` / chat with `--bloq` |
| Fan work out across machines (parallel) | `iris hive run <node> "<cmd>"` / `iris hive script` |
| Verify a goal was met | `iris eval run <agentId>` |
| Run on a cadence | `iris schedules create --type agent_task --frequency weekly --agent <id>` |
| Ingest a source (video → transcript) | `iris transcribe <url>` |
| Persist agent memory across runs | `iris memory store …` / `iris memory search …` |

## Worked example: the orchestrator runs one loop cycle

```bash
# 1. Orchestrator reads the goal + current memory
$ iris bloqs get 540 --json

# 2. Delegates to specialists (in parallel via Hive)
$ iris hive run <node> "iris agents chat <scoutId> 'find 8 ranked opportunities' --bloq 540"
$ iris hive run <node> "iris agents chat <builderId> 'build this run's artifact' --bloq 540"

# 3. Collects outputs, synthesizes a plan, writes next-steps back to memory
$ iris bloqs add-item 540 <list-id> "CYCLE 4 PLAN: …  NEXT_STEPS: …"

# 4. Verifies the goal conditions
$ iris eval run <orchestratorAgentId>     # 7/7 → ship; else → iterate

# 5. Schedules the next cycle (or lets an existing weekly schedule re-fire)
$ iris schedules create --type agent_task --frequency weekly --agent <orchestratorAgentId> \
    --name "Growth Loop" --prompt "Run one loop cycle: read memory 540, delegate, synthesize, verify."
```

The orchestrator (Claude Code) is doing the delegation + synthesis that IRIS does not yet
do natively (see `agentic-loops.md` → "What is not first-class yet").

## Reliability notes for orchestrator authors

- **Reuse the agent path, don't reinvent it.** Agent chat goes through the V6 ReactLoop
  stream; `iris agents chat` and `iris chat` are the faithful path. Don't hand-roll calls
  to old `/api/chat/start` endpoints — they're dead.
- **Disable RAG when you want the model's own answer:** `iris agents chat <id> "…" --no-rag`
  (fixed June 2026 — the bare flag now parses and actually suppresses bloq injection).
- **Memory is per-call today.** Pass `--bloq <id>` on every chat; don't rely on a
  persistently-attached KB yet (#146918).
- **Confirm scheduled runs actually fired:** `iris schedules history <id>` — don't trust a
  "triggered" message alone (#146511).
- **Prefer `--json` everywhere** so the orchestrator parses structure, not prose.

## GTM note (why subsidize the orchestrator)

The orchestrator layer (a Claude Code subscription) is the on-ramp cost for a new user.
The activation play is to subsidize ~$20 toward it and tie activation to running one real
loop on IRIS. IRIS stays interface-agnostic — users bring/compare orchestrators against
the same substrate; IRIS wins as the neutral execution layer.

## Related recipes

- `agentic-loops.md` — the loop pattern this orchestrator drives
- `hive-dispatch.md` — connect machines for the parallel execute step
- `iris-login.md` — auth + where the bridge token lives
- `pulse.md` — scheduled autonomous runs
