# How to: Manage deals — track, remind, and recover payment pipeline

## What this does

The **`iris deals`** command group gives you a single surface to manage your entire payment pipeline: view all active deals, check individual deal status, send reminders, and trigger win-back sequences for stale deals. Behind the scenes, the heartbeat agent also monitors this pipeline autonomously and drafts follow-up messages for your review.

## Prerequisites

- Authenticated (`iris-login` complete — see `iris-login.md`)
- At least one lead with a payment gate created (see `payment-gate-contracts.md`)
- (Optional) Heartbeat agent with `nurture_mode: true` for autonomous deal recovery

## The deal lifecycle

```
[1] CREATE GATE  →  [2] TRACK STATUS  →  [3] REMIND  →  [4] RECOVER  →  [5] CLOSED
     ↓                    ↓                   ↓              ↓               ↓
 iris deals create    iris deals status    iris deals     iris deals      Auto-completes
 + contract URL       contract? payment?   remind         recover         on Stripe
 + proposal URL       reminders sent?      (next D+N)     (all remaining) webhook
 + Stripe checkout    days open?
 + D+1/D+3/D+7 seeded
```

## Steps

### 1. View all active deals

```bash
$ iris deals list
```

Shows every lead with an active (unpaid) payment gate: deal status, amount, days open, reminders sent. Includes total pipeline value.

```bash
# Filter by bloq
$ iris deals list --bloq 40

# JSON output (pipe to jq, scripts, dashboards)
$ iris deals list --json
```

### 2. Check a specific deal

```bash
$ iris deals status 15336
```

Shows full detail: contract signed/pending, payment received/pending, reminders sent/total, auto-send on/off, and all URLs (proposal, contract, Stripe checkout).

### 3. Create a new deal

```bash
# Simple: one-time payment
$ iris deals create 15336 -a 1500 -s "Website redesign" -b 40

# With packages (multi-tier proposal)
$ iris deals create 15336 -a 250 -s "Choose your plan" --packages 5,6 -b 40

# Recurring billing
$ iris deals create 15336 -a 250 -s "Monthly retainer" -i monthly -b 40

# Disable auto-reminders (manual follow-up only)
$ iris deals create 15336 -a 1500 -s "Custom project" --no-auto-remind -b 40
```

Aliases: `iris deals gate`, `iris deals invoice`.

### 4. Send a reminder

```bash
$ iris deals remind 15336
```

Triggers the next pending D+1/D+3/D+7 reminder step immediately. The reminder is marked `automation_status = scheduled` and picked up by the queue worker. A note is logged on the lead timeline.

Alias: `iris deals nudge`.

### 5. Win-back a stale deal

```bash
$ iris deals recover 15336
```

For deals that have gone cold (7+ days, no payment). Fires all remaining reminder steps in sequence. Checks deal status first — skips if already paid.

Alias: `iris deals winback`.

### 6. Let the heartbeat do it automatically

If your agent has `nurture_mode: true`:

1. The heartbeat sees all active payment gates in its prompt
2. It identifies leads with `awaiting_payment` status, stale deals (7+ days), and overdue reminders
3. It drafts `payment_followup` messages via `draft_nurture_message`
4. Messages go to the review queue (pending your approval)

To enable:
- Toggle in the UI: Board → Heartbeat Config → "Lead Nurture Mode"
- Or via API: PATCH agent settings with `nurture_mode: true`

To review and approve drafts:
```bash
$ iris outreach approve
```

Or approve in the web UI: Board → Outreach → Pending tab.

## Expected output

```bash
$ iris deals list
Active Deals — 3 total | Pipeline: $7,750.00
  ────────────────────────────────────────────────────────────
  #15336  CatoDrive @ Maxx Shoaib
       PENDING  $250.00  21d open  reminders: 0/3
       https://heyiris.io/proposal/3469b42b...

  #15400  Tiron Aero @ Jerome Williams
       AWAITING PAYMENT  $6,000.00  14d open  reminders: 2/3
       https://heyiris.io/proposal/a1b2c3d4...

  #15422  Cottonwood Creek Brewery
       AWAITING CONTRACT  $1,500.00  3d open  reminders: 0/3
  ────────────────────────────────────────────────────────────

$ iris deals status 15336
Deal Status — Lead #15336
  ────────────────────────────────────────────────────────────
  Status:     PENDING
  Amount:     $250.00
  Scope:      CatoDrive — Phase 1 Website Launch...
  Contract:   Pending
  Payment:    Pending
  Reminders:  0/3 sent
  Auto-send:  Yes

  Proposal URL:  https://heyiris.io/proposal/3469b42b...
  Contract URL:  https://heyiris.io/sign/3ffe4062...
  ────────────────────────────────────────────────────────────

$ iris deals remind 15336
✓ Reminder "Day 1 — Friendly follow-up" scheduled for immediate send
  Step:  Day 1 — Friendly follow-up
  Lead:  CatoDrive (#15336)

$ iris deals recover 15400
✓ Reminder 1: Day 7 — Final notice sent
Recovery sequence triggered: 1 reminder(s) scheduled for lead #15400
Track progress: iris deals status 15400
```

