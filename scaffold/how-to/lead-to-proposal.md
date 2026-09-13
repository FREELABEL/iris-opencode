---
category: CRM & Sales
level: beginner
tags: [crm, leads, proposals, payments]
duration_min: 10
---
# How to: Take a lead from first conversation to paid

## What this does

The whole path in five commands. The deal-specific decisions — which package, a deposit or a setup
fee, what the client signs — are in `payment-gate-contracts.md`. This page is the map.

```
LEAD ──> PACKAGE ──> PAYMENT GATE ──> client accepts, signs, pays ──> CLOSED
```

## 1. Find the lead, or create it

```bash
iris leads search "Jane Doe"
```

Search covers CRM records and mentions across your projects. Two records for one company is
common — keep the one for the person who signs, and merge the rest:
`iris leads merge <keep_id> <remove_id>`.

```bash
iris leads create --name "Jane Doe" --email jane@example.com \
  --company "Doe Co" --source referral --status Qualified --json
```

`--json` returns the new lead, including its ID.

## 2. Move it to Proposal

```bash
iris leads update <lead_id> --status Proposal --bid 4500
```

`--bid` is what the board counts as pipeline value. Use the total the client pays over the term,
not the monthly figure.

## 3. Package, then gate

```bash
iris leads packages <bloq_id>
iris leads payment-gate <lead_id> -p <package_id> -a <price> -s "see package" \
  --term 12 --no-auto-remind
```

Every flag, and when to use `--deposit` versus `--setup-fee`: `payment-gate-contracts.md`.

## 4. Send the proposal link

The gate prints a proposal URL, a contract URL and a Stripe URL. The proposal page links to the
other two, so it is the only one the client needs.

## 5. Watch it close

```bash
iris leads deal-status <lead_id>
```

When it reads `deal_closed`, mark the lead won if it is not already:
`iris leads update <lead_id> --status Won`.

## Common errors

| Error | Fix |
|---|---|
| `package_required` | The gate needs a catalogue package: `iris leads create-package <bloq_id> ...` |
| "A payment gate already exists" | One open gate per lead. `iris leads deal-status <id>` shows it. |
| The lead has no email | The client enters one at Stripe checkout. Automatic reminders need an address, so pass `--no-auto-remind` and follow up yourself. |

## Related recipes

- `payment-gate-contracts.md` — packages, deal shapes, what the client sees
- `deals.md` — manage the pipeline once gates exist
- `outreach-campaign.md` — where most leads come from
