# How to: Capture investment interest on opportunities

## What this does

Every marketplace opportunity on FreeLabel is **dual-sided** — visitors can either apply to do the job (worker path) or express interest in funding it (investor path). When someone clicks **Invest in this Opportunity** on a detail page and submits the form, the platform captures their `name / email / amount USD / optional note` as a non-binding interest signal. You manage and act on those signals through the `iris opportunities interest` CLI.

## Prerequisites

- A live opportunity (use `iris opportunities list` to find one or `iris opportunities create` to make a new one)
- Authenticated (`iris-login` complete)
- The opportunity is reachable at `https://web.freelabel.net/marketplace/opportunity/{id}` — that's where the Invest tab lives

## The investment interest lifecycle

```
[1] CAPTURE      →  [2] CONTACT     →  [3] QUALIFY    →  [4] COMMIT     →  [5] FUND
     ↓                   ↓                   ↓                  ↓                  ↓
 Visitor fills      You reach out       They confirm         Soft yes,         Money in,
 invest form on     (DM, email,         genuine interest     terms agreed,     opportunity
 detail page        Loom, call)         and budget           paperwork sent    funded
 (status: new)      (contacted)         (qualified)          (committed)       (funded)
```

Terminal states: `funded`, `declined`, `withdrawn`.

## Steps

### 1. View all captured interests

```bash
$ iris opportunities interest list
```

Lists every investment interest across all opportunities, newest first. Each line shows the amount, investor name, opportunity title, status, and email. Aliases: `iris opportunities interests list`, `iris opportunities investors list`.

```bash
# Filter to one opportunity
$ iris opportunities interest list --opportunity-id 469

# Filter by status
$ iris opportunities interest list --status new
$ iris opportunities interest list --status committed

# Page size
$ iris opportunities interest list --limit 100
```

### 2. Inspect a single interest

```bash
$ iris opportunities interest show 1
```

Shows the full record — opportunity reference, investor contact, amount, note text, submission timestamp, and any contact log.

### 3. Direct API access (for scripts)

The capture endpoint is **public** — no auth required (it's how visitors POST from the form):

```bash
curl -X POST "https://raichu.heyiris.io/api/v1/marketplace/opportunities/{id}/investment-interest" \
  -H "Content-Type: application/json" \
  -d '{
    "investor_name": "Jane Investor",
    "investor_email": "jane@example.com",
    "amount": 500,
    "note": "Interested in the open-books model"
  }'
```

The listing endpoints require auth:

```bash
# Per-opportunity (with total_amount_usd in meta)
curl "https://raichu.heyiris.io/api/v1/marketplace/opportunities/{id}/investment-interests" \
  -H "Authorization: Bearer $FL_API_TOKEN"

# Global, with optional filters
curl "https://raichu.heyiris.io/api/v1/marketplace/investment-interests?status=new&opportunity_id=469" \
  -H "Authorization: Bearer $FL_API_TOKEN"
```

### 4. Drive interest with a deep link

The Invest tab can be auto-selected via URL:

```
https://web.freelabel.net/marketplace/opportunity/469?intent=invest
```

Use this in DMs, social posts, email campaigns — the visitor lands directly on the Invest form with no extra clicks. Pair with `iris opportunities create` to spin up a new opportunity, screenshot the detail page, and post the screenshot to Instagram/X with the deep-link in the bio. Replaces "DM me to invest" workflows.

## How it fits together

- **Frontend** — `pages/services/marketplace/opportunity/_id.vue` renders the Apply | Invest tabs. The Invest form posts to the public capture endpoint and shows a thank-you on success.
- **Backend** — `App\Models\Marketplace\OpportunityInvestmentInterest` + `OpportunityController::submitInvestmentInterest|listInvestmentInterests|listAllInvestmentInterests`.
- **Storage** — `opportunity_investment_interests` table; FK to `users_service_order_custom_request` (cascade delete) and `users` (set null on delete for the optional `investor_user_id`).
- **CLI** — `iris opportunities interest list/show` reads through the auth-gated GET endpoints.

## What's deferred

- Status transitions (`iris opportunities interest update <id> --status=contacted`) — not yet wired
- Discord notification on capture — `OpportunityController` calls `DiscordService::postInvestmentInterest` defensively but the method doesn't exist yet; add it when the comms volume justifies it
- Stripe handoff for `committed → funded` — manual for now; the field set is sufficient to record outcomes after the fact
