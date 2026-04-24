# How to: Lead → Deal → Proposal → Contract → Payment (Atlas OS)

## What this does

Walks a prospect through the full **Atlas OS** revenue flow: capture a lead, create a deal, send a proposal, attach a contract, and collect payment via a payment gate. This is the unified IRIS billing flow for service businesses.

## Prerequisites

- Authenticated (`iris-login` complete — see `iris-login.md`)
- A bloq exists for the user's business with at least one service package configured (or create one in step 2)
- (Optional) Stripe connected on the platform if you want real payment collection — without it, payment gates work in test mode

## The 5-stage flow

```
[1] LEAD  →  [2] DEAL  →  [3] PROPOSAL  →  [4] CONTRACT  →  [5] PAYMENT
```

## Steps

### 1. Capture or list leads

```bash
$ iris platform-leads list --recent
$ iris platform-leads list --status=eligible --segment=creators
```

To create a lead manually (useful when a reply comes in via email or another channel):

```bash
$ iris platform-leads create \
    --name="Jane Doe" \
    --email="jane@example.com" \
    --source="referral" \
    --notes="Wants a Genesis page for her course launch"
```

To find a lead from outreach (likely the most common path — see `outreach-campaign.md`):

```bash
$ iris platform-leads list --recent --status=replied
```

### 2. Create a deal from the lead

```bash
$ iris platform-leads deal create --lead-id=12345 --package=genesis-page-launch
```

`--package` references a service package configured on the user's bloq. To list available packages:

```bash
$ iris leads packages
```

If the user has no packages defined yet, create one:

```bash
$ iris leads packages create \
    --name="Genesis Page Launch" \
    --bloq-id=42 \
    --billing-type="fixed" \
    --price=2500 \
    --scope-template="genesis-launch"
```

### 3. Send a proposal

```bash
$ iris leads invoice send --deal-id=67890 --proposal
```

This sends the user a single-page **proposal + contract + payment** flow. The lead receives a link like `https://app.heyiris.io/sign/<token>` where they can review the scope, sign the contract, and pay — all in one page. (Built April 2026 as part of the proposal system.)

### 4. Track contract signing

The contract is rendered from a BloqItem template. To list templates:

```bash
$ iris contracts templates list
```

To send a standalone contract (without a proposal):

```bash
$ iris contracts send --lead-id=12345 --template=mutual-nda
```

To check signing and payment status:

```bash
$ iris deals status 12345
```

Output shows: contract signing status, payment status, reminders sent, all URLs. See `deals.md` for the full deal pipeline management guide.

### 5. Payment gate (collect payment)

Payment gates are automatic outreach steps that block further pipeline progress until the lead pays. They include D+1 / D+3 / D+7 auto-reminders.

To create a payment gate:

```bash
$ iris deals create 12345 -a 2500 -s "Website Development Phase 2" -b 42
```

The lead gets a proposal with contract + Stripe checkout. Reminders send at D+1, D+3, D+7. Once paid, the gate auto-completes.

To send a reminder manually or recover a stale deal:

```bash
$ iris deals remind 12345       # send next pending reminder
$ iris deals recover 12345      # fire all remaining reminders (win-back)
```

## Expected output (full happy path)

```bash
$ iris platform-leads create --name="Jane Doe" --email="jane@example.com"
✓ Lead created: lead_12345

$ iris platform-leads deal create --lead-id=12345 --package=genesis-page-launch
✓ Deal created: deal_67890 ($2500, package: genesis-page-launch)

$ iris leads invoice send --deal-id=67890 --proposal
✓ Proposal sent to jane@example.com
✓ Sign URL: https://app.heyiris.io/sign/tok_xyz789

$ iris deals status 12345
Deal Status — Lead #12345
  ────────────────────────────────────────────────────────────
  Status:     PENDING
  Amount:     $2,500.00
  Scope:      Genesis page launch — homepage + services + portal
  Contract:   Pending
  Payment:    Pending
  Reminders:  0/3 sent
  Auto-send:  Yes

  Proposal URL:  https://heyiris.io/proposal/tok_xyz789...
  Contract URL:  https://heyiris.io/sign/tok_abc123...
  ────────────────────────────────────────────────────────────
```

## Common errors

### `Error: No service packages defined for bloq`

**Cause:** The user's bloq has no `program_packages` rows.
**Fix:** Run `iris leads packages create ...` first (see step 2).

### `Error: Stripe not connected`

**Cause:** Payment gate requires Stripe but the user hasn't connected it.
**Fix:** Either connect Stripe via the platform UI (`Settings → Integrations → Stripe`), OR use test mode by passing `--test` to `iris leads invoice send`.

### Lead receives proposal but signs and never pays

**Cause:** Payment gate may not be enabled on this proposal template.
**Fix:** Check `iris leads deal-status --deal-id=<id>`. If `Payment: not configured`, the proposal template doesn't have a payment gate. Re-send with `--with-payment-gate` or update the template.

### `Duplicate payment gate` error

**Cause:** A payment gate already exists for this deal — the system prevents duplicates so the lead doesn't get spammed.
**Fix:** This is working as designed. Use `iris leads deal-status` to see the existing gate. If you need to re-send, cancel the existing one first: `iris leads gate cancel --deal-id=<id>`.

## Related concepts (in case the user asks)

- **Bloqs** are the unit of business context. A bloq holds the user's service offerings, brand, contracts, leads, and pipeline. Every deal belongs to a bloq.
- **Service packages** (`program_packages`) define what the user sells: name, billing type, price, scope template, milestone config. They link a deal to a deliverable.
- **Payment gates** are first-class outreach step types — not just Stripe links. They block pipeline progress, send reminders, and unblock automatically on payment.
- **Proposals** combine scope + contract + payment in one signing flow (single-page UX, built April 2026).

## Related recipes

- `iris-login.md` — must be done first
- `deals.md` — manage the deal pipeline after creation: track status, send reminders, win-back stale deals
- `payment-gate-contracts.md` — deep dive on contracts, line items, deliverables
- `outreach-campaign.md` — where most leads come from
- `hive-dispatch.md` — to schedule recurring follow-up reminders across machines
