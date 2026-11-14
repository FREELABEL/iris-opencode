---
category: Content & Media
level: advanced
tags: [content, rss, seo, syndication]
duration_min: 15
---
# How to: Syndicate a newsroom — RSS, JSON Feed and Google News

## What this does

Turns a Genesis newsroom page into a **feed** that readers, aggregators and Google News can
subscribe to. Three URLs come free with any newsroom page — you do not create them, configure
them, or deploy anything:

```
https://heyiris.io/p/<slug>/feed.xml            RSS 2.0
https://heyiris.io/p/<slug>/feed.json           JSON Feed 1.1
https://heyiris.io/p/<slug>/news-sitemap.xml    Google News sitemap
```

Until these existed, a newsroom was a page that listed articles rather than a newsroom. Every
aggregator, reader and news crawler walks through this one door, and we did not have it.

## Prerequisites

- A published Genesis page (`status: published` — a draft 404s)
- That page carries a **`BlogGrid`** or **`FeedLayout`** component with an `autoPopulate` block

That is the entire requirement. If both are true, the three feeds are already live.

## Steps

**1. Confirm the page has a feed component**

The feeds read the *first* `BlogGrid` or `FeedLayout` on the page that has `autoPopulate`. A page
with neither has nothing to syndicate.

```
$ iris pages pull <slug>
$ grep -A8 autoPopulate pages/<slug>.json
```

**2. Check the three doors**

```
$ curl -so /dev/null -w "%{http_code}\n" https://heyiris.io/p/<slug>/feed.xml
$ curl -s https://heyiris.io/p/<slug>/feed.json | head -20
```

**3. Read the feed back before you hand it to anyone**

```
$ curl -s https://heyiris.io/p/<slug>/feed.json \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['title'], len(d['items'])); [print(' -', i['url']) for i in d['items'][:5]]"
```

You are checking two things: the count is what the page shows, and **every URL belongs to this
client**. See the tenant warning below.

## The `autoPopulate` block

| Key | What it does |
|---|---|
| `ownerType` / `ownerId` | Whose pages to pull. **Required** — without both, the feed is empty. |
| `slugPrefix` | **The tenant boundary.** See below. |
| `limit` | How many items (default 12). |
| `sort` | `newest` (default) or `oldest`. |
| `pageType` | Filter to one page category. |
| `excludeSlugs` | Drop specific slugs by hand. |

Pinned/curated cards on the component are never duplicated by auto-pull — the query dedupes
against them by slug.

## ⚠️ `slugPrefix` is a security control, not a tidiness one

Client pages **share an owner**. `slugPrefix` is the only thing separating one client's newsroom
from another's. A feed that omits it publishes one client's articles on another client's RSS —
and it does so quietly, to subscribers, where nobody on your side is looking.

Verify it holds by diffing two clients' feeds and confirming zero overlap:

```
$ curl -s https://heyiris.io/p/client-a-newsroom/feed.json | grep -o '/p/[a-z-]*'
$ curl -s https://heyiris.io/p/client-b-newsroom/feed.json | grep -o '/p/[a-z-]*'
```

Every slug in the first should start with client A's prefix, and none should appear in the second.

## Things that will surprise you

**A missing feed 404s — it does not serve an empty feed.** This is deliberate. An empty
`<channel>` is a *valid* document that reads as "this newsroom published nothing", which a reader
caches and then stops polling. Absent and empty are different answers and only one of them is
true. If you get a 404, the page is unpublished or has no feed component — not "no articles yet".

**The page and the feeds cannot disagree.** Both call the same `NewsroomFeed` service. This is
load-bearing: if they could drift, a client's RSS would carry articles their own page does not,
and the first anyone would hear of it is a reader asking where a story went.

**The news sitemap only carries the last 2 days.** Not a bug. Google's news schema rejects older
items, and submitting them is how a sitemap gets ignored *wholesale* rather than partially. An
empty news sitemap on a quiet week is the correct output.

**Feeds cache for 5 minutes** (`max-age=300`). A just-published article is not instantly in the
feed. Wait it out before declaring the pipeline broken.

**Article images fall back to the generated OG image.** Newsroom-pipeline articles carry neither
`og_image` nor `thumbnail_url`, so without the fallback every card and feed item is imageless.

## Autodiscovery is automatic

A newsroom page advertises its own feeds in the page head, so readers, browser extensions and
aggregators find them without being handed a URL:

```html
<link rel="alternate" type="application/rss+xml"   href="https://…/p/<slug>/feed.xml">
<link rel="alternate" type="application/feed+json" href="https://…/p/<slug>/feed.json">
```

You do not add these. They appear on exactly the pages that have a feed, because the page emits
them on the same `configFrom()` condition the feed routes serve on — so the advertised address
can never be a 404.

Two consequences worth knowing:

- **A gated page never advertises a feed.** Gated pages render from a locked shell that carries
  no components, so there is nothing for the check to find. A locked page cannot publish a public
  address for the very articles it is withholding.
- **Custom domains get their own address.** The link is built from the resolved host, so a client
  on their own domain is not handed a `heyiris.io` feed URL.

## Related

- `pages.md` — building the Genesis page the feed reads from
- `bespoke.md` — custom newsroom layouts
- `genesis-design-standard.md` — read before building any page
