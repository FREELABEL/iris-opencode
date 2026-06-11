# Import an Event Flyer (IG / any URL) → Events + Show on the Front

Two things people conflate. **There are two separate "events" surfaces** — know which one you're feeding:

| Surface | What it is | How the flyer renders | Fed by |
|---------|-----------|----------------------|--------|
| **Events API (DB)** | First-class `events` records — detail pages, tickets, QR check-in, dashboards | `event.photo` / `event.flyer` | `iris events import`, `iris content event import-from-ig` |
| **A page's `EventGrid`** | A Genesis component on a landing page (e.g. `ffat`) | per-event **`imageUrl`** in the component's `events[]` array | hand-edited page JSON via `iris pages` |

> ⚠️ **The big gotcha:** `EventGrid` is **static** — it has NO `autoPopulate`/bloq binding. It renders exactly the `events[]` array baked into the page JSON. So `iris events import` (which writes the DB) does **NOT** make a flyer appear on a landing page like `ffat`. For the front, you edit the page.

---

## A. Add an event + flyer to the Events API (DB)

Needs an authenticated IG session through the bridge (Playwright). If it errors with "session", run:
`iris hive credentials save-session --platform instagram`

```bash
# Multi-platform importer (IG, Eventbrite, Posh, Partiful, Meetup, any event page)
iris events import "https://www.instagram.com/p/DZYeQ67xASQ/" \
  --bloq-id <BLOQ_ID> \
  --dry-run                 # preview extracted title/date/venue/flyer first, drop --dry-run to create

# IG-specific path (same result, scrapes flyer + caption + location)
iris content event import-from-ig "https://www.instagram.com/p/DZYeQ67xASQ/" --bloq-id <BLOQ_ID>

# Attach a flyer to an event that already exists
iris content event update-flyer <EVENT_ID> "https://www.instagram.com/p/DZYeQ67xASQ/"
# alias: iris content event flyer <EVENT_ID> <url>
```

Both set `flyer` AND `photo` on the record (extra images land in `metadata.gallery`). Verify:
`iris events get <EVENT_ID>` → look for **Photo/banner: set**.

Note: `iris events import-ig` is **[moved]** → use `iris content event import-from-ig`.

---

## B. Show the flyer on a landing page (e.g. `ffat`)

The page's `EventGrid` takes a static `events[]` array; each item supports `imageUrl` (the flyer):

```json
{
  "type": "EventGrid",
  "props": {
    "events": [
      {
        "title": "First Friday Art Trail — June 2026",
        "date": "Jun 5, 2026",
        "time": "5:00 PM – 10:00 PM",
        "location": "Hope Outdoor Art Gallery, Austin TX",
        "category": "Art Market",
        "imageUrl": "https://<cdn>/ffat-june-flyer.jpg",   // ← the flyer
        "ctaText": "Vendor Registration",
        "ctaUrl": "https://freelabel.net/p/ffat-vendors",
        "featured": true
      }
    ]
  }
}
```

Workflow:

```bash
iris pages pull ffat                 # download page JSON locally
# edit the EventGrid → set/add the event with imageUrl = flyer URL
iris pages push ffat                 # ⚠️ push UNPUBLISHES the page
iris pages publish ffat              # re-publish (page is 404 until you do)
iris pages cache-clear ffat          # clients see stale render until cleared
```

**Flyer hosting:** IG image URLs are short-lived/signed — don't point `imageUrl` at instagram.com. Upload the flyer to our CDN first (`iris cloud upload <file>`), then use that URL. (If the DO CDN is in an outage, use the R2 path.)

---

## TL;DR for "add this IG flyer to FFAT and show it on the front"

1. `iris cloud upload ./ffat-flyer.jpg` → copy the CDN URL (or pull it via the IG import's `--dry-run` output).
2. `iris events import "<ig-url>" --bloq-id <ffat-bloq>` → creates the DB event w/ flyer (detail page + tickets).
3. `iris pages pull ffat` → add the event to `EventGrid.events[]` with `imageUrl` → `iris pages push ffat && iris pages publish ffat && iris pages cache-clear ffat`.
