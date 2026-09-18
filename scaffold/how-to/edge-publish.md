---
category: Infrastructure
level: intermediate
tags: [edge, hosting, static, self-host, genesis, deploy, rollback, compliance]
duration_min: 10
---
# Host your IRIS page on your own server

Build and edit your page in IRIS as you do today — then run it on **infrastructure you already
own**. One command turns a published page into plain files, proves they work on their own, and
deploys them to your server as a release you can undo in a second.

<div style="overflow-x:auto;margin:1.25rem 0">
<svg viewBox="0 0 720 176" role="img" aria-label="The journey at a glance: your page on IRIS Cloud is exported to a folder that is checked with IRIS Cloud switched off, deployed to your server, and served to your visitors on your domain." style="width:100%;min-width:600px;height:auto;max-width:760px;display:block;font-family:var(--doc-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);color:inherit">
  <defs><marker id="edge-fa-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="currentColor" fill-opacity=".6"/></marker></defs>
  <path d="M44 98 H108 A20 20 0 0 0 104 59 A28 28 0 0 0 52 54 A22 22 0 0 0 44 98 Z" fill="none" stroke="currentColor" stroke-opacity=".7" stroke-width="1.6"/>
  <text x="76" y="86" text-anchor="middle" fill="currentColor" font-size="10.5" font-weight="700">IRIS</text>
  <path d="M236 52 H258 L265 60 H306 V104 H236 Z" fill="none" stroke="currentColor" stroke-opacity=".7" stroke-width="1.6"/>
  <path d="M236 66 H306" stroke="currentColor" stroke-opacity=".35"/>
  <g fill="none" stroke="currentColor" stroke-opacity=".7" stroke-width="1.6"><rect x="440" y="48" width="72" height="18" rx="3"/><rect x="440" y="70" width="72" height="18" rx="3"/><rect x="440" y="92" width="72" height="18" rx="3"/></g>
  <g style="fill:var(--primary-color, var(--ok, #059669))"><circle cx="500" cy="57" r="2.6"/><circle cx="500" cy="79" r="2.6"/><circle cx="500" cy="101" r="2.6"/></g>
  <rect x="604" y="48" width="96" height="62" rx="5" fill="none" stroke="currentColor" stroke-opacity=".7" stroke-width="1.6"/>
  <path d="M604 60 H700" stroke="currentColor" stroke-opacity=".35"/>
  <g fill="currentColor" fill-opacity=".45"><circle cx="612" cy="54" r="2"/><circle cx="619" cy="54" r="2"/><circle cx="626" cy="54" r="2"/></g>
  <g stroke="currentColor" stroke-opacity=".3" stroke-width="3" stroke-linecap="round"><path d="M616 74 H672"/><path d="M616 84 H688"/><path d="M616 94 H660"/></g>
  <g stroke="currentColor" stroke-opacity=".6" marker-end="url(#edge-fa-arr)"><path d="M122 80 H226"/><path d="M318 80 H430"/><path d="M522 80 H596"/></g>
  <g text-anchor="middle" font-size="11" fill="currentColor">
    <text x="174" y="72" font-weight="700">export</text><text x="374" y="72" font-weight="700">deploy</text><text x="559" y="72" font-weight="700">serve</text>
  </g>
  <g text-anchor="middle" fill="currentColor">
    <text x="76" y="138" font-size="12.5" font-weight="700">IRIS Cloud</text><text x="76" y="156" font-size="10.5" fill-opacity=".6">your page, as today</text>
    <text x="271" y="138" font-size="12.5" font-weight="700">a folder</text><text x="271" y="156" font-size="10.5" fill-opacity=".6">checked, Cloud off</text>
    <text x="476" y="138" font-size="12.5" font-weight="700">your server</text><text x="476" y="156" font-size="10.5" fill-opacity=".6">/srv/site/current</text>
    <text x="652" y="138" font-size="12.5" font-weight="700">your visitors</text><text x="652" y="156" font-size="10.5" fill-opacity=".6">on your domain</text>
  </g>
</svg>
</div>

```bash
iris genesis export my-page                                  # → ./exports/my-page/site, verified
iris genesis deploy exports/my-page/site --target production # a new release, switched in atomically
iris genesis deploy --target production --rollback           # back one release, in a second
```

## Why teams host it themselves

- **Nothing to run or patch.** The result is static files: no server-side code, no database, no
  service of any kind on your machine. That makes it simple to host and straightforward to put
  through a security review.
