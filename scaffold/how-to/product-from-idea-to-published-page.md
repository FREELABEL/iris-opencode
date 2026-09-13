# Take a product from a conversation to a published page, without leaving IRIS

**Category:** building · **Level:** intermediate · **Time:** one working session

This is written from a session that did it: an idea described out loud on a call became a
documented concept, a designed landing page and a live URL, with two people's agents passing
work between machines — using Atlas, Genesis and Hive and nothing else. No external model
console, no separate design tool, no copy-paste between apps after the first minute.

It is the honest version. Where a step cost an hour, that is in here.

---

## What you need before you start

- `iris` installed and signed in
- a bloq (project) to hold the work — `iris bloqs list` to find one
- the page you publish must be owned by an account on the raw-HTML allowlist. **Check this
  first**, not at publish time. See *The gate that stops you at the end* below.

---

## 1 · Capture the concept as an Atlas item, before designing anything

The page is downstream of the idea. Write the idea down where both the human and the agent
can reach it.

```
iris atlas get item <id>            # read an existing concept
iris bloqs items <bloq-id>          # see what is already in the project
```

Create the item with the concept in its body: what it is, who it is for, what the user does
first. This becomes the source the page is written FROM, so a later rewrite starts from the
subject rather than from the previous page.

**Why this step is not ceremony.** The design standard's first and most predictive check is
*could this design be moved onto a different subject unchanged?* If you have not written down
what the subject is, the honest answer is always yes.

---

## 2 · Say "bespoke" out loud

```
iris how-to bespoke
iris playbook run bespoke
```

Asking an agent for "a Genesis artifact" is ambiguous — *Genesis* routes to the composable
page builder, *artifact* routes to bespoke HTML. Those are two different products and only
one of them can do what a concept page needs.

**A composable page has no container primitive.** The component host renders with
`display: contents`, so it has no box, and edge-to-edge is the correct outcome. There is no
way to say "centre this in a column with gutters". That is why every polished one-off page in
the system is a single hand-written block.

| you want | use |
|---|---|
| the page is an **argument** — a pitch, a concept, a report, a one-pager | **bespoke HTML** |
| the page is **data-driven** over records it already holds — a queue, a dashboard, a filterable list | **components** |

Until the default is fixed, type the word `bespoke`. It costs you four seconds and saves a
rebuild.

---

## 3 · Build it as ONE CustomHtml block, and respect four rules

Each of these was learned by shipping something broken.

1. **Theme comes from the HOST, not the OS.** Switch on the wrapper's `dark` class — never
   `@media (prefers-color-scheme)`. A block that follows the OS renders dark inside a light
   page. (Standalone artifacts are the opposite: they own their document.)
2. **Do not paint your own `background`.** The block becomes a slab floating on a page ground
   whose colour it is only guessing at.
3. **Namespace every selector.** CustomHtml injects via `v-html` with no isolation, so a bare
   `body` / `section` / `table` rule leaks into the host page. Pick a prefix and use it
   everywhere.
4. **No webfont CDNs.** The CSP blocks them and it falls back to Arial silently. Use faces
   that ship on macOS and Windows, or inline a data URI.

---

## 4 · The gate that stops you at the end

```
Raw HTML (render_mode=html or the CustomHtml component) is restricted to trusted owners.
```

This is an **XSS boundary**, not a bug. Unsanitised markup on a multi-tenant page is a real
attack surface, so publishing it is limited to an allowlist.

**Do not try to route around it.** The update path checks the same predicate as publish, so
pull/edit/push hits the identical refusal — deliberately. There is no flag that gets past it;
`--force` on `iris pages push` means *"push even if the local file looks like a stale shadow
copy"* and has nothing to do with this gate. A session lost twenty minutes to that
misreading.

Two real options:

- **Hand the HTML to a trusted operator.** A trusted account may ship raw HTML onto a page a
  tenant created. That is a designed path, not a favour.
- **Get the account added to the allowlist** if it is going to do this regularly.

---

## 5 · Publish, then score it

```
iris pages pull <slug>          # ALWAYS pull first — push refuses if the live page moved
iris pages push <slug> --publish
iris pages verify <slug> --expect "a phrase from the page"
```

`pages pull` prints the version it is based on and the push refuses if the live page has
moved past it. Use it; a page can have more than one author.

Then score against the 10-point audit. **9–10 ship · 6–8 revise · 0–5 redesign.**

```
iris how-to genesis-design-standard
```

**Check 01 is the predictor.** If the design could be lifted onto a different subject
unchanged, it is a template, it will score four or below, and local fixes will not rescue it.
Restart from the subject, not the stylesheet.

**Check 10 is not optional, and it is the one people fake.** `pages verify` says so itself:
it reports *"found in the STORED page (not a render)"*. A text match proves the words
arrived. Only a browser proves the page works.

And on this platform you cannot check both themes by opening it once — the page follows the
OS and only ever *adds* a `dark` class, so you see whichever mode you are already in. Force
both in the console:

```js
document.documentElement.classList.add('dark')      // dark, look
document.documentElement.classList.remove('dark')   // light, look
```

The failure you are hunting is a colour chosen for one side only — a border that vanishes
into the ground, text below readable contrast. Invisible from the side you are on.

---

## 6 · Hand work between machines with Hive

Two people, two machines, two agents, one job. This replaces the copy-paste loop.

```
iris hive connections                 # who you are connected to
iris hive peers <connection-id>       # their machines, and whether they are online
iris hive send "<message>" --to <node-id>
iris hive inbox read                  # on the receiving side
```

**The inbox is pull-based.** Nothing pushes a message into a running session — the recipient
has to read it. Tell them to, or it sits there while they work.

A message to a machine that is **offline** is parked and delivered when it wakes. That is
recent: for a long time such messages returned `ok` and a task id and were destroyed
milliseconds later, so an inbox came up empty. If you see that, report it rather than working
around it.

---

## What this looked like in practice

Idea described on a call → Atlas item in the project → first attempt built with composed
components (wrong mode) → rebuilt as one bespoke CustomHtml block after a Hive message
explaining why → blocked by the raw-HTML gate → account added to the allowlist → published →
scored against the 10-point audit → rebuilt again as v2 from the subject, because the first
version would have scored about four.

The second rebuild is the part worth copying. It was not a restyle: the hero became a
transformation rather than a gradient, the pipeline a vertical timeline rather than an icon
row, the proof figures carried evidence rather than decoration, and the copy became the
user's words instead of the product's.

---

## Related

- `iris how-to bespoke` — the authoring rules in full
- `iris how-to genesis-design-standard` — read before building any page
- `iris playbook run live-meeting-to-build-pipeline` — the wider loop this sits inside
