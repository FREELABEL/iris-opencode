---
category: Pages & Design
level: intermediate
tags: [dashboards, genesis, atlas, hive, console, components]
duration_min: 12
---
# How to: build a dashboard on Genesis, Atlas and Hive

## What this does
Composes a working console — rail, sub-tabs, list, stage, status bar — from components that
already exist, and adds one only where the library genuinely lacks it. A four-pane dashboard
should be page JSON, not a build.

**The judgment lives on a page, not in this recipe.** Score before shipping:
`https://heyiris.io/p/dashboard-design-philosophy` — ten checks, 9–10 ship, 6–8 revise,
0–5 rebuild. The long-form walkthrough is `iris playbook run console-shape`.

## The three parts, and which one you are touching

A dashboard here is not one product. It is a page from one, reading records from another, about
machines belonging to a third. Knowing which is which turns most "it renders but it is empty"
questions into a one-line answer.

| Product | What it is | What it gives the dashboard | You touch it with |
|---|---|---|---|
| **Genesis** | pages and the components they are made of | the page itself: the panes, the layout, the published URL | `iris pages …`, `iris genesis library …` |
| **Atlas** | your records — bloqs, lists, items, datasets | the ROWS: everything a pane lists or details | `iris collections read …`, `iris bloqs …` |
| **Hive** | your own machines, and the agents and jobs on them | the fleet a pane can show, and the work it dispatches | `iris hive …`, `iris agents …` |

<svg viewBox="0 0 720 210" width="100%" height="auto" role="img" aria-label="Atlas records and Hive machines resolve through a collection address into the panes of a Genesis page" style="max-width:720px;margin:1rem 0">
  <g fill="none" stroke="currentColor" stroke-width="1.25" opacity="0.5">
    <rect x="1" y="34" width="150" height="52" rx="6"/>
    <rect x="1" y="106" width="150" height="52" rx="6"/>
    <rect x="245" y="70" width="150" height="52" rx="6"/>
    <rect x="489" y="18" width="230" height="156" rx="6"/>
    <line x1="559" y1="52" x2="559" y2="150"/>
    <line x1="559" y1="112" x2="719" y2="112"/>
    <line x1="489" y1="150" x2="719" y2="150"/>
    <line x1="489" y1="52" x2="719" y2="52"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="12">
    <text x="14" y="58">ATLAS</text><text x="14" y="76" opacity="0.7">bloqs · lists · datasets</text>
    <text x="14" y="130">HIVE</text><text x="14" y="148" opacity="0.7">nodes · agents · jobs</text>
    <text x="258" y="94">agents:all</text><text x="258" y="112" opacity="0.7">the address</text>
    <text x="500" y="38" opacity="0.7">GENESIS PAGE</text>
    <text x="500" y="76">rail</text>
    <text x="570" y="76">list</text>
    <text x="570" y="136">stage</text>
    <text x="500" y="168" opacity="0.7">status</text>
  </g>
  <g stroke="currentColor" stroke-width="1.25" opacity="0.85">
    <path d="M151 60 H 200 Q 215 60 215 80 V 96 H 243" fill="none"/>
    <path d="M151 132 H 200 Q 215 132 215 112 V 96 H 243" fill="none"/>
    <path d="M395 96 H 487" fill="none"/>
    <path d="M481 92 l 8 4 l -8 4 z" fill="currentColor" stroke="none"/>
    <path d="M237 92 l 8 4 l -8 4 z" fill="currentColor" stroke="none"/>
  </g>
</svg>

**A component names a SOURCE; the page names the ADDRESS.** That split is the tenancy boundary —
it is why a component can never read a feed it was not handed, and why an empty pane is usually
an address problem rather than a component problem.

## Prerequisites
- IRIS CLI authenticated (`iris login`).
- A page you own, and a bloq to own it (`--owner-type bloq --owner-id <id>`).

