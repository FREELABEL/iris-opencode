# How to: Curate the Discover page

## What this does

The Discover page (`web.freelabel.net/discover`) is FreeLabel's main public-facing surface. It's a stack of curated content sections, each driven by a different data source. Almost everything is **CLI-controlled** — there's no admin dashboard, by design (CLI-first survival mode). This guide is the master index of every surface and the one-line CLI to manage each.

If you only need detail on one feature, jump straight to the deeper how-to:
- [discover-investments.md](discover-investments.md) — capturing investor interest on opportunities
- [learning-tutorials.md](learning-tutorials.md) — pricing tutorials on the Learning tab
- [community-curation.md](community-curation.md) — featured producers + curated instrumentals

## The complete surface map

| Section                  | Tab        | Data source                                      | CLI                                                      |
| ------------------------ | ---------- | ------------------------------------------------ | -------------------------------------------------------- |
| Sponsors                 | Community  | `platform_configs:discover.sponsors` (usernames) | `iris discover sponsors add/list/remove`                 |
| Streamers (Twitch live)  | Content    | `platform_configs:discover.streamers` (handles)  | `iris discover streamers add/list/remove`                |
| Featured Producers       | Community  | `platform_configs:discover.producers` (usernames) | `iris discover producers add/list/remove`                |
| Curated Instrumentals    | Community  | `platform_configs:discover.instrumentals` (IDs)  | `iris discover instrumentals add/list/remove` (alias `beats`) |
| Open Opportunities       | Content + Community | Live `users_service_order_custom_request` query | `iris opportunities create/list/get/pull/push/diff/delete` |
| Investment Interests     | Opportunity detail | `opportunity_investment_interests` (per-opp) | `iris opportunities interest list/show`                  |
| Paid Tutorials           | Learning   | `tv.price_usd` + `magazine.price_usd > 0`        | `iris tutorials list/price <video\|article> <id>`        |
| Top Artists              | Content    | Auto-derived from `marketplaceData.profiles`     | **No CLI yet** — see Gaps below                          |
| Section visibility flags | All        | `platform_configs:discover.sections` (object)    | **No CLI yet** — edit via `iris config` or direct PUT    |

All `discover.*` config keys are read in one round-trip via the public endpoint:

```bash
curl https://raichu.heyiris.io/api/v1/public/discover-config | jq '.data'
```

## Quick reference — every command

### Sponsors (Community tab — yellow ring carousel)

```bash
$ iris discover sponsors list
$ iris discover sponsors add moore-life
$ iris discover sponsors remove moore-life
```

Sponsors get a yellow-ringed avatar carousel + their products and services flow through to the Community tab. Use this for paying brand partners — the visual treatment intentionally signals "endorsed."

### Streamers (Content tab — Twitch Live section)

```bash
$ iris discover streamers list
$ iris discover streamers add ninadaddyisback
$ iris discover streamers remove ninadaddyisback
```

Streamers are Twitch handles. The frontend pings the Twitch API to filter to whoever is live right now. Add aspirationally — only the live ones surface.

### Producers (Community tab — purple ring carousel)

```bash
$ iris discover producers list
$ iris discover producers add moore-life
$ iris discover producers remove moore-life
```

Producers are profile usernames. Featured at the top of the Community tab. Use for the music/beat production side. See [community-curation.md](community-curation.md) for the full lifecycle.

### Instrumentals (Community tab — track cards with audio player)

```bash
$ iris discover instrumentals list
$ iris discover instrumentals add 12345
$ iris discover instrumentals remove 12345
$ iris discover beats list   # alias
```

Instrumental IDs from `users_profiles_instrumentals`. Backend hydrates the track + producer profile server-side so the frontend renders cards with an inline `<audio>` player without N+1 fetches.

### Opportunities (Content + Community tabs — horizontal cards)

```bash
$ iris opportunities list
$ iris opportunities create   # interactive
$ iris opportunities get 469
$ iris opportunities pull 469      # download JSON locally
$ iris opportunities push 469      # upload local JSON edits
$ iris opportunities diff 469      # local vs live
$ iris opportunities delete 469
```

Opportunities are live records, not curation. Whatever's `is_public=true` and not expired shows up. Use the create flow to spin up a new gig; it auto-publishes if the deadline is in the future.

