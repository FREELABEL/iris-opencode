# How to: use Pulse — the readiness engine that proves IRIS is delivering

## What this does
Pulse is the autonomous readiness scoring engine. Every 15 minutes, the platform computes a 0–100 score for each engaged customer based on whether their requirements pass, their agents are alive, their comms are flowing, and their setup is complete. A daily 8 AM Central email digest summarizes the score + 24h activity. Use Pulse to prove (to yourself, your customer, and your investors) that IRIS is actually working.

**One score. Three triggers (cron, CLI, daily email). Same number everywhere.**

## Prerequisites
- IRIS CLI authenticated (`iris auth login`)
- A lead in the CRM you want to monitor (`iris leads create` or already exists)
- Bridge daemon running on the customer's machine if you want comms ingest (`iris-daemon status`)

## Steps

### 1. Add a Pulse requirement to a lead
A "requirement" is a Playwright check you want to run against a customer's deliverables — a URL test, a form-submission probe, a heartbeat check, etc. Adding one enrolls the lead in Pulse.

```bash
iris leads requirements create <lead_id> \
  --name "Booking page returns 200" \
  --severity high \
  --frequency-minutes 60 \
  --script-content "$(cat scripts/check-booking-page.js)"
```

Severity weights: `blocker=4, high=3, medium=2, low=1` — failing a blocker drags the score 4× more than failing a low.

`frequency_minutes` makes it auto-run on schedule. Omit to run manually only.

### 2. View the score for a lead

```bash
iris leads pulse <lead_id>
```

Output includes:

```
Pulse:    72/100  attention
Trend:    ▁▃▄▆█  (8 snapshots)
Signals:  req 80/100 · live 100/100 · comms 60/100 · cfg 75/100
```

The four signals are weighted **40% requirements / 25% liveness / 20% comms freshness / 15% config**. Null signals (e.g. unconverted lead with no liveness data) drop their weight and the rest renormalize.

### 3. Run requirements manually

```bash
iris leads requirements run <lead_id> <requirement_id>     # one
iris leads requirements run-all <lead_id>                  # all for this lead
```

Requirements dispatch as `custom_playwright` Hive tasks. Bridge daemon picks them up and reports pass/fail back into `hive_config.last_status`.

### 4. Account-level rollup

```bash
curl -H "Authorization: Bearer $FL_API_TOKEN" \
  https://raichu.heyiris.io/api/v1/users/<user_id>/readiness?include=history \
  | jq .
```

Returns the user's score aggregated across all their leads, with up to 30 prior snapshots for trend rendering.

### 5. Receive the daily digest
Already wired. Every paying user with at least one Pulse requirement gets an email at 8 AM Central. Subject: `IRIS daily digest — X/100 (band)`. Body: score, signals breakdown, 24h diary excerpt, dashboard CTA.

To test-send manually:

```bash
# In production (via Railway scheduler — fires automatically)
# OR locally for dry testing:
docker compose exec api php artisan digest:send-daily --user=<user_id> --dry-run
```

## How the autonomous loop works

```
Every 15 min on the fl-api scheduler container:
  pulse:tick fires
    → snapshots readiness for engaged users + leads (anti-spam dedup
      skips inserts when score equals prior snapshot)
    → for each user with stale comms (no row in last 30 min),
      dispatches a comms_sync Hive task with their stale lead IDs
    → comms_sync POSTs to iris-api, lands in iris_db.node_tasks

Bridge daemon on the user's machine:
  → polls and receives comms_sync tasks
  → spawns: ~/.iris/bin/iris leads sync-comms <ids…> --days 30 --limit 50
  → iris fetches Gmail (Composio) + iMessage (bridge SQLite) + Apple Mail
  → POSTs each batch to /api/v1/atlas/comms/ingest
  → freelabelnet.lead_comms accumulates the messages

Next pulse:tick reads the fresh lead_comms:
  → comms_freshness signal recomputes (inbound <7d=100, <30d=60, …)
  → score recomputes
  → if changed, new readiness_runs row inserted (fuels the sparkline)

Daily at 8 AM Central:
  digest:send-daily fires
    → eligibility = users with at least one Pulse requirement
    → for each, builds HTML from readiness payload + diary
    → sends via TransactionalEmailService → Resend
```

## Common operations

### Check what's currently dispatching

```bash
# All recent comms_sync Hive tasks (server side):
iris hive tasks list --type comms_sync --limit 5
```

### Force a tick now (don't wait 15 min)

```bash
docker compose exec api php artisan pulse:tick
```

Output: `Snapshots — users: N new, M unchanged | leads: N new, M unchanged`
plus `Comms sync — users: N dispatched, M skipped`.

### Backfill comms for a specific lead

```bash
iris leads sync-comms <lead_id> --days 30 --limit 50
```

Silent batch ingest — emits one JSON line per lead. Use this when:
- A new lead is added and you want history immediately
- The autonomous loop hasn't picked them up yet
- You're testing the pipeline

### See the trend visually in TUI

```bash
iris leads pulse <lead_id>
```

Looks for `Trend:` line. Eight unicode block characters (`▁▂▃▄▅▆▇█`) representing the last 8 readiness_runs snapshots — leftmost is oldest, rightmost is most recent. Empty until at least 2 snapshots exist.