## 1. Look before you build
```bash
$ iris genesis library list              # every stored component, with props/emits/slots
$ iris genesis library show registry-table
$ iris genesis library audit --stale-only # do the old ones still COMPILE, or just look old
```
The friction that makes someone write a NEW component is not knowing the old one exists — and
then there are two. `audit` matters because "stale" is a version comparison, not a health check.

## 2. Know what a pane may read
A component names a SOURCE; the PAGE names the address. That is the tenancy boundary.
```bash
$ iris collections read agents:all --limit 3     # the fleet
$ iris collections read schema:my-dataset        # what one dataset is MADE OF
$ iris collections read sites:all                # sites, each with its page count
```
Registry addresses today: `agents:all` `schedules:all` `pages:all` `sites:all` `playbooks:all`
`schemas:all` `nodes:all`, plus the singulars `agent:<id>` and `schema:<slug>`.

## 3. Compose the page
Four slots and one state bus. Slots take ARRAYS, so a column can stack a tab strip over a table.
```json
"state": { "source": null, "subfilter": null, "session": null },
"components": [{
  "type": "CodeComponent",
  "props": {
    "componentSlug": "workspace-shell",
    "componentProps": { "railWidth": "216px", "height": "82vh" },
    "slots": {
      "rail":   [{ "componentSlug": "source-rail",  "emitTo": { "select": "source" } }],
      "list":   [
        { "componentSlug": "tab-bar",
          "componentProps": { "tabSets": [ { "key": "agents", "tabs": [ {"label":"All","value":null} ] } ] },
          "bindState": { "context": "source" },
          "emitTo":    { "select": "subfilter" } },
        { "componentSlug": "registry-table",
          "collections": { "agents": "agents:all", "sites": "sites:all" },
          "defaultSource": "agents",
          "bindState": { "source": "source", "filter": "subfilter" },
          "emitTo":    { "select": "session" } }
      ],
      "stage":  [{ "componentSlug": "record-detail", "bindState": { "record": "session" } }],
      "status": [{ "componentSlug": "workspace-status-bar" }]
    }
  }
}]
```
**`emitTo` writes into a named state key. `bindState` reads it into a prop.** That is the whole
mechanism — if you want a third one, you probably want a state key you have not named yet.

<svg viewBox="0 0 720 200" width="100%" height="auto" role="img" aria-label="Clicking in the rail writes the source state key, which the list reads; clicking a row writes session, which the stage reads" style="max-width:720px;margin:1rem 0">
  <g fill="none" stroke="currentColor" stroke-width="1.25" opacity="0.5">
    <rect x="1" y="16" width="130" height="46" rx="6"/>
    <rect x="1" y="86" width="130" height="46" rx="6"/>
    <rect x="1" y="150" width="130" height="46" rx="6"/>
    <rect x="300" y="16" width="120" height="180" rx="6" stroke-dasharray="4 3"/>
    <rect x="589" y="86" width="130" height="46" rx="6"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="12">
    <text x="14" y="38">source-rail</text><text x="14" y="54" opacity="0.7">emitTo: select</text>
    <text x="14" y="108">registry-table</text><text x="14" y="124" opacity="0.7">bindState + emitTo</text>
    <text x="14" y="172">tab-bar</text><text x="14" y="188" opacity="0.7">emitTo: subfilter</text>
    <text x="312" y="38" opacity="0.7">page state</text>
    <text x="312" y="72">source</text>
    <text x="312" y="108">subfilter</text>
    <text x="312" y="144">session</text>
    <text x="600" y="108">record-detail</text><text x="600" y="124" opacity="0.7">bindState: session</text>
  </g>
  <g stroke="currentColor" stroke-width="1.25" opacity="0.85" fill="none">
    <path d="M131 39 H 298"/><path d="M292 35 l 8 4 l -8 4 z" fill="currentColor" stroke="none"/>
    <path d="M131 173 H 250 Q 262 173 262 150 V 108 H 298"/><path d="M292 104 l 8 4 l -8 4 z" fill="currentColor" stroke="none"/>
    <path d="M298 68 H 220 Q 205 68 205 88 V 104 H 129" stroke-dasharray="3 3"/><path d="M135 100 l -8 4 l 8 4 z" fill="currentColor" stroke="none"/>
    <path d="M131 118 H 240 Q 262 118 262 132 V 144 H 298"/><path d="M292 140 l 8 4 l -8 4 z" fill="currentColor" stroke="none"/>
    <path d="M420 108 H 587"/><path d="M581 104 l 8 4 l -8 4 z" fill="currentColor" stroke="none"/>
  </g>
  <g fill="currentColor" font-size="11" opacity="0.65" font-family="ui-sans-serif,system-ui,sans-serif">
    <text x="150" y="30">a click writes</text>
    <text x="150" y="88">a prop reads (dashed)</text>
    <text x="440" y="100">the stage follows the selection</text>
  </g>