The detail page for each opportunity has Apply / Invest tabs — see investments below.

### Investment interests (action on opportunity detail page)

```bash
$ iris opportunities interest list                       # all opportunities
$ iris opportunities interest list --opportunity-id 469
$ iris opportunities interest list --status committed
$ iris opportunities interest show 1
```

Captured when visitors click **Invest in this Opportunity** on a detail page. See [discover-investments.md](discover-investments.md) for the full lifecycle and direct API usage.

Aliases: `iris opportunities interests`, `iris opportunities investors`.

### Paid tutorials (Learning tab — green price pill on cards)

```bash
$ iris tutorials list
$ iris tutorials price video 13667 --price=29.99
$ iris tutorials price article 4421 --price=15
$ iris tutorials price video 13667 --price=0    # unprice
```

Sets `price_usd` on a `tv` (video) or `magazine` (article) row. The card on the Learning tab auto-shows a green `$29.99` pill. See [learning-tutorials.md](learning-tutorials.md) for the full pipeline (and the deferred Stripe checkout work).

### Section visibility (turn whole sections on/off)

There's no dedicated CLI; flip via direct config write:

```bash
# Hide the Sponsors section without removing the entries
curl -X PUT "https://raichu.heyiris.io/api/v1/platform-config/discover.sections" \
  -H "Authorization: Bearer $FL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": {"sponsors": false}}'
```

The default for every section is `true`. The merged value is exposed at `data.sections` in `/discover-config`.

## Gaps (deliberately unbuilt)

### Featured Artists / Profiles — no CLI yet

The "Top Artists" section on the Content tab is currently **auto-derived** from `marketplaceData.profiles` (a generic profile feed) and deduplicated by ID with photo-presence filter. There's no `discover.featured_profiles` config key and no `iris discover artists add` command.

If/when curation is wanted, the work is small (mirror the sponsors pattern):

1. Add `discover.featured_profiles` to the config keys read in `PlatformConfigController::discoverConfig()` and to `DEFAULT_SECTIONS`
2. Hydrate the usernames server-side or let the frontend hit `getProfileData` per username (sponsors does the latter)
3. Add `iris discover artists add/list/remove` mirroring `iris discover producers` (~70 lines copy-paste in `platform-discover.ts`)
4. Replace `uniqueTopArtists` in the frontend with a curated list (or layer it on top: curated first, then auto-derived to fill)

### Reordering / pinning

All curated lists today are display-ordered by insertion. No `iris discover producers reorder` or `--pin` command. Workaround: `remove` + `add` to move to the end of the list, or PUT the whole array directly.

### Status workflow on investment interests

`iris opportunities interest update <id> --status=contacted` is not built. The status column exists and accepts the full enum (new → contacted → qualified → committed → funded / declined / withdrawn) — needs a 1-method controller endpoint + 1 CLI subcommand. ~30 lines.

### Discord notifications on investment interest

The capture controller calls `DiscordService::postInvestmentInterest($interest, $opportunity)` defensively, but the method doesn't exist on `DiscordService`. Add it the same way `postJobApplication` works for job applications.

### Stripe checkout for tutorials

The green price pill is visible, but clicking the card still goes to the free content page. Wiring is sketched in [learning-tutorials.md](learning-tutorials.md#whats-deferred).

## Architecture notes

**One config endpoint, multiple lists.** `/api/v1/public/discover-config` is the single read surface — sponsors + streamers + producers + hydrated instrumentals + section flags all come back in one call. The frontend's `fetchSponsorProfiles()` (despite the name) hydrates all four in parallel. Never add another `/api/v1/discover/foo-list` endpoint when you can extend `discoverConfig`.

**Curation lists vs entity tables.** Sponsors, streamers, producers, and instrumentals are *curation lists* — small arrays in `platform_configs`. Opportunities and tutorials are *entity tables* with their own CRUD. The CLI naming reflects this: `iris discover X` for curation lists; `iris X` for entities. Don't mix.

**`platform_configs` is the right place for small typed lists** (≤ a few hundred entries). For anything that needs query patterns, indexing, or per-row metadata, use a dedicated table. The investment interest capture and tutorial pricing both crossed that threshold; the curation lists did not.
