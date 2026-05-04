# How to: Turn an opportunity into a crowdfunded pitch

## What this does

A marketplace opportunity isn't just a job posting — it's a **pitch page**. Each opportunity can declare a funding goal, multiple paid roles (with pay rate + equity per role), pitch sections, board members (founders/advisors), milestones, and a public payout ledger. The detail page then renders the whole thing as an open-source Shark Tank: visitors see who's behind it, what's funded, what roles are open, who's been paid, and can either invest or apply to a specific role.

This recipe covers authoring those rich opportunity pages from the CLI.

## Canonical example

The reference implementation is the **Smart Notebook — Encrypted Personal Server** opportunity (Andrew Escher / Good Deals Hardware). It exercises every field — funding goal, 4 roles with mixed pay types, 6 pitch sections, board members, 4 milestones, sample backer.

Seed it locally:

```bash
docker compose exec api php artisan atlas:seed-opportunity-schemas
docker compose exec api php artisan db:seed --class=SmartNotebookOpportunitySeeder
```

It seeds with `preview_mode=true` — the page renders fully but Apply/Invest are disabled and a yellow `PREVIEW — NOT LIVE` banner sits at the top. Flip `preview_mode=false` (via `iris opportunities push` or directly in DB) to make it live.

## Preview mode

Set `preview_mode=true` on any opportunity to:

- Render a `PREVIEW — NOT LIVE` banner at the top of the page
- Show a `PREVIEW` pill next to the status badge
- Disable the per-role Apply buttons (label changes to "Preview")
- Replace the bottom Apply/Invest tabs with a "Preview Mode" notice

Use this when you want a shareable URL for founder/investor feedback before opening real applications.

## Prerequisites

- Authenticated (`iris-login` complete)
- An opportunity exists (`iris opportunities list` or `iris opportunities create`)
- You **own** the opportunity — the board/milestone endpoints check ownership. If you need to author someone else's opportunity, you'll need to either reassign it (`PATCH /opportunities/{id}/reassign`) or run via tinker on the API.

## What lives on a crowdfunded opportunity

| Field | Type | Where it shows on the page |
|---|---|---|
| `funding_goal_cents` | int | Funding Progress bar (raised vs goal) |
| `equity_pool_bps` | int (basis points: 500 = 5%) | Funding Progress stat tile |
| `roles[]` | JSON array | Open Roles cards — each with title, pay, equity, count |
| `pitch_sections[]` | JSON array `[{heading, body}]` | The Pitch section |
| Board members | AtlasRecord (`opportunity_board_member`) | The Team → Board lane |
| Milestones | AtlasRecord (`opportunity_milestone`) | Milestones panel |
| Payouts | AtlasRecord (`opportunity_payout`) | Open Books ledger |
| Investment interests | `OpportunityInvestmentInterest` rows | The Team → Backers + funding raised total |
| Hired workers | `OpportunityApplication` (status=accepted, with `role_key`) | The Team → Builders |

## Steps

### 1. Create the opportunity with pitch fields

Inline form (interactive prompts for missing values):

```bash
$ iris opportunities create \
    --title "Smart Notebook MVP" \
    --description "AI-powered notebook that turns handwritten notes into action." \
    --funding-goal 10000 \
    --equity-pool-pct 5 \
    --roles-file ./roles.json \
    --pitch-file ./pitch.json
```

`roles.json` — each role needs a stable `key` (used to track filled vs open):

```json
[
  {
    "key": "ios_engineer",
    "title": "iOS Engineer",
    "count": 1,
    "pay_type": "hourly",
    "pay_amount": 60,
    "equity_bps": 100,
    "description": "Build the iOS app that pairs over BLE. SwiftUI + CoreData."
  },
  {
    "key": "industrial_designer",
    "title": "Industrial Designer",
    "count": 1,
    "pay_type": "fixed",
    "pay_amount": 2000,
    "equity_bps": 150,
    "description": "Design the notebook + pen housing. Deliver CAD + prototype."
  },
  {
    "key": "brand_strategist",
    "title": "Brand Strategist",
    "count": 1,
    "pay_type": "sweat",
    "pay_amount": 0,
    "equity_bps": 50,
    "description": "Name, positioning, launch story. Sweat equity only."
  }
]
```

`pay_type` is one of `hourly | fixed | sweat`. `equity_bps` is basis points (100 = 1%, 50 = 0.5%).

`pitch.json`:

```json
[
  {"heading": "The Problem", "body": "Founders carry notebooks because they think faster than they type — but those notes never make it into action."},
  {"heading": "The Solution", "body": "A smart notebook that captures every page, syncs to the cloud, and uses AI to turn handwriting into tasks."},
  {"heading": "Why Now", "body": "On-device AI just got good enough to OCR messy handwriting in real time."},
  {"heading": "The Ask", "body": "Raising $10K to fund prototype + pre-orders. Open cap table."}
]
```

### 2. Update an existing opportunity with pitch fields

`iris opportunities push` round-trips the full JSON — pull, edit, push:

```bash
$ iris opportunities pull 469
✓ Pulled to .iris/opportunities/469-smart-notebook-mvp.json

# edit the file: add funding_goal_cents, equity_pool_bps, roles[], pitch_sections[]
$ vim .iris/opportunities/469-smart-notebook-mvp.json

$ iris opportunities push 469
✓ Pushed
```

`push` forwards `funding_goal_cents`, `equity_pool_bps`, `roles`, `pitch_sections` to the API along with title/description/skills/budget.

### 3. Add board members

```bash
$ iris opportunities board add 469 \
    --name "Marcus Chen" \
    --role "Founder" \
    --bio "Industrial designer turned founder." \
    --avatar-url "https://i.pravatar.cc/200?img=12" \
    --equity-pct 60
```

