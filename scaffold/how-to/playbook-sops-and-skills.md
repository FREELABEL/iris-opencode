---
category: Playbooks & Automation
level: intermediate
tags: [playbooks, sop, skills, atlas, documentation]
duration_min: 10
prerequisites: []
---
# How to: Hold Human SOPs + Agent Skills in one Playbook

## What this does

A playbook is not just a list of steps an agent runs. It is a **container** that holds two different kinds of thing for the same job:

- **Human SOPs** — the written procedure a person reads and follows, stored as an Atlas item
- **Agent Skills** — runnable capabilities an agent executes

Both live in one playbook, so "here is how we do this" and "here is the thing that does it" stop being two systems somebody has to keep in sync by hand. A new hire reads the SOPs; the agent runs the skills; the org chart says who owns which.

This capability has shipped for a while and went almost entirely unused, because nothing in the command names said it existed. If you have ever wondered where the human half of a procedure is supposed to live — this is it.

## The key idea: SOPs attach BY REFERENCE

The SOP lives in exactly one place — an Atlas item — and the playbook points at it by id. Nothing is copied.

That matters more than it sounds. Edit the Atlas item and **every playbook carrying it updates**, because they all point at the same record. There is no second copy to go stale, and no moment where the doc a person reads and the doc someone edited are different documents.

## Steps

### 1. Draft the SOP from a real walkthrough

Do not hand-write this from memory if a recording or transcript exists.

```bash
iris playbook sop ./walkthrough.md        # or an audio file
iris sop draft ./walkthrough.md           # equivalent entry point
```

Both produce a human-readable procedure: ordered steps, decision points, inputs and outputs, and the role that normally runs it.

**A raw meeting transcript or meeting note is not an SOP.** It is source material — chronological, full of asides, organised around *when things were said* rather than *what someone has to do*. The SOP is derived from it. Keep the original; it is the evidence the SOP is faithful.

### 2. Publish the SOP as an Atlas item

```bash
iris atlas:item publish ./intake-sop.md
iris boards create --bloq-id <bloq> --title "Intake approval SOP"   # or into a project board
```

Note the item id it returns — that is what you attach.

### 3. Attach it to the playbook

```bash
iris playbook items add <playbook> \
  --label "Intake approval SOP" \
  --bloq-item 182265
```

`--label` is what a person sees. `--bloq-item` is the Atlas item id holding the text.

### 4. Attach the runnable skills alongside it

```bash
iris playbook items add <playbook> --label "Score a case" --skill 41
```

### 5. Say who owns what

```bash
iris playbook roles add <playbook> --title "Intake coordinator"
iris playbook roles add <playbook> --title "Clinical reviewer" --reports-to 1
iris playbook items add <playbook> --label "Approve or reject" --bloq-item 900 --role 2
```

Omit `--role` and the item belongs to everyone.

### 6. Check what the playbook now holds

```bash
iris playbook items list <playbook>
iris playbook roles list <playbook>
```

The public playbook page renders both, so anyone who installs it sees the procedures and the org chart, not just the step list.

## Worked example

```bash
# a process map + extracted rules, already published as Atlas item 182265
iris playbook items add capture-sops-and-process-maps \
  --label "Pathways intake — process map + 9 extracted rules" \
  --bloq-item 182265

iris playbook items list capture-sops-and-process-maps
# ▸ Pathways intake — process map + 9 extracted rules  #10
```

## Gotchas

- **Attaching or removing an item bumps the playbook version.** That is deliberate: it expires acknowledgements, so anyone who agreed to the old version must read the new one. A guarantee that never expires is not a guarantee.
- **`--label` is required.** It is what a person sees in the UI; the Atlas item's own title is not used.
- **Removing an item does not delete the Atlas item** — it only detaches it. The SOP survives and stays attachable elsewhere.
- **A playbook with no items still works.** Items are the human/skills layer on top; a playbook with only steps runs fine, it just cannot teach anyone the job.

## Related

- `iris playbook sop <input>` — draft a human SOP from a walkthrough
- `iris playbook items --help` — the full container surface
- The `capture-sops-and-process-maps` playbook — how to split genuine RULES out of a procedure before writing it up (a "never do X because…" with a scope and a reason is not a step, and filing it as one loses the part that matters)
- The `live-meeting-to-build-pipeline` playbook — step 7 covers this in the context of a full meeting-to-shipped-work pass
