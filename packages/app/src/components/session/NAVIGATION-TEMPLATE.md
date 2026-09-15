# TEMPLATE — Three levels of navigation, and a record that is more than one thing

**Written 2026-09-13, from the IRIS desktop panel (epic #184872), after building it twice.**
This is the shape every new surface in that panel uses, or argues why not.

---

## The problem it solves

One tab held eight product surfaces. Each surface turned out to have *modes*, and each row in a
surface turned out to be several things at once. Left alone that becomes either nine top-level
tabs that do not fit in a 500px panel, or a single flat list where nothing is subordinate to
anything.

## The three levels

| level | answers | control | why not the others |
|---|---|---|---|
| 1 · SURFACE | which product surface | filled segmented plate | changing it changes the subject entirely |
| 2 · SUB-VIEW | which way of looking at it | rule underneath, active item underlined | you stay where you are; a plate would say otherwise |
| 3 · DETAIL | which face of ONE record | small chips, 11px, inside the detail | scoped to one record, and the size says so |

```
┌──────────────────────────────────────────────────┐
│ Richard's Signal — Competitive Intel      ⌄      │  board picker
│                                                  │
│  Atlas  Agents  Leads  Pages  Hive  …            │  LEVEL 1 — plate
│  ────                                            │
│  Lists  Schemas                                  │  LEVEL 2 — rule underneath
│  ─────                                           │
│    ← Back                                        │
│    Accounting Evidence                           │
│    ⟨Info⟩ ⟨Records⟩ ⟨JSON⟩                       │  LEVEL 3 — chips
│    ┌────┬─────────┬──────┬──────────────┐        │
│    │ id │ Mailbox │ Type │ From ᴾᴴᴵ     │        │  the table
└──────────────────────────────────────────────────┘
```

**The differences ARE the hierarchy.** Elon's console draws mode as a plate and section as an
underline, and those two are only legible as levels because they are drawn differently. Two
identically-drawn strips stacked is one flat menu that happens to wrap. Everything else here is
detail; this is the rule.

---

## The five rules that are not about drawing

### 1 · A sub-view is a DIFFERENT ENDPOINT, never a filter over rows already on screen

Filtering a page client-side leaves the footer counting the unfiltered set, so "12 of 40" sits
under nine rows and describes a different set. Where a narrower view is wanted and no endpoint
exists, **add the narrowing to the server, in front of the paging.**

Proven on three boards with mixed rows: `7 = 2 + 5`, `9 = 2 + 7`, `4 = 2 + 2`, with `total`
tracking each subset. A zero-row board proves nothing — find data that exercises both branches.

### 2 · One resolver returns the renderer AND the URL

```ts
resolvePane(surface, sub) -> { pane, path }
```

Two lookups can disagree, and the way they disagree is `/iris/schemas/674` fetched but drawn by
the Atlas renderer, which reads `lists` from a payload whose array is `schemas`. A full response
rendered as an empty board — the failure that reads to a user as *"my data is gone"*.

### 3 · Sub-view state is a MAP, not a scalar

`{atlas: "lists", hive: "inbox", pages: "sites"}` in localStorage. Elon keeps one scalar for both
levels and resets it on every reload, which is the most-complained-about thing about /console by
construction. An unknown value falls back to the first sub-view rather than stranding someone on
a blank pane — the string a previous build persisted is still sitting in real installs.

### 4 · A held payload is not an answer about the pane on screen

Stale-while-revalidate keeps the last payload so the panel does not blink through nothing. That
is right when both panes name their rows the same way and a **confident lie** when they do not.
Machines arrive as `nodes`, an inbox as `items`; switching between them rendered *"Nothing in
Hive › Inbox"* over an inbox with two messages in it.

Stamp every payload with the pane it was fetched for. A mismatch reads as **loading**, never as
empty. This is strictly worse than the blank it replaced if you get it wrong, because a blank
does not claim anything.

### 5 · Columns come from the SCHEMA, never inferred from the rows

A column inferred from data vanishes the moment every row on the page has it null — silently,
for the whole table. Take the columns from the declared schema, and label what the schema
declares: a field marked `phi` gets said out loud on the header rather than left to be inferred
from what is in it.

---

## Level 3: a record is usually three things

`info` is always present and always first, so a detail never opens on a tab that turns out to be
empty. The rest are declared **per kind of record**, not probed per instance — "does this have a
preview" is a fact about the kind.

| record | tabs |
|---|---|
| schema | Info · **Records** (the data table) · JSON |
| page | Info · **Preview** (live iframe) · JSON |
| site | Info · **Pages** (its navigation, as links) · JSON |
| agent, integration | Info · JSON |

**JSON is not a debug affordance.** It is the answer to "is this field missing because the
server omitted it, or because this panel dropped it" — the question every flattened detail view
eventually raises.

**Do not offer a tab that cannot work.** Sites got a *Pages* tab and not a *Preview* tab because
every published site 404s at its documented route `/s/{slug}` while the `/p/` pages it links to
serve 200. An iframe pointed at that renders a 404 and reads as a broken preview rather than as
the routing gap it is.

---

## What NOT to copy

`badge: count > 0 ? count : null`. It renders **zero, unknown and errored as the same blank
tab** — the distinction between "nothing here" and "we could not look" is the one this whole
codebase keeps paying to relearn.

---

## The verification rule

**Green tests are not a rendered page.** Two bugs shipped through a clean typecheck, passing unit
tests and passing API probes, and were caught only by a screenshot:

- A schema's `fields` is a *wrapper* — `{fields: [...], display_field: "..."}` — not a key→type
  map. Read as one it produced a column literally named "fields" whose type was every field
  object stringified. It rendered, so nothing failed. It was nonsense on screen for all 40
  schemas, for as long as the surface had existed.
- The stale-pane claim in rule 4. The route returned both inbox messages correctly the entire
  time. Only the screenshot disagreed.

And check the harness before believing it. A suite here carried a `test.fail` for a feature that
worked, with a paragraph explaining why the app was at fault; the defect was that it clicked
`getByText("IRIS").last()`, which matches a wrapper `<div>` rather than the
`[data-slot=tabs-trigger][role=tab]` button. The click landed on nothing and the failure read as
*"the panel does not render"*. Separately, a persistence test cleared the localStorage it was
about to assert had persisted, because `addInitScript` re-runs on every navigation — a harness
that could not tell "persistence is broken" from "I broke it", reporting the first while doing
the second.


---

## The one modal, and why it is not a fourth level (#185485)

The card editor opens in a modal. Everything above says the panel navigates in place, and it
does — this is the exception, and the argument for it is **width**, not familiarity. Details
beside a body is two columns; the panel is ~500px with the sidebar open, and 500px cannot hold
that honestly. It would be Elon's editor with its sidebar amputated.

What keeps it a detail view rather than a second navigation model:

- it opens FROM a row and returns TO it — Escape lands you where you were
- it has no surface switcher of its own; inside it, level 3 chips (Details · Tasks) are the
  same chips the panel uses, drawn the same way
- nothing is lost on close: every write was explicit, and the row behind it re-reads on save

The fallback if this turns out wrong is **not** "squeeze it into 500px". It is leave editing in
Elon and keep the copy-a-command chips, which at least does not lie about what the panel can do.
