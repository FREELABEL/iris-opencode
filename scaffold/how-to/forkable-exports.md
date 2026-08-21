# How to: Export an agent or workflow as a folder you can fork

## What this does

Takes an agent or workflow out of IRIS and writes it to disk as **files a person can read,
diff, review and PR** — instead of a row in a database only IRIS can see.

```sh
iris agents export 701                              # → agents/<slug>/
iris workflows export 196 --format claude-workflow  # → .claude/workflows/<slug>.js
```

Use it to hand an agent to a teammate, review a prompt change in a pull request, publish a
skill publicly, or run an IRIS workflow inside Claude Code.

## Exporting an agent

```sh
iris agents export <id> [--out ./agents]
```

Produces four files:

| file | what it is |
| --- | --- |
| `agent.md` | The one you edit. Frontmatter carries name, model, heartbeat and tools; the body is the system prompt. |
| `tools.json` | The tool allowlist, resolved from all five places IRIS stores it and deduped. |
| `agent.json` | Portable fields only, machine-readable, for re-import. |
| `README.md` | What it is, how to import it, and every field the export deliberately dropped. |

### Why most of the record does not travel

An agent row has 72 fields and most of them describe *the install it came from*, not the
agent — `user_id`, `bloq_id`, `stripe_product_id`, `total_revenue_cents`, `clone_count`,
health, `google_workspace_*`. Copying those into a new tenant is meaningless at best and at
worst points the clone at someone else's records.

So the export keeps 7–8 portable fields and drops ~60. **The README lists every drop and why**,
grouped by reason. Anything IRIS adds later that is in neither list is reported as
`unclassified` at export time, so a new column shows up as a question instead of vanishing.

### Read it before you publish it

The exporter scans for credential-shaped values — API keys, bearer tokens, emails, private
key blocks, long opaque strings — and tells you what it found. It **warns rather than blocks**,
because a check people learn to skip is worse than no check.

That scan does not read English. A system prompt is written for one company and routinely
names clients, pricing, and internal process. Open `agent.md` before the folder goes anywhere
public.

## Exporting a workflow

```sh
iris workflows export <id> --format claude-workflow [--out ./.claude/workflows]
```

Each IRIS step becomes a `phase()` plus an `agent()` call, in `order`, threading the previous
step's result into the next. A stepless agentic workflow becomes one labelled `agent()` call.

### It is a transliteration, not an equivalence

The generated file says so in its own header, and names what did not survive:

- **`allowed_tools`** — an IRIS step runs against an allowlist. A Claude Code `agent()` gets
  whatever its own harness gives it. The file lists the tools the original was scoped to and
  leaves honouring them to you.
- **`require_human_approval`** — no counterpart. Approvals are durable and audited in IRIS;
  `/workflows` is ephemeral and session-scoped.
- **`max_iterations`** — no equivalent ceiling.
- **`script_content`** — emitted as a comment, never wrapped in `agent()`. Pretending a shell
  payload is a prompt would give you a file that runs and does the wrong thing.

Read that header before trusting the file. If those four things matter to the workflow, run it
in IRIS and use the export for review, not for execution.

## Round-tripping back into IRIS

```sh
iris agents push <new-id> --file agent.json
```

`export` is the distribution-shaped sibling of `agents pull`. Use `pull`/`push`/`diff` to sync
an agent against the same install; use `export` when it is leaving.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Export agent failed: HTTP 404` | Wrong id, or the agent belongs to another user | `iris agents list` and check the id |
| Folder written but `agent.md` prompt is empty | The agent stores its prompt in `settings` rather than `config` | Expected — check `agent.json`; both locations are read |
| `Credential-shaped values found` | The prompt or settings contain something key-shaped | Open `agent.md`, confirm, and remove before publishing |
| `workflows export` reports `Steps: 0` | The workflow is agentic with no steps | Normal — it exports as a single `agent()` call from the description |

## See also

- `drive-iris-from-claude-code.md` — using Claude Code as a runtime against IRIS
- `iris agents export --help` / `iris workflows export --help`
