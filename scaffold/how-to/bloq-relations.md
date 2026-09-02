---
category: Data & Atlas
level: intermediate
tags: [bloqs, relations, graph]
duration_min: 10
---
# Link bloqs together — relations, filtering, and the graph view

IRIS lets you connect bloqs (projects/knowledge bases) to each other with **typed
relations** — e.g. a "MAYO — Life Atlas" bloq with child bloqs for Health, Legal,
Vehicles. You can create, remove, list, and filter these from the CLI, and see them
visualized in the graph view on the web.

Requires `iris` **v1.3.121+** (`iris --version`; run `iris update` if older).

## The six relation types

| Type | Meaning | Directional? |
|---|---|---|
| `parent` | The `from` bloq is the parent of the `to` bloq | one-way |
| `feeds_into` | The `from` bloq feeds into the `to` bloq (a flow) | one-way |
| `sibling` | The two bloqs are peers at the same level | two-way |
| `affiliated` | Loosely associated | two-way |
| `partner` | A strong two-way relationship | two-way |
| `mirrors` | The two bloqs mirror each other | two-way |

**Two-way (symmetric) types auto-create the reciprocal link** — relate A→B as
`sibling` and B already shows A as a sibling too. **One-way (directional) types**
create a single edge in the stated direction. You only need **write access to the
`from` bloq** to create or remove a relation.

## Create a link

```bash
iris bloqs relate <from-id> <to-id> --type=<type>
```

Examples:
```bash
iris bloqs relate 544 400 --type=parent       # bloq 544 is the parent of bloq 400
iris bloqs relate 546 547 --type=sibling      # 546 and 547 are peers (both directions)
iris bloqs relate 170 364 --type=feeds_into   # 170 feeds into 364 (one-way)
```

Relating the same pair + type twice is a safe no-op (idempotent).

## List / view relations

```bash
iris bloqs relations <id>                      # all relations, grouped by type (tree output)
iris bloqs relations <id> --type=sibling       # only sibling links
iris bloqs relations <id> --direction=from     # only links this bloq points OUT from
iris bloqs relations <id> --direction=to       # only links pointing IN to this bloq
iris bloqs relations <id> --json               # machine-readable (for scripting)
```

`--direction` is `from` | `to` | `both` (default `both`). Grouped output looks like:

```
Relations for Bloq #544:
parent
  └─ → Becoming a Better Me
sibling
  ├─ ↔ Health & Wellbeing
  └─ ↔ Legal & Court
```

The arrow shows direction: `→` this bloq points out, `←` points in, `↔` two-way.
A symmetric relation lists **once**, not twice.

## Remove a link

```bash
iris bloqs unrelate <from-id> <to-id> --type=<type>
```

For two-way types this removes both sides. Example:
```bash
iris bloqs unrelate 546 547 --type=sibling
```

## See it visualized (web)

1. Open the bloq's board at `web.freelabel.net` (or your IRIS host).
2. Switch the view mode (top-right dropdown) to **Graph**.
3. Related bloqs appear as indigo nodes; each relation type has its own edge color
   and dash style (sibling/mirrors are dashed). Hover a node for details, drag to
   rearrange, scroll to zoom.
4. Use the **+ Link** button in the graph header to create a relation from the UI —
   pick a type (with an animated preview of the pattern) and search for the target
   bloq. No terminal needed.
5. The header filter chips let you toggle node types on/off; only types actually
   present in this bloq's graph are shown.

## Tips

- Find bloq IDs with `iris bloqs list` (or `iris bloqs search <query>`).
- `--json` on any of these is stable output for scripts/agents.
- Set `IRIS_USER_ID` (or pass `--user-id`) if acting on behalf of a specific user.
- Relations are bloq-to-bloq only. Linking leads/items/agents across bloqs is a
  separate (planned) capability, not these commands.

---

# Relating ITEMS — the same idea, one level down

Everything above connects whole **bloqs**. Since v1.3.232 the same thing works between
individual **items** — an epic can point at its tickets, a bug can say what it blocks.

```bash
iris boards relate <from-id> <to-id> --type=<type>
iris boards relations <id>
iris boards unrelate <from-id> <to-id> --type=<type>
```

## Item relation types

| Type | Reads from the other end | Directional? |
|---|---|---|
| `parent` | child of | one-way |
| `blocks` | blocked by | one-way |
| `duplicates` | duplicated by | one-way |
| `feeds_into` | fed by | one-way |
| `sibling` | sibling | two-way |
| `relates_to` | relates to | two-way |

`parent`, `feeds_into` and `sibling` mean exactly what they mean between bloqs.
`blocks`, `duplicates` and `relates_to` are the ones tickets need and whole projects
do not.

**Two-way types write the reciprocal row**, same as bloqs — relate A→B as `sibling`
and B already lists A. **One-way types write a single row**, and the far end reads it
with its inverse label: if 183180 `blocks` 183179, then `iris boards relations 183179`
shows 183180 under **blocked by**. The edge is stored once and never silently inverted.

Re-relating the same pair and type is a safe no-op. An item cannot relate to itself.

## Examples

```bash
# an epic and its tickets
iris boards relate 182398 183178 --type=parent
iris boards relate 182398 183179 --type=parent

# a blocker
iris boards relate 183180 183179 --type=blocks

# two tickets that keep coming up together
iris boards relate 183178 183181 --type=sibling
```

```bash
iris boards relations 183179
#   blocked by
#     ⚖️ LOP name-match — decide how far it can go   #183180 · active
#   child of
#     🎯 EPIC — Intake Risk-Score Engine             #182398 · active
```

## Linking a CRM lead to an item

Separate from item↔item edges: an item can also point at a **person** in the CRM —
who reported it, who it is about.

```bash
iris boards link-lead <item-id> <lead-id> --relation reported-by
iris boards leads <item-id>       # who is on this ticket
iris leads items <lead-id>        # what tickets mention this person
```

`--relation` is free text (`reported-by`, `about`, `stakeholder`), so the link records
why the person is on the item rather than merely that they are.

> **Note — attribution is a different thing.** `iris bug report --reporter-lead` writes a
> *server-composed* attribution into the item's own metadata, and bug-bounty payouts
> resolve against it. `link-lead` is a plain relationship for context and lookup; it
> confers no credit and no payout. If you want someone paid, use the reporter field.