- **Your stack, your rules.** Serve it from the web server or CDN you already trust — with your own
  certificates, logs, caching and analytics.
- **Independent.** Once deployed, the page keeps serving with no connection to IRIS Cloud.
- **Safe by default.** Pages behind a sign-in, data that differs per visitor, and anything that
  looks like health information are left out automatically — and every omission is listed.
- **Reversible.** Every deploy is kept as its own release. Going back takes one command and
  uploads nothing.
- **Still edited in IRIS.** Your team keeps the editor, the components and the workflow they
  already know. Publishing a change is one more export and deploy.

## Where it fits

<div style="overflow-x:auto;margin:1.25rem 0">
<svg viewBox="0 0 720 244" role="img" aria-label="Four reasons teams host an IRIS page themselves: compliance and data residency, serving it from hosting they already run, a page that stays up with no connection to IRIS Cloud, and keeping each approved release as its own folder." style="width:100%;min-width:600px;height:auto;max-width:760px;display:block;font-family:var(--doc-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);color:inherit">
<rect x="10" y="8" width="340" height="108" rx="8" fill="none" stroke="currentColor" stroke-opacity=".3"/>
<path d="M38 46 L52 40 L66 46 V60 C66 72 58 78 52 82 C46 78 38 72 38 60 Z" fill="none" stroke="currentColor" stroke-opacity=".75" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><path d="M46 62 L51 67 L59 57" fill="none" stroke="currentColor" stroke-opacity=".75" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
<text x="92" y="44" fill="currentColor" font-size="13" font-weight="700">Compliance &amp; data residency</text>
<text x="92" y="68" fill="currentColor" fill-opacity=".7" font-size="10.5">Your security team needs public</text>
<text x="92" y="86" fill="currentColor" fill-opacity=".7" font-size="10.5">pages on infrastructure you control.</text>
<rect x="370" y="8" width="340" height="108" rx="8" fill="none" stroke="currentColor" stroke-opacity=".3"/>
<path d="M394 52 L412 43 L430 52 L412 61 Z" fill="none" stroke="currentColor" stroke-opacity=".75" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><path d="M394 62 L412 53 L430 62 L412 71 Z" fill="none" stroke="currentColor" stroke-opacity=".75" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><path d="M394 72 L412 63 L430 72 L412 81 Z" fill="none" stroke="currentColor" stroke-opacity=".75" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
<text x="452" y="44" fill="currentColor" font-size="13" font-weight="700">Your existing hosting</text>
<text x="452" y="68" fill="currentColor" fill-opacity=".7" font-size="10.5">Serve it from your nginx, S3 or CDN,</text>
<text x="452" y="86" fill="currentColor" fill-opacity=".7" font-size="10.5">with your certificates and logs.</text>
<rect x="10" y="128" width="340" height="108" rx="8" fill="none" stroke="currentColor" stroke-opacity=".3"/>
<circle cx="52" cy="182" r="21" fill="none" stroke="currentColor" stroke-opacity=".75" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><path d="M37 182 H45 L49 172 L55 192 L59 182 H67" fill="none" stroke="currentColor" stroke-opacity=".75" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
<text x="92" y="164" fill="currentColor" font-size="13" font-weight="700">Stays up on its own</text>
<text x="92" y="188" fill="currentColor" fill-opacity=".7" font-size="10.5">Once deployed it needs no connection</text>
<text x="92" y="206" fill="currentColor" fill-opacity=".7" font-size="10.5">to IRIS Cloud to keep serving.</text>
<rect x="370" y="128" width="340" height="108" rx="8" fill="none" stroke="currentColor" stroke-opacity=".3"/>
<rect x="395" y="167" width="34" height="9" rx="2" fill="none" stroke="currentColor" stroke-opacity=".75" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><path d="M397 176 V198 H427 V176" fill="none" stroke="currentColor" stroke-opacity=".75" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><path d="M406 185 H418" fill="none" stroke="currentColor" stroke-opacity=".75" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
<text x="452" y="164" fill="currentColor" font-size="13" font-weight="700">The exact approved version</text>
<text x="452" y="188" fill="currentColor" fill-opacity=".7" font-size="10.5">Each release is kept as its own</text>
<text x="452" y="206" fill="currentColor" fill-opacity=".7" font-size="10.5">folder, so you can return to it.</text>
</svg>
</div>

