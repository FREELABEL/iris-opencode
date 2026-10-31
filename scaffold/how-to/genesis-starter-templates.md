---
category: Pages & Design
level: beginner
tags: [genesis, templates, pages, brand, starter]
duration_min: 15
prerequisites: [pages, genesis-verify-pages]
---
# How to: Start a page from a Genesis template — clone it in your brand, then make it yours

## What this does

Gives you a finished, working page for your kind of business in one command, wearing your
brand's colour, fonts and corners — then walks you through the part a template can't do for
you: making it about *your* business.

Browse them first at **genesis-ui.com** (also at heyiris.io/p/genesis-templates). Every
preview there is the live page, so you can click around before you choose.

| Template | For |
|---|---|
| `restaurant` | A menu read live from a list, "open now", how to get a table |
| `events` | The next date as a ticket, a running order drawn to scale |
| `studio` | A maker or studio that works to commission |
| `local-service` | A trade that drives to the customer — "do you come to me, what will it cost" |
| `shop` | A small shop selling by post |
| `pricing` | A price argued from what the work really costs |
| `measured` | Numbers a stranger can rerun |
| `kids-hub` | A child's own screen for a photo frame or wall tablet |

The list grows. `iris genesis template list` always shows the current set.

## Prerequisites

- Signed in: `iris auth login`
- A brand with its colours and fonts saved. Check with `iris brands dt get <your-brand>`.
  A brand with no colours or fonts brings nothing, and the clone looks exactly like the
  template. Add them first: `iris brands dt import <your-brand> --css ./tokens.css`
- A board (bloq) of yours to own the page: `iris bloqs list`

## Steps

### 1. See what is available

```
$ iris genesis template list
```

Each line shows the template's name, what it is for and its design score.

### 2. Clone one in your brand

```
$ iris genesis template use local-service --brand acme-plumbing --as acme-home --bloq 1234
```

- `--brand` is the brand whose colour, fonts and corner radius the page takes
- `--as` is the address of your new page: it will live at `heyiris.io/p/acme-home`
- `--bloq` is the board that owns it

The new page is a **draft**: nobody can see it until you publish it. That is deliberate,
because it still says the template's words.

### 3. Read what it prints — that is your to-do list

The command ends with two things:

- **The names the copy still carries** — the template's sample business, town and products.
  Every one of them has to go.
- **The questions that make it yours** — for local service: how far you really drive, what
  your common jobs cost lowest and highest, when a person answers the phone. Answer each one
  in the page.

A recoloured page is still somebody else's page until those are done.

### 4. Change the words

```
$ iris pages pull acme-home
```

This writes `pages/acme-home.json`. The page's HTML is in `json_content.html`. Near the bottom
of it is a short `CONFIG` block — hours, prices, rings, reading goals, whatever the template
needs that is not a list. Edit that, and the text. Then:

```
$ iris pages push acme-home
```

### 5. Point it at your own data

Templates that show a list — a menu, products, towns you cover, a child's routines — read it
from a **dataset**. A fresh clone reads the template's sample data. To use your own:

```
$ iris atlas:datasets schemas show genesis-sample-services     # see the fields it expects
$ iris atlas:datasets schemas create --name "Acme services" --slug acme-services --bloq 1234 --fields fields.json --settings '{"public":true}'
$ iris atlas:datasets import services.json -s acme-services --bloq 1234
```

Every field the page shows must be marked `"visibility": "public"` in `fields.json`, or it
reads as empty. Then change the page's binding from the sample to yours: in
`pages/acme-home.json`, set `json_content.bindings` to `{ "services": "acme-services" }`, and
`iris pages push acme-home`.

### 6. Publish and check it in a browser

```
$ iris pages publish acme-home
$ iris pages verify acme-home --expect "a phrase from your page"
```

Then open it yourself: on your phone, in light and in dark mode.

## Expected output

`template use` ends like this (local service shown):

```
  The copy still names the template's owner: Kestrel Plumbing & Heating, Riverside Trade Park, …  — expected; rewrite it

  Now make it about this business (the colours are done; the subject is not)
   1. Where is your base, and how far will you really drive? …
   …
  Edit: iris pages pull acme-home  → change the copy →  iris pages push acme-home
```

## Common problems

| Problem | Why | Fix |
|---|---|---|
| The clone looks exactly like the template | Your brand has no colours or fonts saved | `iris brands dt get <brand>`; import them, clone again |
| The page went offline after a push | A push saves a new version as a draft | `iris pages publish <slug>` after every push |
| A list on the page is empty | The dataset is private, or a field is not marked public | Set `"public": true` on the dataset and `"visibility": "public"` on each field |
| Something the page should remember (ticks, a timer) is forgotten on reload | Your account's HTML pages run in a browser sandbox, which has no storage | Expected. Ask us about trusting your workspace if you need it |
| You're tempted to use `--force` | The leak check found the template's own names in your copy | Rewrite them instead. `--force` publishes someone else's business under your name |

## Related recipes

- `genesis-make-a-template` — turn one of your own pages into a template
- `genesis-verify-pages` — check a page really renders, not just that it saved
- `setup-brand-with-personas` — set up the brand a template takes its look from
- `your-own-domain` — put the finished page on your own domain