## What feeds each signal

```
  requirements (40%)   bloq_workflows execution_mode='requirement'
                        with hive_config.last_status:
                          'passed'/'completed' = passing
                          'failed'             = failing
                          null                  = untested
                        weighted by hive_config.severity

  liveness (25%)        bloq_agents.last_heartbeat_at < 2h ago
                        AND health_status NOT IN (paused_budget, paused)

  comms_freshness (20%) lead_comms latest sent_at:
                          inbound <7d  = 100
                          inbound <30d = 60
                          inbound <90d = 30
                          outbound only = 30
                          nothing       = 0

  config (15%)          integrations.count + users.stack_profile present
```

## Cross-scope traversal (paying users)

When a lead has `som_leads.converted_user_id` set (pointing to the User row they became), the lead's score INHERITS the user's liveness + config signals. Same person, two database rows, one score.

```bash
# To convert a lead → user (sets converted_user_id):
iris customer setup <lead_id>    # FUTURE — see bug #80910
```

⚠️ As of May 2026, `iris customer setup` does NOT yet populate `converted_user_id`. The migration shipped, the readiness service traverses it, but the conversion flow doesn't write to it. Bug #80910 tracks this.

## Run `iris scan` to populate the config signal

The customer's machine has installed apps, sync folders, browser profiles. `iris scan` profiles all that and POSTs a stack profile to the backend. Boosts the config signal +20 points.

```bash
iris scan                # macOS only (v1.3.28+); profiles + posts
iris scan --dry-run      # show what would be sent, don't post
```

The profile lands at `users.stack_profile` (JSON column). ClientReadinessService reads `stack_profile_present` to award config points.

## Gotchas

### Bridge daemon must run the new iris binary
After upgrading iris (`iris upgrade`), the daemon process has the OLD binary cached. Restart it:

```bash
iris-daemon restart
```

Without this, comms_sync tasks complete in ~200ms with empty output (because bridge spawned `iris` which wasn't found at the daemon's PATH).

### `withoutOverlapping()` + Redis = stuck cron (don't add it)
The fl-api Redis cache is shared across containers. If a container dies mid-tick, the lock persists forever and Laravel skips the schedule silently. We removed it from `pulse:tick` and `digest:send-daily`. Don't add it back without a TTL. Bug #80911.

### Anti-spam dedup of `readiness_runs`
The cron only inserts a snapshot if the score CHANGED from the previous snapshot. So you'll see far fewer than 96 rows/day per user. That's intentional — keeps the table small and the sparkline meaningful.

### Comms freshness staleness threshold = 30 min
A lead is "stale" (eligible for re-dispatch) if its newest `lead_comms.ingested_at` is older than 30 minutes. Tune in `RunDueRequirements::dispatchCommsSyncTasks` if you find it too chatty or too quiet.

### Eligibility for the daily digest
Currently: any user with at least one `bloq_workflows.execution_mode='requirement'`. Will be tightened to "paying customers only" once Stripe webhook → `users_subscriptions` is wired (bug #80909).

## Tables involved

| Table | Purpose | Owner |
|---|---|---|
| `bloq_workflows` (where `execution_mode='requirement'`) | Requirements + their schedule + last status | fl-api |
| `lead_comms` | Ingested iMessage / Gmail / Apple Mail messages | fl-api |
| `bloq_agents` | Heartbeat status, health_status | fl-api |
| `integrations` | Connected OAuth services | fl-api |
| `users.stack_profile` (JSON column) | Output of `iris scan` | fl-api |
| `readiness_runs` | Append-only score history (per scope+id) | fl-api |
| `iris_db.node_tasks` | Hive task queue (where comms_sync lives) | iris-api |
| `iris_db.compute_nodes` | Bridge daemons registered to users | iris-api |
| `som_leads.converted_user_id` | Cross-scope link (lead → user) | fl-api |

## Verifying the loop is firing

```bash
# 1. Cron registered?
docker compose exec api php artisan schedule:list | grep -E "pulse:tick|digest"

# 2. Recent snapshots in the trend log?
mysql -e "SELECT scope, scope_id, score, created_at FROM readiness_runs ORDER BY id DESC LIMIT 5"

# 3. Recent comms_sync Hive tasks (server side)?
mysql -e "SELECT id, status, created_at FROM iris_db.node_tasks WHERE type='comms_sync' ORDER BY created_at DESC LIMIT 5"

# 4. Bridge picking them up?
iris-daemon status   # should show "active" + recent heartbeat
```

If snapshots are appearing every 15 min and comms_sync tasks are completing in 5–10 seconds (not 200ms), the loop is healthy.

## What this unlocks commercially

Pulse is the proof-of-value layer. Stop being an agency that sells AI; start being a workforce platform that emails every customer a daily readiness score. The score moves on requirement passes, comms freshness, agent liveness, integration completeness. When a customer's score drops, you both see it and act before they churn. When it climbs to healthy, you have a screenshot for your investor deck.

This is the single mechanism that turns "we built you AI agents" (intangible) into "your account scored 87/100 yesterday, here's what's failing" (tangible, measurable, monthly-recurring-revenue-defending).