- **Regulated organisations** whose policy says public pages must run on their own infrastructure.
- **Teams with an established hosting setup** — a campaign or product page served through the same
  CDN, certificates and monitoring as the rest of the site.
- **Pages that must stay up on their own**, independent of any outside platform.
- **Approved content** — a page signed off by legal or a client, kept exactly as approved, with
  every earlier release still on disk.

## Why this, and not the alternatives

The usual ways to get a site onto your own server are to **rebuild it** on your own stack, or to
point a **website copier** at it. Rebuilding costs a rewrite and leaves your team maintaining a
second codebase. A copier only sees what the first page load asks for — modern pages load parts of
themselves while they run, so copies can come out quietly incomplete, and nothing checks the result.

<div style="overflow-x:auto;margin:1.25rem 0">
<svg viewBox="0 0 720 270" role="img" aria-label="Compared with rebuilding the site on your own stack or using a website copier, IRIS Edge keeps editing in IRIS, captures files the page loads at runtime, checks the result with IRIS Cloud switched off before it ships, leaves out per-visitor and private data and lists it, and undoes a bad release with one command." style="width:100%;min-width:600px;height:auto;max-width:760px;display:block;font-family:var(--doc-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);color:inherit">
<rect x="575" y="6" width="130" height="250" rx="8" fill="none" style="stroke:var(--primary-color, var(--ok, #059669))" stroke-width="1.6"/>
<text x="360" y="30" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">Rebuild it</text>
<text x="500" y="30" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">Website copier</text>
<text x="640" y="30" text-anchor="middle" font-size="12.5" font-weight="700" style="fill:var(--primary-color, var(--ok, #059669))">IRIS Edge</text>
<path d="M10 42 H710" stroke="currentColor" stroke-opacity=".35"/>
<text x="16" y="66" fill="currentColor" font-size="12">Keep editing in IRIS</text>
<text x="360" y="66" text-anchor="middle" font-size="11" style="fill:var(--doc-trap, var(--hold, #c2410c))">✗ separate codebase</text>
<text x="500" y="66" text-anchor="middle" font-size="11" style="fill:var(--primary-color, var(--ok, #059669))">✓ re-copy</text>
<text x="640" y="66" text-anchor="middle" font-size="11" style="fill:var(--primary-color, var(--ok, #059669))">✓ re-export</text>
<path d="M10 78 H570" stroke="currentColor" stroke-opacity=".1"/>
<text x="16" y="98" fill="currentColor" font-size="12">Files loaded at runtime</text>
<text x="360" y="98" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity=".65">—</text>
<text x="500" y="98" text-anchor="middle" font-size="11" style="fill:var(--doc-trap, var(--hold, #c2410c))">✗ often missed</text>
<text x="640" y="98" text-anchor="middle" font-size="11" style="fill:var(--primary-color, var(--ok, #059669))">✓ captured</text>
<path d="M10 110 H570" stroke="currentColor" stroke-opacity=".1"/>
<text x="16" y="130" fill="currentColor" font-size="12">Checked before it ships</text>
<text x="360" y="130" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity=".65">your own QA</text>
<text x="500" y="130" text-anchor="middle" font-size="11" style="fill:var(--doc-trap, var(--hold, #c2410c))">✗ not checked</text>
<text x="640" y="130" text-anchor="middle" font-size="11" style="fill:var(--primary-color, var(--ok, #059669))">✓ in a browser</text>
<path d="M10 142 H570" stroke="currentColor" stroke-opacity=".1"/>
<text x="16" y="162" fill="currentColor" font-size="12">Per-visitor &amp; private data</text>
<text x="360" y="162" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity=".65">your call</text>
<text x="500" y="162" text-anchor="middle" font-size="11" style="fill:var(--doc-trap, var(--hold, #c2410c))">✗ no rules</text>
<text x="640" y="162" text-anchor="middle" font-size="11" style="fill:var(--primary-color, var(--ok, #059669))">✓ left out, listed</text>
<path d="M10 174 H570" stroke="currentColor" stroke-opacity=".1"/>
<text x="16" y="194" fill="currentColor" font-size="12">Undo a bad release</text>
<text x="360" y="194" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity=".65">your pipeline</text>
<text x="500" y="194" text-anchor="middle" font-size="11" style="fill:var(--doc-trap, var(--hold, #c2410c))">✗ by hand</text>
<text x="640" y="194" text-anchor="middle" font-size="11" style="fill:var(--primary-color, var(--ok, #059669))">✓ one command</text>
<path d="M10 206 H570" stroke="currentColor" stroke-opacity=".1"/>
<text x="16" y="226" fill="currentColor" font-size="12">Effort</text>
<text x="360" y="226" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity=".65">a rewrite</text>
<text x="500" y="226" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity=".65">manual fixes</text>
<text x="640" y="226" text-anchor="middle" font-size="11" style="fill:var(--primary-color, var(--ok, #059669))">✓ one command</text>
</svg>
</div>

