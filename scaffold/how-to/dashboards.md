# How to: dashboards

---
category: Building
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
