---
category: Infrastructure
level: intermediate
tags: [edge, hosting, static, self-host, genesis, deploy, rollback]
duration_min: 10
---
# Host your IRIS page on your own server

Your IRIS pages can run in two places: on **IRIS Cloud**, or on **a server you run yourself**. This
recipe covers the second. You export the page as plain files and host them anywhere — no extra
software to install or maintain. Your visitors' browsers do the rendering, exactly as they do today.

```bash
iris genesis export my-page                                  # → ./exports/my-page/site, verified
iris genesis deploy exports/my-page/site --target production # a new release, switched in atomically
iris genesis deploy --target production --rollback           # back one release, in a second
```

You'll need the IRIS CLI **v1.3.271+** (`iris update`), Google Chrome on the machine doing the
export, and ssh + rsync for a remote server. Full step-by-step, including the deploy config:
[the edge-publish playbook](https://heyiris.io/playbooks/edge-publish).

## Which setup fits


<div style="overflow-x:auto;margin:1.25rem 0">
<svg viewBox="0 0 720 304" role="img" aria-label="Your IRIS page can run in two places. On IRIS Cloud it supports sign-in and members-only pages, data that differs per visitor, edits that go live instantly, and your own domain, with nothing to host. On your own server it runs on your infrastructure, works with IRIS Cloud switched off, and rolls back in a second, but has no sign-in pages and updates only when you deploy." style="width:100%;min-width:600px;height:auto;max-width:760px;display:block;font-family:var(--doc-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);color:inherit">
  <rect x="250" y="6" width="220" height="40" rx="6" fill="none" stroke="currentColor" stroke-opacity=".55"/>
  <text x="360" y="31" text-anchor="middle" fill="currentColor" font-size="13.5" font-weight="700">your IRIS page</text>
  <path d="M360 46 V64 M180 64 H540 M180 64 V84 M540 64 V84" fill="none" stroke="currentColor" stroke-opacity=".4"/>
  <rect x="30" y="84" width="300" height="212" rx="8" fill="none" stroke="currentColor" stroke-opacity=".35"/>
  <text x="180" y="112" text-anchor="middle" fill="currentColor" font-size="14" font-weight="700">IRIS Cloud</text>
  <text x="180" y="130" text-anchor="middle" fill="currentColor" fill-opacity=".6" font-size="11">your domain, hosted by IRIS</text>
  <g font-size="12" fill="currentColor">
    <text x="58" y="162" style="fill:var(--primary-color, var(--ok, #059669))" font-weight="700">✓</text><text x="80" y="162">sign-in, members-only pages</text>
    <text x="58" y="188" style="fill:var(--primary-color, var(--ok, #059669))" font-weight="700">✓</text><text x="80" y="188">data per visitor</text>
    <text x="58" y="214" style="fill:var(--primary-color, var(--ok, #059669))" font-weight="700">✓</text><text x="80" y="214">edits live instantly</text>
    <text x="58" y="240" style="fill:var(--primary-color, var(--ok, #059669))" font-weight="700">✓</text><text x="80" y="240">your own domain</text>
    <text x="58" y="266" style="fill:var(--primary-color, var(--ok, #059669))" font-weight="700">✓</text><text x="80" y="266">nothing to host</text>
  </g>
  <rect x="390" y="84" width="300" height="212" rx="8" fill="none" stroke="currentColor" stroke-opacity=".35"/>
  <text x="540" y="112" text-anchor="middle" fill="currentColor" font-size="14" font-weight="700">Your server</text>
  <text x="540" y="130" text-anchor="middle" fill="currentColor" fill-opacity=".6" font-size="11">static files, hosted by you</text>
  <g font-size="12" fill="currentColor">
    <text x="418" y="162" style="fill:var(--primary-color, var(--ok, #059669))" font-weight="700">✓</text><text x="440" y="162">your own infrastructure</text>
    <text x="418" y="188" style="fill:var(--primary-color, var(--ok, #059669))" font-weight="700">✓</text><text x="440" y="188">runs with IRIS Cloud off</text>
    <text x="418" y="214" style="fill:var(--primary-color, var(--ok, #059669))" font-weight="700">✓</text><text x="440" y="214">rollback in a second</text>
    <text x="418" y="240" style="fill:var(--doc-trap, var(--hold, #c2410c))" font-weight="700">✗</text><text x="440" y="240">no sign-in pages</text>
    <text x="418" y="266" font-weight="700" fill-opacity=".6">↻</text><text x="440" y="266">updates on each deploy</text>
  </g>
</svg>
</div>

| You want | Use |
|---|---|
| Your own domain in the address bar | **IRIS Cloud with a custom domain** — ask your IRIS contact to connect it. |
| The page's files on your own server | **This recipe.** |
| A dashboard behind a login, on your own server | **IRIS Cloud with a custom domain.** Sign-in and per-person data need IRIS Cloud; a static file cannot check who is reading it. |

## Export — it stops rather than hand you something broken

`iris genesis export` opens the result in a real browser **with IRIS Cloud switched off**, and
compares it with your live page. If anything is wrong it stops with a clear exit code instead of
giving you a folder that only looks fine:


<div style="overflow-x:auto;margin:1.25rem 0">
<svg viewBox="0 0 720 236" role="img" aria-label="Export runs in four stages: read the page from IRIS Cloud, copy every file including ones loaded at runtime, open it in a browser with IRIS Cloud switched off, and hand over a ready folder. It stops with exit 5 if the page is behind a sign-in, exit 3 if a file is missing, exit 2 if the page changed mid-copy, and exit 4 if it does not render." style="width:100%;min-width:600px;height:auto;max-width:760px;display:block;font-family:var(--doc-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);color:inherit">
  <defs><marker id="edge-f2-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="currentColor" fill-opacity=".55"/></marker></defs>
  <g fill="none" stroke="currentColor" stroke-opacity=".4">
    <rect x="8" y="18" width="156" height="58" rx="6"/><rect x="190" y="18" width="156" height="58" rx="6"/><rect x="372" y="18" width="156" height="58" rx="6"/>
  </g>
  <rect x="554" y="18" width="156" height="58" rx="6" fill="none" style="stroke:var(--primary-color, var(--ok, #059669))" stroke-width="1.6"/>
  <g stroke="currentColor" stroke-opacity=".55" marker-end="url(#edge-f2-arr)"><path d="M166 47 H186"/><path d="M348 47 H368"/><path d="M530 47 H550"/></g>
  <g text-anchor="middle" fill="currentColor">
    <text x="86" y="43" font-size="12.5" font-weight="700">1 · read the page</text><text x="86" y="62" font-size="11" fill-opacity=".6">from IRIS Cloud</text>
    <text x="268" y="43" font-size="12.5" font-weight="700">2 · copy each file</text><text x="268" y="62" font-size="11" fill-opacity=".6">incl. runtime ones</text>
    <text x="450" y="43" font-size="12.5" font-weight="700">3 · open it</text><text x="450" y="62" font-size="11" fill-opacity=".6">IRIS Cloud off</text>
    <text x="632" y="43" font-size="12.5" font-weight="700" style="fill:var(--primary-color, var(--ok, #059669))">4 · folder ready</text><text x="632" y="62" font-size="11" fill-opacity=".6">exports/…/site</text>
  </g>
  <g fill="none" style="stroke:var(--doc-trap, var(--hold, #c2410c))" stroke-dasharray="4 3"><path d="M86 76 V112"/><path d="M268 76 V112"/><path d="M450 76 V112"/></g>
  <g text-anchor="middle" font-size="11.5">
    <text x="86" y="130" style="fill:var(--doc-trap, var(--hold, #c2410c))" font-weight="700">exit 5</text><text x="86" y="147" fill="currentColor" fill-opacity=".75">behind a sign-in</text>
    <text x="268" y="130" style="fill:var(--doc-trap, var(--hold, #c2410c))" font-weight="700">exit 3</text><text x="268" y="147" fill="currentColor" fill-opacity=".75">a file is missing</text>
    <text x="268" y="170" style="fill:var(--doc-trap, var(--hold, #c2410c))" font-weight="700">exit 2</text><text x="268" y="187" fill="currentColor" fill-opacity=".75">page changed mid-copy</text>
    <text x="450" y="130" style="fill:var(--doc-trap, var(--hold, #c2410c))" font-weight="700">exit 4</text><text x="450" y="147" fill="currentColor" fill-opacity=".75">does not render</text>
  </g>
  <text x="360" y="224" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity=".6">It stops with a clear exit code instead of handing over a folder that only looks fine.</text>
</svg>
</div>

- **exit 5** — the page is behind a sign-in. Use IRIS Cloud with a custom domain instead.
- **exit 2** — the page was updated while exporting. Run it again.
- **exit 3** — a file the page needs was missing, and one missing file can blank the whole page.
  Run it again.
- **exit 4** — it exported, but did not render correctly on its own. Do not deploy it; the output
  names the check that failed.

Data that differs per visitor, or looks like health information, is **left out on purpose and
listed** in `site/api/v1/app-data/_edge.json` — never skipped silently.

Look before anyone else does: `iris genesis serve-edge exports/my-page/site`, then open
http://localhost:8080 and **refresh on an inner page**.

## Deploy — with an undo

Describe your server once, in `genesis-deploy.json`:

```json
{ "targets": { "production": {
    "type": "ssh", "host": "deploy@your-server", "path": "/srv/site",
    "keep": 5,     "url": "https://yoursite.com/" } } }
```

Every deploy lands in `/srv/site/releases/<timestamp>/`, is checked again, and only then does
`/srv/site/current` switch to it. Visitors never see a half-copied release, and `--rollback` just
switches back — nothing is uploaded or deleted.


<div style="overflow-x:auto;margin:1.25rem 0">
<svg viewBox="0 0 720 232" role="img" aria-label="Your web server always serves the folder called current. Each deploy adds a new timestamped folder under releases and switches current to it. Rollback switches current back to the previous release without uploading anything." style="width:100%;min-width:600px;height:auto;max-width:760px;display:block;font-family:var(--doc-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);color:inherit">
  <defs>
    <marker id="edge-f3-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="currentColor" fill-opacity=".6"/></marker>
    <marker id="edge-f3-go" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" style="fill:var(--primary-color, var(--ok, #059669))"/></marker>
  </defs>
  <rect x="8" y="128" width="140" height="46" rx="6" fill="none" stroke="currentColor" stroke-opacity=".45"/>
  <text x="78" y="148" text-anchor="middle" fill="currentColor" font-size="12.5" font-weight="700">web server</text>
  <text x="78" y="164" text-anchor="middle" fill="currentColor" fill-opacity=".6" font-size="10.5">web root → current</text>
  <path d="M148 151 H186" stroke="currentColor" stroke-opacity=".6" marker-end="url(#edge-f3-arr)"/>
  <rect x="190" y="128" width="110" height="46" rx="6" fill="none" style="stroke:var(--primary-color, var(--ok, #059669))" stroke-width="1.6"/>
  <text x="245" y="156" text-anchor="middle" font-size="13" font-weight="700" style="fill:var(--primary-color, var(--ok, #059669))">current</text>
  <path d="M300 151 C 330 151, 330 151, 366 151" fill="none" style="stroke:var(--primary-color, var(--ok, #059669))" stroke-width="1.6" marker-end="url(#edge-f3-go)"/>
  <text x="370" y="18" fill="currentColor" fill-opacity=".6" font-size="11">&lt;path&gt;/releases/</text>
  <g fill="none" stroke="currentColor" stroke-opacity=".35">
    <rect x="370" y="28" width="250" height="40" rx="5" stroke-opacity=".2"/>
    <rect x="370" y="78" width="250" height="40" rx="5"/>
  </g>
  <rect x="370" y="131" width="250" height="40" rx="5" fill="none" style="stroke:var(--primary-color, var(--ok, #059669))" stroke-width="1.6"/>
  <g font-size="12" fill="currentColor">
    <text x="386" y="53" fill-opacity=".45">20260916-120501</text><text x="604" y="53" text-anchor="end" font-size="10.5" fill-opacity=".45">kept</text>
    <text x="386" y="103">20260917-161144</text><text x="604" y="103" text-anchor="end" font-size="10.5" fill-opacity=".6">previous</text>
    <text x="386" y="156" font-weight="700">20260918-093012</text><text x="604" y="156" text-anchor="end" font-size="10.5" font-weight="700" style="fill:var(--primary-color, var(--ok, #059669))">live</text>
  </g>
  <path d="M622 151 C 668 151, 668 98, 626 98" fill="none" stroke="currentColor" stroke-opacity=".6" stroke-dasharray="4 3" marker-end="url(#edge-f3-arr)"/>
  <text x="664" y="129" fill="currentColor" font-size="11" font-weight="700">rollback</text>
  <text x="360" y="218" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity=".6">A deploy adds a folder and switches one link. Rollback switches it back — nothing is uploaded.</text>
</svg>
</div>

## The one rule your web server needs

```bash
iris genesis export my-page --host-config    # nginx, Caddy, S3 + CloudFront
```

**Point the web root at `/srv/site/current`. Unknown addresses fall back to `index.html` —
except asset files, which must return a real 404.** Without the fallback, refreshing an inner page
breaks; with it applied to assets, a missing file shows up as a confusing script error.

## Running it day to day

It's your server, your certificate, and your uptime. **To change the page, export and deploy
again** — the self-hosted copy updates only when you choose, so it keeps working even with no
connection to IRIS Cloud. Want sign-ins, live data, or content that differs per visitor? Those run
on IRIS Cloud — ask your IRIS contact to connect your domain.
