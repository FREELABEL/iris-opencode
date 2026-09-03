---
category: Pages & Design
level: advanced
tags: [genesis, pages, html, design]
duration_min: 18
prerequisites: [pages, genesis-design-standard, genesis-verify-pages]
---
# Bespoke Genesis Pages — How-To

> **STOP — read the design standard first:** `iris how-to view genesis-design-standard`
> Score every page against the 10-point audit before publishing. Check 01 (subject-derived) predicts
> the rest: if the design could be moved onto a different subject unchanged, it is a template and
> local fixes will not rescue it.
> Three that break pages silently: switch themes on `html.dark` **not** `prefers-color-scheme`;
> never let a CustomHtml block paint its own `background`; namespace every selector.


Ship a hand-designed **custom HTML+CSS** page as a live Genesis page at `heyiris.io/p/<slug>`.
Use this when the composable component catalog can't express the design and you want full freedom
(audit reports, one-pagers, animated landings, spec sheets).

See also: the `/bespoke` skill (`iris playbook run bespoke`) automates this whole pipeline.

## Two lanes — pick one

| Lane | What | Use when |
|------|------|----------|
| **CustomHtml component** | A raw-HTML block inside a normal page (`components:[{type:CustomHtml,props:{html}}]`) | Default. Keeps the page pipeline + theme; publish with `pages:batch` |
| **Standalone `--template=html`** | A full HTML document served by `public-html.blade.php` | You need a bare document — your own `<head>`, no framework |

## Quick path

```bash
# 1. Write doc.html — a <style> block + content, ALL scoped under one wrapper class.

# 2. Publish it. One command: parses the file, picks the lane, uploads, publishes, purges.
iris pages publish-html my-audit --file doc.html --owner-id 503 --dry-run   # see the parse
iris pages publish-html my-audit --file doc.html --owner-id 503             # ship it

# 3. Verify what actually rendered — NOT with curl (see below).
iris pages verify my-audit --expect "a phrase from the page" --lane bespoke
iris pages screenshot my-audit        # then score the 10-point design audit
```

The lane is inferred: a full `<html>` document becomes a standalone `render_mode:html`
page; a fragment becomes a `CustomHtml` component. `--lane` overrides it.

