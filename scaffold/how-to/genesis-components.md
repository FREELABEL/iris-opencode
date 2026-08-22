---
category: Pages & Design
level: intermediate
tags: [genesis, components, collections, atlas, bloqs]
duration_min: 15
---
# How to: Build a page from Genesis Components

## What this does
Write a component, compile it, store it, and name it from any page. The page carries no code —
it names a stored component and binds a collection, and the server attaches both at render.

## The mental model (read this first)

**A page binds an ADDRESS. Where the rows live sits behind it.**

That separation is the whole design. It is what makes "should a dataset live at the item level or
the bloq level?" answerable — the question conflated how a page *addresses* rows with where rows
are *stored*.

```
   ADDRESSING — what a page binds. Stable.
   collection: "item:181094" | "list:2115" | "bloq:620" | "dataset:sessions"
                             │
                ┌────────────┴────────────┐
                │   Collection contract   │
                │   fields() · query()    │
                │   rows()   · create()   │
                └────────────┬────────────┘
                             │
   STORAGE — swappable, invisible to the page.
    bloq_items.content       bloq_items          atlas_records
    (a card's table)         (cards as rows)     (typed records)
```

| Address | Rows are | Backed by |
| --- | --- | --- |
| `item:181094` | the table a **card carries** | `bloq_items.content.dataset` |
| `list:2115` | the **cards in a list** | `bloq_items` |
| `bloq:620` | the **cards in a workspace** | `bloq_items`, `list` is a field |
| `dataset:sessions` | **typed records** | `atlas_schemas` + `atlas_records` |

**Which to reach for** — the line is *who reads a row*, not where it is stored. A board list is
read by a human, item by item: tens to hundreds, curated, prose-bearing. An Atlas dataset is read
by nothing individually: hundreds to hundreds of thousands, uniform, generated, queried. 560
generated rows should not be 560 draggable cards; a curated todo list should not need a schema
migration.

## Prerequisites
- IRIS CLI authenticated (`iris auth`), with `node_api_key` in `~/.iris/config.json`
- A dataset to bind (`iris datasets schemas list`)

## Steps

### 1. Write the component

Options API, always. That is a security decision, not a style one: `<script setup>` is a module
body whose safety rests on anticipating every global, while an options object reaches state
through `this`, so the legal name set is *closed* — derived from your own source.

```vue
<template>
  <li v-for="row in rows" :key="row.id" @click="select(row)">{{ row.title }}</li>
</template>

<script>
export default {
  emits: ['select'],
  computed: { rows() { return this.$dataset.rows } },
  methods: { select(row) { this.$emit('select', row) } },
}
</script>
```

There is no `window`, `document`, `fetch` or `localStorage`, and no route to one. Data arrives
through `$dataset` / `$datasets`, bound **on the page**, so a component can never name a feed it
was not given.

### 2. Check it before you publish

```bash
$ cd fl-docker-dev/fl-iris-api
$ npm run compiler:check      # the full rule suite, including escapes it has already caught
```

### 3. Publish the components and build the page

```bash
$ node scripts/build-genesis-page.mjs ./my-page --publish
  ✓ ZonePane.vue    stored as zone-pane   props:[heading] emits:[select]
  ✓ BidStage.vue    stored as bid-stage   props:[zone]    emits:[]
  wrote my-page.json — 2 components (naming stored components; the page carries no code)
```

Every component is compiled **before** anything is published, so one failure aborts the batch
having written nothing. Re-running the same build is idempotent; replacing a component someone
else stored under that name returns **409** unless you pass `"replace": true`.

### 4. Push the page

```bash
$ cd /path/to/repo-root          # NOT fl-iris-api — it has a stale shadow pages/ dir
$ iris pages push my-page --publish
$ iris pages cache-clear my-page
```

### 5. Bind data in the page JSON

```json
{ "type": "CodeComponent",
  "props": {
    "componentSlug": "zone-pane",
    "datasets": { "bids": "genesis-console-demo" },
    "emitTo":    { "select": "zone" } } }
```

`emitTo` routes an event into page state; `bindState` feeds page state into another component's
prop. Both live in the page JSON, so the wiring between two components is readable without
opening either one.

## Searching, sorting and writing

```js
// SERVER-SIDE. Filtering rows in the browser searches only the page already loaded —
// a term matching row 300 of 500 returns nothing and looks exactly like no match.
const r = await this.$dataset.query({ search: 'denial', sort: 'title', dir: 'asc' })

// Writing. The component says WHAT, never WHERE.
const c = await this.$dataset.create({ title: 'Untitled' })
if (!c.ok) { this.notice = c.error }
```

`sort` is validated against the schema's **declared** fields; a key it never declared is refused
and named in `meta.sort_ignored`, so a dropped sort cannot pass as an honoured one. Writes require
a gated session and a write-capable role — on a public page a create returns `gate_required`,
which is the correct answer rather than a limitation.

## Authoring in the browser

`https://heyiris.io/p/genesis-studio` — compiles as you type, shows each refusal with its code and
line, and previews through the **same runtime** a live page uses, so the preview cannot show you
something production would not do.

## Gotchas

- **Push from the repo root.** `iris pages push` reads `./pages` from the working directory, and
  `fl-iris-api` has a stale shadow `pages/` that will silently win.
- **A page with an EMBEDDED artifact needs a trusted owner**; one that NAMES a stored component
  does not. That is what lets a tenant compose a page.
- **No `v-html`, no webfont CDNs, no remote `url()` in CSS.** All three fail silently in a way you
  will not notice; the compiler refuses them instead.
- **A component compiled under an older compiler keeps rendering.** `stale: true` on the stored
  row says so; nothing acts on it yet.

## Reference
- Full contract: https://heyiris.io/p/genesis-component-api
- Worked example: https://heyiris.io/p/atlas-console-v2
- Same components, second page: https://heyiris.io/p/genesis-component-reuse
- Studio: https://heyiris.io/p/genesis-studio
