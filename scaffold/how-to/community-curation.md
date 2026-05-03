# How to: Curate producers and instrumentals on the Community tab

## What this does

The **Community tab** on the Discover page hosts curated lists of FreeLabel producers and the instrumentals they've published. Both lists are CLI-managed — there's no admin UI, by design (CLI-first survival mode). Add a producer username and they appear in the Featured Producers carousel. Add an instrumental ID and it appears in the Curated Instrumentals carousel with an inline audio player and a link back to the producer.

The two surfaces complement each other: producers give visibility, instrumentals give distribution.

## Prerequisites

- Authenticated (`iris-login` complete)
- For producers: a known **profile username** (e.g. `moore-life`)
- For instrumentals: a known **instrumental ID** from the `users_profiles_instrumentals` table

## How storage works

Both lists live as `platform_configs` rows (the same table that backs `iris discover sponsors` and `iris discover streamers`):

| Config key                    | Value type                | Frontend treatment                                 |
| ----------------------------- | ------------------------- | -------------------------------------------------- |
| `discover.producers`          | array of usernames        | Frontend hydrates each via `$core.getProfileData`  |
| `discover.instrumentals`      | array of instrumental IDs | **Backend hydrates server-side** in `discoverConfig` so the frontend gets full instrumental + producer profile in one round-trip |

The `discoverConfig` controller method returns sponsors + streamers + producers + instrumentals together in one response — the frontend makes a single fetch.

## Steps

### 1. Featured producers

```bash
# List
$ iris discover producers list
$ iris discover producers list --json   # for scripts

# Add (username comes from the profile URL — /@moore-life)
$ iris discover producers add moore-life

# Remove
$ iris discover producers remove moore-life
```

Producers render as **purple-ringed avatar carousel** at the top of the Community tab (visible when the sub-filter is `all` or `people`). Empty state shows the CLI hint inline.

### 2. Curated instrumentals

```bash
# List (shows hydrated track info: title, producer username)
$ iris discover instrumentals list
$ iris discover beats list   # alias

# Add by track ID
$ iris discover instrumentals add 12345

# Remove
$ iris discover instrumentals remove 12345
```

Instrumentals render as **flex-scroll cards** with an inline `<audio>` player (lazy-loaded via `preload="none"`) and a link to the producer profile. Visible when the Community sub-filter is `all` or `products`.

## Direct API access

Both lists are exposed publicly via `discover-config`:

```bash
curl https://raichu.heyiris.io/api/v1/public/discover-config | jq '.data | {producers, instrumentals}'
```

Sample response:

```json
{
  "producers": ["moore-life", "another-producer"],
  "instrumentals": [
    {
      "id": 12345,
      "title": "Late Night Vibe",
      "description": "...",
      "audio_url": "https://...",
      "photo": "https://...",
      "producer": {
        "pk": 9203690,
        "name": "Producer Name",
        "username": "producer-handle",
        "photo": "https://..."
      }
    }
  ]
}
```

The CLI add/remove commands write through the auth-gated platform config endpoint:

```bash
# Read current
curl "https://raichu.heyiris.io/api/v1/platform-config/discover.producers" \
  -H "Authorization: Bearer $FL_API_TOKEN"

# Replace whole list
curl -X PUT "https://raichu.heyiris.io/api/v1/platform-config/discover.producers" \
  -H "Authorization: Bearer $FL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": ["moore-life", "another-producer"]}'
```

## How it fits together

- **Backend** — `App\Http\Controllers\Api\PlatformConfigController::discoverConfig()` reads both keys, hydrates instrumentals via `Instrumental::with('profile')->whereIn('id', $ids)->get()`, returns the lot
- **Frontend** — `pages/discover/index.vue`'s `fetchSponsorProfiles()` (despite the name, it now fetches all four lists in one call) populates `producerProfileData` + `curatedInstrumentals`; the Featured Producers and Curated Instrumentals sections render from those in the Community tab template
- **CLI** — `iris discover producers add/list/remove` and `iris discover instrumentals add/list/remove` (alias `beats`) — both use the generic `readConfigList` / `writeConfigList` helpers in `platform-discover.ts`

## Workflow: feature a producer's drop

1. The producer publishes new instrumentals to their profile (existing flow)
2. Pick the standout track ID (look at the `users_profiles_instrumentals` table or the producer's profile page)
3. `iris discover producers add <their-username>` (if not already featured)
4. `iris discover instrumentals add <track-id>`
5. Both surfaces light up on the next page load of `web.freelabel.net/discover` Community tab

## What's deferred

- **Visibility toggles** — `discover.producers` and `discover.instrumentals` are always shown if non-empty. To hide them temporarily without removing entries, you'd need to flip `sections.producers` / `sections.instrumentals` in the platform config — no CLI helper for that yet
- **Ordering** — the array order is the display order; no `iris discover producers reorder` command
- **Audio player polish** — uses native `<audio controls>` for now; a custom player with waveform would be its own design pass
- **Stats** — no plays/views attribution back to producers from the Community tab carousel (a "trending instrumentals" surface would be a separate curation list)
