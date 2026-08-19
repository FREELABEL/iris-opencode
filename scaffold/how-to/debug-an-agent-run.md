# How to: See what an agent actually did (`-V` / `-VV`)

## What this does

Turns `iris chat` from a black box into a timeline. Instead of a spinner followed by a
paragraph, you get every iteration, every tool call **with its arguments**, every tool
result **with its status and size**, the model that made each decision, and every piece
of context that was injected before the model ever saw your question.

Nothing here is a new capability — `/api/v6/chat/stream` has always emitted these
events. Until now the CLI used them for one thing: the spinner label.

## The two levels

| Flag | Question it answers | What it prints |
|---|---|---|
| `-V` | *what did it do?* | one line per step — iterations, tool names, argument summaries, result status + size |
| `-VV` | *why did it do that?* | the same timeline with payloads: full tool arguments, full results, reasoning text, injected context |

```bash
iris chat -a 642 "How many leads do I have?" -V
iris agents chat 642 "How many leads do I have?" -VV
```

The trace goes to **stderr**, so redirecting still gives you a clean answer:

```bash
iris chat -a 642 "summarise today" -V > answer.txt    # trace on screen, answer in the file
```

Under `--json` it rides along as a `trace` key — present only when you passed `-V`, so a
consumer can tell "not traced" from "traced and nothing happened":

```bash
iris agents chat 642 "how many leads?" -V --json | jq '.trace[] | {type, label, detail}'
```

## Reading the timeline

```
  1.8s i0  context: rag_context        Retrieved 3 relevant documents from Document #BloqItem_158047…
  2.0s i1  thinking                    model=gpt-4o-mini tools_available=8
  3.7s i1  → SearchKnowledgeBaseTool   limit=3 query=current leads count
  4.5s i1  ← SearchKnowledgeBaseTool   success · 5 items
  6.8s i2  reasoning                   Direct response - no tools needed
```

- **`i0`, `i1`** — the ReactLoop iteration. `i0` is setup (context injection); real
  reasoning starts at `i1`.
- **`→`** a tool call, **`←`** its result.
- **`tools_available=8`** — how many tools the agent could see. If the tool you expected
  isn't in that count, the problem is the agent's allowlist, not the model.
- **`success · 5 items`** — status AND size. This pairing is the point: a tool that
  "succeeded" and returned nothing is the most common cause of a confidently wrong
  answer, and status alone hides it.

## The three failures this separates

These look identical from the outside — the agent gives a vague or wrong answer — and
have completely different fixes.

1. **The tool was never offered.** `tools_available` is low and no `→` line appears for
   it. Fix the agent's `config['tools']` allowlist, not the prompt.
2. **The tool ran and returned nothing.** A `←` line reads `success · empty` or
   `success · 0 items`. The data or the query is wrong; the model behaved correctly.
3. **The tool returned data and the model ignored it.** `-VV` shows a full result, and
   the answer contradicts it. Now it *is* a model or prompt problem — and only now.

Reaching for a bigger model before checking (1) and (2) is the standard wasted afternoon.

## Also useful

```bash
iris chat -a <id> "…" -V --no-rag        # is RAG helping or poisoning? compare traces
iris chat -a <id> "…" -V -m gpt-5-nano   # same question, different model, same timeline
iris chat -a <id> "…" -V --max-iterations 3
```

Comparing two traces of the same question is usually faster than reading either one.

## Related

- `agentic-loops.md` — running the loop rather than watching one turn
- `iris usage report --by=model` — what the runs cost, after the fact
