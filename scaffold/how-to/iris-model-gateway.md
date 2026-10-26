---
category: Agents & Automation
level: intermediate
tags: [models, gateway, openrouter, failover, usage, spend, ollama, gpu, hive, local-models]
duration_min: 8
prerequisites: [iris-login]
---
# How to: Use the IRIS model gateway, including models on your own machines

## What this does

Every model call IRIS makes goes through one **OpenAI-compatible gateway**: the CLI, Desktop,
agents, and your own code via `https://freelabel.net/api/v6/openai`. It does what a router
like OpenRouter does:

- **One endpoint, many providers.** Pick `iris/<model>`; the gateway knows which provider serves it.
- **Failover.** If a provider fails before answering, the request moves to the next route
  (up to 3 hops) with one shared time budget, so a slow chain cannot hang forever.
- **Spend tracking and caps.** Every call is metered and priced, and `iris usage` shows the
  bill. A spending cap refuses with a message that says it is *your IRIS cap*, not the provider.

And one thing a router does not: **models on your own machines.** If a machine in your Hive
runs Ollama, vLLM, llama-server or LM Studio, `hive/<model>` sends the request to that
machine. It is free (your hardware), and it streams.

## Prerequisites

- `iris auth login`
- For your own models: a Hive machine (`iris hive nodes list`) with a local model server and at
  least one model pulled (for example `ollama pull qwen3:14b`)

## Steps

**1. See your spend**

```bash
iris usage            # last 30 days: calls, tokens, cost
iris usage --days 7
```

**2. See what your machines can serve**

```bash
iris hive models
```

```
  ○ hive/phi4                          iris-hive-001          not served (iris hive models serve on)
  ○ hive/qwen3:14b                     iris-hive-001          not served (iris hive models serve on)
```

Machines report their models on every heartbeat, so a model you pull shows up within a minute.

**3. Turn serving on (on the machine with the models)**

```bash
iris hive models serve on
```

This does two things:
- Switches on a small endpoint in the Hive daemon on this machine (`~/.iris/inference.json`).
- Opens a Hive relay tunnel to it (`https://<machine>-ai.t.heyiris.io`).

The URL is public, but the endpoint answers **only** requests IRIS signed for *your* account,
for one model, once. Nobody else's requests reach your machine. Options:

```bash
iris hive models serve on --models qwen3:14b,phi4   # only these
iris hive models serve on --max-concurrent 1        # one at a time (a laptop)
iris hive models serve off                          # stop; the gateway stops routing here within a minute
```

**4. Use one**

```bash
iris run -m iris/hive/qwen3:14b "summarise this repo"
```

Or from your own code, with any OpenAI client:

```bash
curl https://freelabel.net/api/v6/openai/chat/completions \
  -H "Authorization: Bearer $IRIS_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"hive/qwen3:14b","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

If more than one of your machines serves the model, the gateway tries the most recently heard
from first, and fails over to the next one if it is busy or asleep.

## Verify

- `iris hive models` shows `● hive/<model> … serving`.
- The `curl` above streams tokens.
- `iris usage` shows the calls at $0.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `hive models` lists nothing | No local model server is answering on that machine | Start it (`ollama serve`) and pull a model |
| "not served" | Serving is off on that machine | `iris hive models serve on` there |
| "no tunnel URL yet" | The tunnel did not open | Run `serve on` again and read the error; the first certificate takes ~30 s |
| "report is stale" / "machine offline" | The machine is asleep, or its daemon is down | Wake it; `iris hive doctor` |
| 429 "your machine is busy" | It is already running `max_concurrent` requests | Wait, or raise `--max-concurrent` |
| 401 from your machine | Its daemon predates serving, or its node key changed | Update the Hive daemon on it |
| Very slow answers | A large model on a CPU | Use a smaller model (e.g. 7-8B), or a machine with a GPU |

## What this is not (yet)

- **Sharing your machines with other people.** Coming in a later phase: whoever runs the machine
  can read the prompts, so it will always be opt-in, on both sides.
- **Patient data.** Routing PHI to a `hive/` model is off until your workspace records that
  your own machines may receive it.

## Related

- [Rent a machine and run your code on it](hive-rent-compute.md)
- [Run Claude Code, Codex or Gemini from IRIS](run-other-coding-agents.md)
