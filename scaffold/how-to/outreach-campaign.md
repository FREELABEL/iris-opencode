# How to: Run an outreach campaign (SOM pipeline)

## What this does

Runs the **Sales Operations Mesh (SOM)** pipeline end-to-end: discover prospects on social platforms → enrich profiles with bio/follower data → dispatch DMs or comments via authenticated browser sessions. This is the highest-revenue user flow in IRIS.

## Prerequisites

- Authenticated: `~/.iris/sdk/.env` exists (run `iris-login` first — see `iris-login.md`)
- Playwright installed in the project: the SOM scrapers use Playwright. From a fresh repo: `npm install -D @playwright/test && npx playwright install`
- A logged-in browser session for each platform you want to use:
  - LinkedIn: `tests/e2e/linkedin-auth.json` (create via `iris run save-linkedin-session` or the helper spec)
  - Twitter: equivalent session file
  - Instagram: equivalent session file
- A target list (URL, hashtag, account, or search query) — IRIS will discover from there

## The 4-step pipeline

```
[1] DISCOVER  →  [2] ENRICH  →  [3] DISPATCH  →  [4] FOLLOW-UP
```

Each step is a separate command so you can resume or rerun any stage.

## Steps

### 1. Discover prospects

```bash
$ npm run som:discover -- --platform=linkedin --query="founder ai startup" --limit=50
```

Or use the all-in-one batch runner that discovers + enriches + dispatches in parallel across courses, creators, and dj segments:

```bash
$ npm run som:all
```

This is defined in `tests/e2e/som-all.js` and runs the discover → enrich → dispatch chain for the configured segments. Default segments are `courses`, `creators`, `dj` and they run in parallel.

### 2. Enrich (always-on)

Bio capture, follower counts, category, verified status, and profile URL are scraped automatically as part of discover. The data lands in the leads database and is queryable via `iris platform-leads list --recent`.

### 3. Dispatch outreach

```bash
$ DRY_RUN=1 npm run som:dispatch -- --platform=linkedin --segment=creators
```

`DRY_RUN=1` is **critical for the first run** — it skips the "Mark done" + "Complete" actions so leads stay eligible for a real run after you verify the message looks right.

To enable warmup behavior (likes the lead's recent post + follows them before sending the DM, which dramatically improves response rates):

```bash
$ npm run som:dispatch -- --platform=linkedin --segment=creators --warmup=1
```

Or `--engage=1` as an alias.

When ready for real:

```bash
$ npm run som:dispatch -- --platform=linkedin --segment=creators --warmup=1
# (no DRY_RUN)
```

### 4. Follow-up via Hive (optional)

If you want the SOM pipeline to run on a schedule across multiple machines, dispatch it as a Hive task:

```bash
$ iris hive task dispatch --type=som_batch --schedule="0 9 * * *"
```

This requires the Hive daemon to be running on at least one machine. See `hive-dispatch.md`.

When a `discover` task completes on a Hive node, the daemon **auto-chains** to a `som_batch` task (runs `npm run som:all`). To disable auto-chain: set `config.chain_outreach: false` on the daemon.

## Expected output (success)

```
✓ Discovered 47 prospects (linkedin)
✓ Enriched 47/47 profiles
✓ Dispatched 12 messages (35 skipped: already contacted, ineligible, or in cooldown)
✓ Logged to ~/.iris/logs/som-2026-04-08.log
```

## Common errors

### `Playwright: browser not installed`

**Fix:** `npx playwright install chromium`

### `Auth session expired (linkedin-auth.json)`

**Cause:** LinkedIn invalidated the cookie session. Happens every 1-4 weeks.
**Fix:** Re-record the session: `npm run test:e2e -- save-linkedin-session.spec.ts`. The spec opens a real browser, you log in manually, and it saves cookies to `tests/e2e/linkedin-auth.json`.

### `Rate limited by linkedin`

**Cause:** Too many actions too fast. LinkedIn is the most aggressive about this.
**Fix:** Reduce `--limit` to 10-20 per run, run no more than 3-4 times per day per account, and **always use `--warmup=1`** to look more human.

### Dispatch sends 0 messages but discover found 47

**Cause:** All 47 leads are already in the contacted/cooldown table.
**Fix:** `iris platform-leads list --recent --status=eligible` to see how many are actually eligible. Adjust the query to find fresh prospects.

### `DRY_RUN=1` runs successfully but real run does nothing

**Cause:** In DRY_RUN mode the "Mark done" step is skipped — but the eligibility filter still runs. If the leads were marked as contacted by a previous real run, they're filtered out.
**Fix:** This is working as designed. Discover new prospects.

## Files involved (reference)

- `tests/e2e/som-all.js` — batch runner
- `tests/e2e/batch-with-login.spec.ts` — the dispatch logic with warmup support
- `tests/e2e/helpers/providers/*-provider.ts` — per-platform scrapers (linkedin, twitter, instagram, threads)
- `tests/e2e/leadgen-scraper.spec.ts` — discovery spec

## Related recipes

- `iris-login.md` — must be done first
- `hive-dispatch.md` — to run SOM on a schedule across machines
- `lead-to-proposal.md` — what to do when an outreach reply turns into a deal