This replaces the `python3 -c` JSON surgery this recipe used to prescribe, which worked
through `./pages` relative to the current directory — how a persisted `cd` once shipped a
stale shadow of `/p/docs` over the live page and printed Done (#181601).

**Update later:** `iris pages pull my-audit` → edit `json_content.components[0].props.html` →
`iris pages push my-audit` → `iris pages publish my-audit`.

## Rule #1 — SCOPE every CSS selector

`CustomHtml` injects your HTML via `v-html` with **no shadow DOM / iframe**, so unscoped rules
collide with the Genesis page shell in both directions. Common classes (`.card`, `.tag`, `.status`,
`.step`, `.meta`) and bare selectors (`body`, `*`, `h1`, `table`) WILL clash.

- Wrap all content in one class: `<div class="xx">…</div>`
- Prefix every selector: `.xx .card{}`, `.xx h2{}`, `.xx *{box-sizing:border-box}`
- Put CSS vars + base font/color on the wrapper (`.xx{--bg:…;background:var(--bg)}`), **not** `:root`/`body`
- Theme both modes at the wrapper: `@media (prefers-color-scheme:dark){.xx{--bg:…}}` **and**
  `:root[data-theme="dark"] .xx{}` / `:root[data-theme="light"] .xx{}`

## Gotchas

- **`iris pages create` fails on bespoke** — its template auto-adds a `SiteFooter` that requires a
  `copyright` field → `Component validation failed`. Hand-build the JSON and use `pages:batch`.
- **Fonts:** CSP blocks font CDNs — use system stacks (`ui-monospace,…`, `-apple-system,…`), never a
  `<link>` webfont. Use `font-variant-numeric:tabular-nums` for figure columns.
- **Trust gate:** raw HTML / `CustomHtml` from an untrusted owner is rejected (403). Owner bloq must be trusted.
- **Always verify by screenshot** — Genesis has silent render gotchas (a `CodeBlock` renders blank,
  an `ImageBlock` needs `imageUrl`). Don't trust the publish log.

## Standalone lane (bare document)

```bash
iris pages create --slug my-doc --title "My Doc" --template=html --owner-id 503
iris pages pull my-doc          # put your FULL <html>…</html> in the html field
iris pages push my-doc && iris pages publish my-doc
```

`public-html.blade.php` injects a minimal reset (box-sizing, `html,body{margin:0}`, responsive media)
before your CSS so you can override it. No Tailwind, no theme toggle — you own the whole document.

## Worked example

`https://heyiris.io/p/bounty-audit-581` — a financial/systems audit shipped via the CustomHtml lane.

## The standalone lane, concretely (`render_mode: html`)

The CustomHtml lane above keeps the Genesis shell. The standalone lane replaces it — your markup is
served by `public-html.blade.php` with no Vue app around it. Use it for a full document that brings
its own `<head>`, or when Genesis shell CSS would fight your design.

Set it in `json_content` directly — there is no component array:

```python
page = {'slug':'my-doc','title':'My Doc','status':'published',
  'owner_type':'bloq','owner_id':563,
  'seo_title':'My Doc',                       # ← this IS the social preview title
  'seo_description':'One line summary.',      # ← and this is the card description
  'json_content':{
    'render_mode':'html',
    'head':'<link rel="stylesheet" href="https://unpkg.com/leaflet.css">',  # external tags only
    'css':'<the contents of your <style> block>',
    'html':'<your body markup>',
    'theme':{'mode':'light'}}}
```

Split a designed HTML file into those three fields — `<style>` contents → `css`, `<body>` contents →
`html`, external `<link>`/`<script src>` → `head`. Do **not** nest a whole `<html>` document inside
`html`; the blade provides the wrapper.

Scoping is *not* required on this lane (no shell to collide with), which is the main reason to choose it.

## Sharing, previews and privacy

- **Social previews** come from `seo_title` / `seo_description` / `og_image` (record level, overridable
  inside `json_content`). Set them at creation — a page published without them shares as a bare link.
- **og:image** is auto-generated at `/p/<slug-or-uuid>/og-image.png`; no asset needed.
- **Unlisted:** every page is reachable at `/p/<slug>` AND `/p/<public_id>`. There is no uuid-only mode
  (#178209), so to make a document unlisted you must publish it under a deliberately opaque slug and
  share the UUID. Treat that as obscurity, **not** access control — anyone with the link can read it.
- **Gating** (`requires_auth`) puts the Atlas OTP in front. Note it renders the GATE, not your document,
  until the visitor authenticates.

## Gotchas learned the hard way (2026-07-29)

- **`requires_auth` is one-way (#178208).** It is honoured on create and silently DROPPED on update —
  `pages:batch` prints "updated + published" and exits 0 while the flag stays as-is. Decide gated vs
  public at creation. Ungating later means recreating the page, which mints a NEW uuid and kills any
  link already shared.
- **Slugs are immutable (#178209).** `pages:batch` matches BY slug, so changing it creates a second page.
- **`pages pull` returns three different shapes (#178216)** — bare `json_content`, full record with `id`,
  or full record without. Sniff before you index; `d['json_content']` will KeyError on some pages.
- **Component prop contracts live in fl-api, not the component (#178219).** A `.schema.json` may say
  `steps: array` while `config/genesis-component-schemas.php` requires `steps.*.label`. Sibling
  components call the same field `title`. When a push is rejected, the error names the exact paths —
  trust it over the component schema.
- **Verify the LIVE render, not the API response** — with `iris pages verify <slug>`, **never with
  `curl | grep`.** A publish reporting success only means the JSON stored. But grepping the served
  bytes returns false negatives in both directions: a `text-transform:uppercase` headline greps 0 for
  the text a reader sees, and an absent `data-page` (which is the ANSWER — it means the bespoke blade
  served it) shows up as a regex crash. `verify` renders in a browser, asserts against the text layer
  with case and typography folded, reports the lane as a fact, and exits non-zero.
  Full detail: `iris how-to view genesis-verify-pages`.
- **Two caches.** After publishing, clear BOTH `iris pages cache-clear <slug>` and
  `iris pages cache-clear <uuid>`. The fan-out only works when the alias map is warm (#177872).
