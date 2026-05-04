# How to: Price tutorials on the Discover Learning tab

## What this does

The **Learning tab** on the Discover page (`/discover`) shows curated content from FreeLabel's three learning profiles (Entropy, THENIEA, Mino Marketing). Any video or article in those profiles can be **monetized** with a single CLI command — set a `price_usd` and a green `$29.99` price pill auto-appears on the card. This is the foundation for the paid tutorial / course / package pipeline; the pricing badge is the visible "this is paid" signal while the checkout flow is built out.

## Prerequisites

- Authenticated (`iris-login` complete)
- A real video or article ID from one of the learning profiles (use `iris tutorials list` to see what's already priced, or query `/api/v1/discover/learning-content` for the full feed)

## How content is identified

The Learning tab pulls from two underlying tables:
- **`tv`** — videos (type `video`)
- **`magazine`** — articles (type `article`)

Both have a `price_usd` decimal column. `null` or `0` means free; any positive value is the displayed price.

## Steps

### 1. List currently priced tutorials

```bash
$ iris tutorials list
```

Shows every video + article with `price_usd > 0`, sorted newest first. Each line shows the price, type tag, title, and ID. If you've never priced anything you'll see a "No paid tutorials yet" message with the next-step CLI hint.

```bash
# More results
$ iris tutorials list --limit 100
```

### 2. Set a price on a video

```bash
$ iris tutorials price video 13667 --price=29.99
```

```bash
# Integer prices render as "$29" not "$29.00"
$ iris tutorials price video 13667 --price=29
```

If you don't pass `--price`, the CLI prompts you for it. Pass `0` (or omit and enter `0`) to unprice.

### 3. Unprice (back to free)

```bash
$ iris tutorials price video 13667 --price=0
```

### 4. Same flow for articles

```bash
$ iris tutorials price article 4421 --price=15
```

The `<type>` argument accepts `video` or `article` only.

## Direct API access

Backend endpoints for both reads and writes:

```bash
# List paid tutorials
curl "https://raichu.heyiris.io/api/v1/discover/tutorials?limit=50" \
  -H "Authorization: Bearer $FL_API_TOKEN"

# Set a price (PUT)
curl -X PUT "https://raichu.heyiris.io/api/v1/discover/learning-content/video/13667/price" \
  -H "Authorization: Bearer $FL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"price_usd": 29.99}'

# Unprice (any of: null, 0, omitted price_usd)
curl -X PUT "https://raichu.heyiris.io/api/v1/discover/learning-content/video/13667/price" \
  -H "Authorization: Bearer $FL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"price_usd": null}'
```

The PUT endpoint clears the discover-content cache automatically so the change shows up on the next page load.

## How it fits together

- **Storage** — `tv.price_usd` and `magazine.price_usd` (both `decimal(10,2) nullable`, indexed)
- **Backend** — `DiscoverContentController::listTutorials|setLearningContentPrice`, routes in `routes/api/content-routes.php` under the `flexible.auth` group
- **Frontend** — `components/Discover/ContentCard.vue` reads `item.price_usd` and renders the green pill via the `priceLabel` computed; the existing `getLearningContent` endpoint passes the column through automatically (Eloquent serialization)
- **CLI** — `iris tutorials list/price` in `packages/opencode/src/cli/cmd/platform-tutorials.ts`

## Workflow: drop a course, sell it the same day

1. Record the course as a normal video, ingest into one of the learning profiles
2. Find the new video ID via `iris tutorials list` (after price set) or directly in the learning feed
3. `iris tutorials price video <id> --price=49`
4. The card on `web.freelabel.net/discover` Learning tab now shows `$49`
5. Share the deep link to the content page

## What's deferred

- **Stripe checkout flow on the card click** — the green pill is visible, but clicking the card still goes to the free content page. The plan: when `price_usd > 0` AND the user hasn't purchased, render a Buy button that opens a Stripe checkout session via `StripeCheckoutService::createStripeCheckoutSession`
- **Purchase records** — no `tutorial_purchases` table yet; will mirror the `event_ticket_purchases` pattern when checkout lands
- **Bulk operations** — no `iris tutorials price-bulk` for setting prices on a profile or category at once. Loop over IDs in shell for now.
