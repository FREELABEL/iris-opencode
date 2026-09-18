---
category: Infrastructure
level: intermediate
tags: [edge, hosting, static, self-host, genesis, deploy, rollback]
duration_min: 10
---
# Put a page on a server you control

You get **files**. Nothing of ours runs on your machine — no renderer, no service. The browser does
the rendering, exactly as it does for every visitor today.

```bash
iris genesis export my-page                                  # → ./exports/my-page/site, verified
iris genesis deploy exports/my-page/site --target production # a new release, switched in atomically
iris genesis deploy --target production --rollback           # back one release, in a second
```

Needs the IRIS CLI **v1.3.268+** (`iris update`), Google Chrome on the machine doing the export,
and ssh + rsync for a remote server. The full walkthrough is the `edge-publish` playbook.

## First: is this the right answer?

| You want | Use |
|---|---|
| Your domain in the address bar | **A custom domain.** Our servers, your name. |
| The page's files on your own server | **This.** |
| A dashboard behind a login, on your server | **Neither works.** A file cannot ask who is reading it — use a custom domain. |

## Export — it refuses rather than hand you something broken

`iris genesis export` loads the result in a real browser **with every request to our servers
blocked**, and compares it with the live page. It exits non-zero instead of producing a folder that
only looks fine:

- **exit 5** — the page is behind a sign-in; you would get the sign-in form and nothing behind it
- **exit 2** — the page changed mid-export; run it again
- **exit 3** — a file the page needs was missing; one missing file can blank the whole page
- **exit 4** — it exported but did not render without us; do not deploy it

Data that differs per visitor, or looks like health information, is **left out and written down**
in `site/api/v1/app-data/_edge.json` — never skipped silently.

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
`/srv/site/current` switch to it. Visitors never see a half-copied release, and
`--rollback` just moves the link back — nothing is uploaded or deleted.

## The one rule your web server needs

```bash
iris genesis export my-page --host-config    # nginx, Caddy, S3 + CloudFront
```

**Point the web root at `/srv/site/current`. Unknown addresses fall back to `index.html` —
except asset files, which must return a real 404.** Miss the fallback and refresh breaks; apply it
to assets and a missing file shows up as a baffling script error.

## What you own afterwards

Your server, your certificate, your uptime. **Changes need a new export and deploy** — nothing
updates on its own, which is exactly what makes the page independent of us.
