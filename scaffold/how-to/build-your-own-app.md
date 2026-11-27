---
category: Pages & Design
level: intermediate
tags: [genesis, pages, app, dashboard, atlas, actions, install, desktop, windows, mac, serve, local, sdk]
duration_min: 15
---
# Build your own app

Make an app for yourself: a dashboard of your agents, a tracker for your leads, a queue of things
to approve. It shows **your** data from IRIS, its buttons **do** things, it sits in your Dock or
Start menu with its own icon, and it runs from IRIS Cloud or from your own computer.

It is one IRIS page. No server to keep running, no script, no launcher.

<div style="overflow-x:auto;margin:1.25rem 0">
<svg viewBox="0 0 720 150" role="img" aria-label="Your data in Atlas feeds one page. The page's buttons act back on your data through IRIS. The page installs in your Dock or Start menu, and runs from IRIS Cloud or from your computer." style="width:100%;min-width:600px;height:auto;max-width:760px;display:block;font-family:var(--doc-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);color:inherit">
  <defs><marker id="byoa-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="currentColor" fill-opacity=".6"/></marker></defs>
  <g fill="none" stroke="currentColor" stroke-opacity=".7" stroke-width="1.6">
    <ellipse cx="90" cy="52" rx="50" ry="10"/><path d="M40 52 V96 A50 10 0 0 0 140 96 V52"/>
    <rect x="270" y="34" width="150" height="82" rx="6"/><path d="M270 50 H420"/>
    <rect x="560" y="40" width="44" height="44" rx="10"/><rect x="616" y="40" width="44" height="44" rx="10" stroke-opacity=".35"/>
  </g>
  <g fill="currentColor" fill-opacity=".45"><circle cx="280" cy="42" r="2"/><circle cx="287" cy="42" r="2"/><circle cx="294" cy="42" r="2"/></g>
  <g stroke="currentColor" stroke-opacity=".3" stroke-width="3" stroke-linecap="round"><path d="M284 66 H360"/><path d="M284 78 H396"/><path d="M284 90 H340"/></g>
  <rect x="372" y="96" width="38" height="12" rx="3" style="fill:var(--primary-color, var(--ok, #059669))" fill-opacity=".85"/>
  <g stroke="currentColor" stroke-opacity=".6" marker-end="url(#byoa-arr)"><path d="M150 66 H260"/><path d="M430 62 H550"/></g>
  <path d="M262 102 H150" stroke="currentColor" stroke-opacity=".6" stroke-dasharray="3 3" marker-end="url(#byoa-arr)"/>
  <g text-anchor="middle" font-size="11" fill="currentColor">
    <text x="90" y="128" font-weight="700">your data</text><text x="345" y="134" font-weight="700">one page</text><text x="610" y="110" font-weight="700">your Dock</text>
    <text x="205" y="58" opacity=".7">shows</text><text x="205" y="118" opacity=".7">buttons act</text><text x="490" y="54" opacity=".7">installs</text>
  </g>
</svg>
</div>

> Using an agent? Ask it: *"make me an app that shows my agents and lets me pause them."* It
> follows the `build-your-own-app` playbook and does the steps below for you.

## 1 · Make the page

Write it as a standalone HTML page (see the `bespoke` how-to), and add three blocks to it:

```bash
iris pages pull my-dashboard
# edit pages/my-dashboard.json — inside json_content:
```

```json
"bindings": { "agents": "agents:all", "beats": "heartbeat:all" },
"actions":  { "status": { "run": "agent-settings:personality", "roles": ["admin"], "fields": ["status"] } },
"app":      { "name": "My Command Center", "short_name": "Command", "theme_color": "#0f7a5c" }
```

| Block | What it does |
|---|---|
| `bindings` | the data the page shows — your agents, a dataset, a collection |
| `actions` | what its buttons may do. `fields` limits a button to exactly what it changes |
| `app` | its name and icon once installed. `short_name` is the label under the icon (≈12 characters) |

A ready-made example to read: `curl -s https://heyiris.io/p/alex-command-center` (signed out, so
it shows the page's code but none of anyone's data).

## 2 · Show your data, wire the buttons

In the page's script:

```js
if (!iris.data.has('agents')) { /* signed out: show a "Sign in" link to /login?intended=… */ }
const agents = iris.data.rows('agents')

// a Pause button
await iris.actions.run('status', { agentId: 42, values: { status: 'paused' } })
```

Only you see your rows. Anyone else who opens the page sees the sign-in, and nothing of yours is
in the page they get. The server checks every button press is you, from the page itself, and
changes only what the action names.

```bash
iris pages push my-dashboard --publish
```

## 3 · Put it in your Dock or Start menu

From the browser, like any page (Chrome/Edge: **Install**; Safari on Mac: File → **Add to Dock**;
iPhone: Share → **Add to Home Screen**) — or from the terminal, which also works on Windows with
a proper icon at every size:

```bash
iris pages install my-dashboard            # Start menu · ~/Applications · your launcher
iris pages install my-dashboard --remove   # take it out again
```

It opens in its own window, with its own icon.

## 4 · Or run it on your own computer

```bash
iris pages serve my-dashboard
iris pages install my-dashboard --local    # the shortcut opens this copy
```

The copy on your computer is **live**: your data, signed in as you, buttons work, and anything you
publish shows on the next load. It starts with the computer, and with no network it opens with the
last data it had. Your sign-in never goes into the page — the copy on your computer holds it.

`--no-live` gives a frozen copy instead. `--public` gives a phone an address too; a public copy is
always frozen, so your data never goes on the internet.

## 5 · Things only your computer can do

An app running on your computer can ask for a few things IRIS Cloud can't do — and **you** approve
them, not the page:

```json
"local": {
  "notify": true,
  "agents": ["pause", "resume"],
  "files": ["~/Reports"],
  "commands": { "backup": ["rsync", "-a", "~/Documents", "/Volumes/Backup"] }
}
```

```js
if ((await iris.local.available()).available) {
  await iris.local.run('notify', { title: 'Report ready' })
  await iris.local.run('open', { path: '~/Reports' })
  await iris.local.run('command.backup')
}
```

The first time, your computer asks you to allow exactly that list (or run
`iris pages allow my-dashboard`). Change the app and it asks again. Files are opened in their own
app, never read into the page; commands run exactly as written, with nothing added. Every call is
logged in `~/.iris/served/my-dashboard/local-actions.log`. `iris pages allow my-dashboard --revoke`
takes it all back.

## Good to know

- **Cloud or your computer?** Cloud opens anywhere and needs nothing kept running. Your computer
  works offline and can do the step-5 things.
- **A page shared with your team** behind a sign-in also installs as its own app, for the people
  who can open it.
- **Your own data on a page anyone can visit** is only ever shown to you, and never cached.