`--role` is freeform (`Founder | Co-founder | Advisor | Mentor | Board`). `--equity-pct` accepts decimals (`0.5` for half a percent).

```bash
$ iris opportunities board list 469
$ iris opportunities board remove 469 <recordId>
```

### 4. Add milestones

```bash
$ iris opportunities milestones add 469 \
    --title "Working Prototype" \
    --description "BLE pairing + basic capture working end-to-end." \
    --target-date 2026-06-01 \
    --status in_progress \
    --unlock-funding 2000 \
    --order 1
```

`--status` is one of `planned | in_progress | complete`. `--unlock-funding` is in USD — the page can render "unlocks at $2K raised" markers.

```bash
$ iris opportunities milestones list 469
$ iris opportunities milestones remove 469 <recordId>
```

### 5. Verify the rendered payload

```bash
$ curl -s "https://raichu.heyiris.io/api/v1/marketplace/opportunities/469" | jq '{
    funding_goal_cents,
    raised_usd,
    investor_count,
    applicant_count,
    roles: .roles | length,
    board: .team.board | length,
    builders: .team.builders | length,
    backers: .team.backers | length,
    milestones: .milestones | length,
    payouts: .payouts | length
  }'
```

The response includes the full enriched view: `roles[]` with `filled_count` + `open_count` per role, `team` split into board / builders / backers lanes, `payouts[]` ledger entries.

### 6. View the live page

```
https://web.freelabel.net/marketplace/opportunity/469
```

Sections render conditionally — empty fields collapse to nothing. So a freshly-created opportunity with no pitch data looks identical to a plain job posting until you populate it.

## How filled vs open works

Each role declares a `count` (how many slots). When someone applies and you accept their application **with** the matching `role_key`, the page shows "1 filled / 0 open" and disables the Apply button. The Apply button on a role card pre-fills the application form's cover letter with `Applying for: {role.title}` and submits with `role_key` so the count tracks correctly.

To accept an application into a role from the API:

```bash
curl -X PATCH "https://raichu.heyiris.io/api/v1/marketplace/applications/{applicationId}/status" \
  -H "Authorization: Bearer $FL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "accepted"}'
```

The application's `role_key` was stored when the user clicked Apply on a specific role card. As long as the application has `status=accepted` and a non-null `role_key`, it counts toward filled.

## Payouts (Open Books ledger)

The page shows every payout publicly. There's no CLI command for these yet — author via API or tinker:

```php
// railway ssh --service fl-api
\App\Models\Atlas\AtlasRecord::create([
  'user_id' => 1,
  'schema_id' => \App\Models\Atlas\AtlasSchema::where('slug', 'opportunity_payout')->value('id'),
  'schema_version' => 1,
  'external_id' => 'opportunity:469#p1',
  'status' => 'active',
  'data' => [
    'recipient_name' => 'Marcus Chen',
    'recipient_user_id' => 42,
    'role_key' => 'industrial_designer',
    'role_label' => 'Industrial Designer',
    'amount_cents' => 100000,
    'pay_type' => 'fixed',
    'paid_at' => '2026-05-15',
    'status' => 'sent',
    'note' => 'Milestone 1 — CAD draft delivered.'
  ],
]);
```

Statuses: `scheduled | sent | received`.

## Common errors

**`403 Only the opportunity owner can edit board/milestones`**
The board/milestones endpoints check `opportunity.user_id === auth.user.id`. If you're not the owner, either reassign the opportunity (`PATCH /opportunities/{id}/reassign`) or use tinker.

**`500 Schema 'opportunity_board_member' not seeded`**
Run on the API container: `php artisan atlas:seed-opportunity-schemas`. This creates the three Atlas schemas (`opportunity_board_member`, `opportunity_milestone`, `opportunity_payout`).

**Page renders but new sections are missing**
Each section is gated by `v-if` on its data. If `funding_goal_cents` is null and `roles[]` is empty, the page looks like a plain job posting. Populate the fields and refresh — there's no SSR cache between you and the live page for this route.

**`iris opportunities push` doesn't update roles**
The `push` command forwards `funding_goal_cents`, `equity_pool_bps`, `roles`, `pitch_sections` only when those keys exist in your local JSON. Make sure your file has them at the top level (not nested under `data` or `attributes`).

## How it fits together

- **Opportunity model**: `app/Models/Marketplace/Opportunity.php` — fillable includes the 4 new fields via `CustomRequest::$fillable`. Helpers: `boardMembers()`, `milestones()`, `payouts()`, `team()`, `filledCountsByRole()`, `raisedCents()`, `investorCount()`.
- **Atlas schemas**: stored in `atlas_schemas` table. Records linked to an opportunity via `external_id = "opportunity:{id}"` or `"opportunity:{id}#{subkey}"`.
- **Controller**: `OpportunityController::show()` enriches the response with `roles` (with filled/open counts), `team`, `payouts`, `board_members`, `milestones`, `raised_usd`, `investor_count`, `applicant_count`.
- **Routes**: `POST/DELETE /opportunities/{id}/board`, `POST/DELETE /opportunities/{id}/milestones` (auth + owner-gated). All other CRUD via the existing opportunities endpoints.
- **Frontend**: `pages/services/marketplace/opportunity/_id.vue` — Nuxt 2 SSR page. Renders Funding Progress, Open Roles, The Pitch, The Team (Board/Builders/Backers lanes), Open Books ledger.

## Related recipes

- `discover-investments.md` — capturing investor interest from the public form (the lead-capture side of this same flow)
- `discover.md` — surfacing opportunities on the discover page
- `lead-to-proposal.md` — turning a hired worker into a contracted deliverable