IRIS Edge is built for exactly this job: it copies the page's complete file set, checks the result
in a real browser before handing it over, knows which data must not leave, and deploys as
releases you can roll back.

## Which setup fits your page

<div style="overflow-x:auto;margin:1.25rem 0">
<svg viewBox="0 0 720 304" role="img" aria-label="Your IRIS page can run in two places. On IRIS Cloud it supports sign-in and members-only pages, data that differs per visitor, edits that go live instantly, and your own domain, with nothing to host. On your own server it runs on your infrastructure, works with IRIS Cloud switched off, and rolls back in a second, but has no sign-in pages and updates only when you deploy." style="width:100%;height:auto;max-width:760px;font-family:var(--doc-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);color:inherit">
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

## What you need

The IRIS CLI **v1.3.271+** (`iris update`), Google Chrome on the machine doing the export, and ssh +
rsync for a remote server. Full step-by-step, including the deploy config:
[the edge-publish playbook](https://heyiris.io/playbooks/edge-publish).

## Export — it stops rather than hand you something broken

`iris genesis export` opens the result in a real browser **with IRIS Cloud switched off**, and
compares it with your live page. If anything is wrong it stops with a clear exit code instead of
giving you a folder that only looks fine:

<div style="overflow-x:auto;margin:1.25rem 0">
<svg viewBox="0 0 720 236" role="img" aria-label="Export runs in four stages: read the page from IRIS Cloud, copy every file including ones loaded at runtime, open it in a browser with IRIS Cloud switched off, and hand over a ready folder. It stops with exit 5 if the page is behind a sign-in, exit 3 if a file is missing, exit 2 if the page changed mid-copy, and exit 4 if it does not render." style="width:100%;height:auto;max-width:760px;font-family:var(--doc-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);color:inherit">
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

<div style="overflow-x:auto;margin:1.25rem 0">
<svg viewBox="0 0 720 200" role="img" aria-label="Which data is copied. Collections that are the same for everyone and are not health information, such as products and opening hours, are copied. A collection that differs per visitor, such as my orders, is left out and listed. Anything that looks like health information, such as patient notes, is left out and listed." style="width:100%;min-width:600px;height:auto;max-width:760px;display:block;font-family:var(--doc-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);color:inherit">
  <g font-size="11" fill="currentColor" fill-opacity=".6" font-weight="700"><text x="16" y="22">collection</text><text x="210" y="22">same for everyone?</text><text x="400" y="22">health info?</text><text x="548" y="22">result</text></g>
  <path d="M10 32 H710" stroke="currentColor" stroke-opacity=".35"/>
  <g stroke="currentColor" stroke-opacity=".12"><path d="M10 70 H710"/><path d="M10 108 H710"/><path d="M10 146 H710"/></g>
  <g font-size="12.5" fill="currentColor">
    <text x="16" y="56" font-weight="700">products</text><text x="210" y="56">yes</text><text x="400" y="56">no</text>
    <text x="16" y="94" font-weight="700">opening-hours</text><text x="210" y="94">yes</text><text x="400" y="94">no</text>
    <text x="16" y="132" font-weight="700">my-orders</text><text x="210" y="132">no — per visitor</text><text x="400" y="132" fill-opacity=".45">—</text>
    <text x="16" y="170" font-weight="700">patient-notes</text><text x="210" y="170" fill-opacity=".45">—</text><text x="400" y="170">yes</text>
  </g>
  <g fill="none" stroke-width="1.4">
    <rect x="544" y="40" width="96" height="24" rx="12" style="stroke:var(--primary-color, var(--ok, #059669))"/><rect x="544" y="78" width="96" height="24" rx="12" style="stroke:var(--primary-color, var(--ok, #059669))"/>
    <rect x="544" y="116" width="160" height="24" rx="12" style="stroke:var(--doc-trap, var(--hold, #c2410c))"/><rect x="544" y="154" width="160" height="24" rx="12" style="stroke:var(--doc-trap, var(--hold, #c2410c))"/>
  </g>
  <g font-size="11.5" font-weight="700" text-anchor="middle">
    <text x="592" y="56" style="fill:var(--primary-color, var(--ok, #059669))">✓ copied</text><text x="592" y="94" style="fill:var(--primary-color, var(--ok, #059669))">✓ copied</text>
    <text x="624" y="132" style="fill:var(--doc-trap, var(--hold, #c2410c))">✗ left out, listed</text><text x="624" y="170" style="fill:var(--doc-trap, var(--hold, #c2410c))">✗ left out, listed</text>
  </g>
</svg>
</div>

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
<svg viewBox="0 0 720 232" role="img" aria-label="Your web server always serves the folder called current. Each deploy adds a new timestamped folder under releases and switches current to it. Rollback switches current back to the previous release without uploading anything." style="width:100%;height:auto;max-width:760px;font-family:var(--doc-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);color:inherit">
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

<div style="overflow-x:auto;margin:1.25rem 0">
<svg viewBox="0 0 720 222" role="img" aria-label="The web server rule. The home page and any existing file are served as they are. A page address that is not a file on disk, such as /p/my-page/pricing, falls back to index.html. A missing asset file, such as a missing script, must return 404 and never index.html." style="width:100%;min-width:600px;height:auto;max-width:760px;display:block;font-family:var(--doc-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);color:inherit">
  <defs><marker id="edge-fc-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="currentColor" fill-opacity=".6"/></marker></defs>
  <g font-size="11" fill="currentColor" fill-opacity=".6" font-weight="700"><text x="16" y="18">request</text><text x="380" y="18" text-anchor="middle">on disk?</text><text x="480" y="18">your server returns</text></g>
  <g fill="none" stroke="currentColor" stroke-opacity=".4"><rect x="10" y="30" width="250" height="34" rx="5"/><rect x="10" y="78" width="250" height="34" rx="5"/><rect x="10" y="126" width="250" height="34" rx="5"/><rect x="10" y="174" width="250" height="34" rx="5"/></g>
  <g font-size="12" fill="currentColor"><text x="24" y="52">/</text><text x="24" y="100">/p/my-page/pricing</text><text x="24" y="148">/build/assets/app-X1.js</text><text x="24" y="196">/build/assets/gone-Y2.js</text></g>
  <g stroke="currentColor" stroke-opacity=".55" marker-end="url(#edge-fc-arr)"><path d="M262 47 H468"/><path d="M262 95 H468"/><path d="M262 143 H468"/><path d="M262 191 H468"/></g>
  <g text-anchor="middle" font-size="10.5" fill="currentColor"><text x="380" y="41">yes</text><text x="380" y="89">no — a page</text><text x="380" y="137">yes</text><text x="380" y="185">no — an asset</text></g>
  <rect x="474" y="30" width="236" height="34" rx="5" fill="none" stroke="currentColor" stroke-opacity=".4"/>
  <rect x="474" y="78" width="236" height="34" rx="5" fill="none" style="stroke:var(--primary-color, var(--ok, #059669))" stroke-width="1.6"/>
  <rect x="474" y="126" width="236" height="34" rx="5" fill="none" stroke="currentColor" stroke-opacity=".4"/>
  <rect x="474" y="174" width="236" height="34" rx="5" fill="none" style="stroke:var(--doc-trap, var(--hold, #c2410c))" stroke-width="1.6"/>
  <g font-size="12" fill="currentColor">
    <text x="488" y="52">index.html</text>
    <text x="488" y="100" font-weight="700">index.html</text><text x="700" y="100" text-anchor="end" font-size="10.5" style="fill:var(--primary-color, var(--ok, #059669))" font-weight="700">the fallback</text>
    <text x="488" y="148">the file</text>
    <text x="488" y="196" font-weight="700" style="fill:var(--doc-trap, var(--hold, #c2410c))">404</text><text x="700" y="196" text-anchor="end" font-size="10.5" style="fill:var(--doc-trap, var(--hold, #c2410c))" font-weight="700">never index.html</text>
  </g>
</svg>
</div>

## Running it day to day

It's your server, your certificate, and your uptime. **To change the page, export and deploy
again** — the self-hosted copy updates only when you choose, so it keeps working even with no
connection to IRIS Cloud. Want sign-ins, live data, or content that differs per visitor? Those run
on IRIS Cloud — ask your IRIS contact to connect your domain.
