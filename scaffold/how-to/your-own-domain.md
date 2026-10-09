---
category: Pages & Design
level: intermediate
tags: [genesis, pages, domains, custom-domain, hosting, dns]
duration_min: 10
---
# How to: Put a Genesis page on your own domain

## What this does

Makes `https://yourdomain.com` **serve** a page you built in Genesis — the address bar stays on
your domain; it is not a redirect. `www.yourdomain.com` comes along with it. Change which page the
domain shows at any time, with no DNS work.

Live examples: [hivemesh.net](https://hivemesh.net) and [genesis-ui.com](https://genesis-ui.com)
are Genesis pages on their own domains.

## Prerequisites

- Signed in: `iris auth login`
- A published Genesis page (its slug, e.g. `my-landing`) or site
- A domain. No domain yet? `iris domains search mybrand` shows what is free and what it costs.

## Steps

**1. Connect the domain to your page**

```bash
iris domains connect mybrand.com --page my-landing
```

It reserves the domain for your account and prints the DNS steps for **your** domain. The status
reads `Pending DNS` until those are done — that is expected.

**2. Point the domain at IRIS**

Follow the steps `connect` printed. Today that means the domain is served through IRIS's
Cloudflare: if your domain is managed by IRIS (we bought or host it for you), we do this part.
If it lives in your own DNS, send the printed steps to your IRIS contact.

**3. Check it**

```bash
iris domains verify mybrand.com
```

`DNS verified` + `mapping activated` means it is live. Then open `https://mybrand.com` in a
browser — you should see **your page**, not the IRIS "Welcome" screen. Allow up to 5 minutes after
verifying for the first visit to switch over.

**4. Change the page later**

```bash
iris domains assign mybrand.com --page another-page
```

No DNS change; the domain shows the new page within a few minutes.

## Useful commands

```bash
iris domains list                  # every domain on your account and its status
iris domains status mybrand.com    # DNS + mapping + a real request, in one check
iris domains remove mybrand.com    # disconnect it
```

## Common problems

**The domain shows the IRIS "Welcome — Let's get started" screen.** The request reached IRIS but
the domain is not activated yet. Run `iris domains verify mybrand.com` and read what it says — it
names the reason instead of claiming success.

**`Pending DNS` for a long time.** The DNS steps from step 1 are not in place yet, or have not
spread — DNS changes can take up to an hour. `iris domains status mybrand.com` shows where it
points right now.

**The domain bounces to another address.** A redirect is set on the domain in Cloudflare; redirects
run before IRIS sees the request. Remove it, then verify again.

**Want the page's files on your own server instead?** That is a different recipe:
`iris how-to view edge-publish`.