</svg>

Three things that cost a round trip each if you miss them:
- `collections` / `defaultSource` sit at the ITEM level, **beside** `componentProps`, never inside
  it. Inside, they are silently ignored and give the identical error to omitting them (#183184).
- A bare `pages push` drops a live page to **draft**, which serves 404. `--publish` is not optional.
- A component with no binding publishes cleanly and fails only when someone clicks (#183183).

## 4. Add a component only if nothing composes
```bash
$ iris genesis library publish my-thing --file ./my-thing.vue --dry-run
```
Write it SCHEMA-DRIVEN — it renders what the data declares, so the next entity costs nothing.
The compiler refuses a lot on purpose; each of these is one round trip:

| refusal | do instead |
|---|---|
| `<script setup>` | Options API: `<script> export default { … } </script>` |
| `obj[variable]` — read OR write | `Object.entries(x).map(…)`, `rows.find(r => r.id === id)` |
| `data` reading a prop | `data(){return{chosen:null}}` + a computed that falls back |
| an undeclared emit | `emits: ['select']` |
| runtime slot names | literal slots — `one` / `two` / `three` |
| `<form>` | no generic form primitive exists yet |

Then publish with a `--description` that says what it is FOR — that description is what stops
the next person building it again.
```bash
$ iris genesis library usage my-thing     # who you are about to change, BEFORE you change them
$ iris genesis library publish my-thing --file ./my-thing.vue --name "My Thing" --description "…"
```

## 5. Prove it
```bash
$ iris pages push my-console --publish
$ iris pages verify my-console --expect "a phrase only this page has"
```
Then open it in a real browser at **390, 768 and 1440** and require all four:
1. `.ws` width === `innerWidth` — the page wrapper pads 18px, which is 9% of a phone
2. `scrollWidth - clientWidth === 0`
3. rows > 0 **at every width**
4. click a row and confirm the stage **CHANGED** — not merely that it re-rendered

On 4: a stage can refetch, relabel, and still show the same rows. Watch the request. If the
query carries no filter, the panel is decorative.

Grepping the served HTML is **not** verification — a Genesis page is client-rendered, so its
words live in a script payload while the page renders a shell.

## Gotchas that have each cost a day
- **Rows present ≠ rows for this source.** The server injects the first page for
  `defaultSource`, so a lazily-mounted tab already holds rows — from the wrong collection.
- **`RegistryCollection::query()` returns null.** Registries are materialised in PHP, so a
  `where` on one is skipped server-side. Filter client-side and SAY the scope.
- **A gated page needs its own session.** A platform login is not an atlas session; if the
  page admits you and every widget 401s, that is a different fix from signing in again.
- **Two components in one slot** used to put the second below the fold. Fixed at the platform,
  but if a pane looks empty, check whether it is merely one viewport further down.

## See also
- Score it: `https://heyiris.io/p/dashboard-design-philosophy`
- Walk it: `iris playbook run console-shape`
- A worked example with its gaps named: `https://heyiris.io/p/genesis-console-benchmark`
- Page-level design: `https://heyiris.io/p/design-philosophy-and-page-audit`