## Deal status values

| Status | Meaning | Action |
|--------|---------|--------|
| `awaiting_both` | Neither contract signed nor payment received | Send proposal link, follow up |
| `awaiting_contract` | Payment received but contract not signed | Send contract signing link |
| `awaiting_payment` | Contract signed but payment pending | Send payment reminder (`iris deals remind`) |
| `deal_closed` | Both contract signed and payment received | Done — gate auto-completes |

## How the D+1/D+3/D+7 reminders work

When a payment gate is created, `PaymentGateService::seedReminderSteps()` creates 3 child outreach steps:

| Reminder | Timing | Tone |
|----------|--------|------|
| Day 1 | 24 hours after gate creation | Friendly, brief — links contract + payment |
| Day 3 | 72 hours | Mentions availability this week, offers to reschedule |
| Day 7 | 168 hours | Final notice, closing slots, graceful exit line |

Each reminder has an `ai_prompt` template with `{first_name}`, `{scope}`, `{amount}`, `{contract_url}`, `{checkout_url}` placeholders. When `auto_send_reminders` is on, they execute automatically. When off, they sit as pending steps until manually triggered via `iris deals remind`.

## Common errors

### `No active payment gate found for this lead`

**Cause:** The lead doesn't have a payment gate, or it was already completed/deleted.
**Fix:** Create one: `iris deals create <lead_id> -a 500 -s "Scope" -b <bloq_id>`

### `All reminders already sent`

**Cause:** All 3 D+1/D+3/D+7 reminders have been sent. No more auto-steps to trigger.
**Fix:** Draft a manual follow-up: `iris outreach-send <lead_id>` or use the heartbeat nurture system.

### `deals list` returns 404

**Cause:** The `GET /api/v1/deals/active` endpoint isn't deployed yet on your fl-api instance.
**Fix:** Deploy the latest fl-api code to production. The endpoint was added April 21, 2026.

### Reminders not sending automatically

**Cause:** The queue worker may not be processing the `default` queue, or `auto_send_reminders` is off.
**Fix:** Check `iris deals status <id>` — if Auto-send shows "No", toggle it: `iris leads payment-gate <id> --toggle-reminders`. Check worker logs: `doctl apps logs <app-id> fl-api-queue-worker --follow`.

## Key API endpoints (reference)

```
GET    /api/v1/deals/active                                    # List all active payment gates
GET    /api/v1/leads/{id}/deal-status                          # Full deal status for one lead
POST   /api/v1/leads/{id}/payment-gate                         # Create payment gate (orchestrator)
PUT    /api/v1/leads/{id}/payment-gate                         # Update payment gate
DELETE /api/v1/leads/{id}/payment-gate                         # Delete payment gate
POST   /api/v1/leads/{id}/payment-gate/send-next-reminder      # Trigger next pending reminder
POST   /api/v1/leads/{id}/payment-gate/{stepId}/toggle-reminders  # Toggle auto-send
POST   /api/v1/leads/{id}/invoice/mark-paid                    # Record offline payment
```

## Heartbeat integration (autonomous deal recovery)

The heartbeat agent's `analyzeProjectState()` now includes `payment_gate_stats` with:

- **deals**: Active gates with status, amount, days open, reminder progress
- **overdue_reminders**: D+1/D+3/D+7 steps past due_date that haven't been sent
- **stale_deals**: Gates open 7+ days with no payment

When `nurture_mode` is enabled, `buildNurtureInstructions()` adds a "DEAL RECOVERY" priority section that instructs the AI to:
1. Draft `payment_followup` messages for awaiting-payment leads
2. Draft win-back messages for stale deals
3. Draft reminder coverage for overdue D+N steps

All messages use `loop_type: payment_followup` and go through the `EmailApprovalService` review queue — nothing sends without your approval.

## Related recipes

- `payment-gate-contracts.md` — deep dive on creating payment gates with contracts, line items, and deliverables
- `lead-to-proposal.md` — the full Atlas OS lead-to-payment flow
- `outreach-campaign.md` — where most leads come from before they get a deal
- `iris-login.md` — must be authenticated first
