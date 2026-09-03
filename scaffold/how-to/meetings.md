---
category: Content & Media
level: beginner
tags: [meetings, transcription, intel]
duration_min: 8
---
# How to: Turn a recorded meeting into filed intel

## What this does

Takes a call you already recorded with **Wispr Flow** and files a structured summary —
decisions, action items with owners, open questions, notable quotes — into a client's
bloq, under a `Meetings` list that is created automatically the first time.

The point is that nobody has to decide where a meeting goes. Every client project
accumulates its calls in the same place, in the same shape, without anyone remembering a
convention.

## Prerequisites

- Wispr Flow installed and having recorded at least one meeting
- `iris auth login` completed
- A bloq to file into (`iris bloqs list` to find its id)

Transcripts live at `~/Library/Application Support/Wispr Flow/meetings/<uuid>/refined.ndjson`.
You never need that path — `iris meetings` reads it for you.

## Steps

**1. See what you've recorded**

```
$ iris meetings
```

Lists recent sessions, newest first: short id, when, duration, segment count, and the
opening line so you can tell calls apart.

**2. File one into a bloq**

```
$ iris meetings 8ba439fd --bloq 570
```

The id can be just the first few characters. This summarises the transcript, finds or
creates a `Meetings` list on bloq 570, and files the result with the full transcript
folded into a collapsible block underneath.

**3. Label the speakers (recommended)**

Diarisation gives numeric ids, not names, and it routinely splits one person across two
ids. Label them once you know who's who:

```
$ iris meetings 8ba439fd --bloq 570 --speaker 1=Clayton --speaker 2=Arthur
```

Unlabelled speakers appear as `Speaker 2`. That is deliberate — see the warning below.

## Useful variants

```
$ iris meetings 8ba439fd --export call.txt      # just the transcript, no AI, no filing
$ iris meetings 8ba439fd --bloq 570 --raw       # file it verbatim, skip the summary
$ iris meetings 8ba439fd --list "Client Calls"  # a list name other than Meetings
$ iris meetings 8ba439fd --title "Kickoff"      # override the generated title
$ iris meetings --limit 30 --json               # machine-readable session list
```

## Expected output

```
◈  Wispr Flow Meetings
  Session:   8ba439fd-b253-4f2a-809f-e9c3034cf258
  Recorded:  2026-08-06 16:04
  Segments:  222 · 56:47
Extracting summary, decisions and action items…
Extracted
  Filed:  bloq 570 → "Meetings" list (item #179213)
Done
```

The filed item contains **Summary · Decisions · Action Items · Open Questions · Notable
Quotes**, then the full transcript in a `<details>` block.

## ⚠️ Wispr records SYSTEM audio — your own mic may be missing

This is the single most important thing to know. A Wispr meeting file contains what you
**heard**, not what you **said**. Your microphone is a separate track and is often absent
entirely.

Verified on a real 56-minute client call: the local speaker was completely uncaptured, so
the transcript read as one long list of questions with no answers. **Anything you
committed to on that call was not in the file.**

Every export carries a header saying so, and the extraction prompt is told to flag
one-sidedness rather than infer the missing half. But when you read the summary, check
whether your own commitments are represented — if they matter, add them by hand.

## Why speakers are numbers, not names

The tool will not guess. Diarisation is unreliable enough that a confident wrong name
silently mis-attributes a decision or an action item to the wrong person, which is worse
than an unlabelled `Speaker 2`. Use `--speaker` when you know; leave it when you don't.

## Common errors

| What you see | Why | Fix |
|---|---|---|
| `No Wispr Flow meetings directory at …` | Wispr not installed, or never recorded | Record a meeting first |
| `No meeting matching "abc"` | Wrong id, or the session has no `refined.ndjson` yet | `iris meetings` to list; Wispr writes `refined` after processing |
| `"8b" matches 3 meetings` | Prefix too short | Use more characters |
| `Extraction failed — filing the raw transcript instead` | The extraction agent errored or timed out | Not fatal by design: the transcript is still filed. Retry with `-a <agentId>` or `--timeout 600` |
| `Could not find or create a "Meetings" list` | Wrong bloq id, or no write access | Check with `iris bloqs get <id>` |

## Also: lead intel from the same transcript

`iris leads:meeting <leadId> <file>` extracts intel against a **lead** rather than a bloq,
and can create tasks:

```
$ iris meetings 8ba439fd --export /tmp/call.txt
$ iris leads:meeting 29016 /tmp/call.txt --create-tasks
```

Use `--dry-run` first to see what it would write.

## Related recipes

- `diary.md` — logging what you did, day by day
- `bloq-relations.md` — linking a client bloq to its parent project
- `atlas-datasets.md` — if you want meeting data as queryable records rather than notes
