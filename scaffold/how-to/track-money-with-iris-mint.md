---
category: Finance
level: beginner
tags: [mint, money, budget, receipts, expenses, finance]
duration_min: 12
---
# How to: Track money with IRIS Mint

## What this does

Mint answers one question — **are we spending more than we said we would?** — and proves the
answer ties to real rows rather than a number someone typed.

You set caps, get transactions in (typed by hand, imported from a CSV, scanned out of email,
or read off a photo of a bill), tag each one with the money it counts against, and read one
screen: budget vs actual vs remaining.

This is **your own books** — what you spend. It is not the same thing as
`iris commerce`, which is money customers pay you. See "Where this stops" at the end.

## Prerequisites

- IRIS CLI authenticated (`iris whoami`)
- Nothing else. Mint works with no setup — you will just have no caps to compare against.

## The one screen that matters

```bash
iris mint status
```

```
  Food & Home — monthly  group:food  2026-09-01 → 2026-09-30
    ░░░░░░░░░░░░░░░░░░░░░░░░   0%  $0.00 / $320.00  $320.00 left
      · dining             $0.00
      · groceries          $0.00
      · household          $0.00
```

Add `--scope business` for the business books, `--period monthly` to narrow it, `--json` to
pipe it somewhere.

**Read the warnings above the bars.** Mint tells you when two budgets cover the same category:

```
"groceries" is covered by 5 active budgets — those dollars are counted in each,
so the TOTAL double-counts them
```

That line is the point. A budget tool that silently sums overlapping caps gives you a total
that is wrong in the safe-looking direction.

## Steps

### 1. Set what you are allowed to spend

```bash
iris mint budgets                      # what caps exist today
```

A budget caps either **one category** or a **group** of them:

```bash
iris mint group                        # groups: one cap over several categories
```

A budget with no cap cannot produce a variance — Mint says so rather than showing 0%:

```
Mia — standing obligations  personal · monthly  $0.00
  no cap set — this budget cannot produce a variance
```

### 2. Get transactions in

Four ways in, all idempotent — **running any of them twice changes nothing**:

```bash
# One line, by hand
iris mint spend 6.40 coffee -c dining
iris mint spend 240 "office chair" -c equipment -s business -d 2026-09-14

# A bank or card CSV export
iris mint import ~/Downloads/statement.csv -s business

# Receipts sitting in your email
iris mint scan

# A photo or PDF of a bill
iris mint bill ~/Desktop/verizon-september.pdf -c phone -s business
```

`scan` and `bill` are **verified** — the figures are read off the document, not guessed at.

### 3. Say whose money it is

Two different questions, two different flags, and confusing them is the usual reason a
business P&L looks wrong:

```bash
iris mint scope business --untagged     # which books it counts against
iris mint paid-from personal --tx 42    # which card actually paid
```

When those differ, the transaction is a reimbursement, and Mint keeps the list:

```bash
iris mint reimbursable
```

One invoice covering several things gets divided rather than filed under a guess:

```bash
iris mint split 42 --into "campaignA=360.00,campaignB=240.00"
```

### 4. Prove the numbers

```bash
iris mint verify
```

```
  ✓ Food & Home — monthly    claims $0.00  ·  0 row(s) sum to $0.00
  All 6 figure(s) tie to the ledger
```

Every reported figure is recomputed from the rows behind it. This is the difference between a
dashboard and a set of books.

```bash
iris mint audit                        # every change ever made, immutable
iris mint doctor                       # rows that would fail your current policy
iris mint snapshot                     # record today's position
iris mint trend                        # how it has moved since
```

### 5. Stop bad rows at the door

```bash
iris mint policy show
iris mint policy set --require-category --require-group
```

Policy is enforced **before a write**, so the books do not fill with uncategorised rows that
someone has to clean up later. `iris mint doctor` lists the rows already there that would not
pass it.

## Where this stops — read this before you plan around it

- **Commerce sales do not appear in Mint yet.** `iris commerce` records what customers pay you
  and what you are owed on its own ledger; Mint holds what you spend. Nothing joins them today,
  so "what did we actually make this month" is still two screens and some arithmetic.
  See the `genesis-atlas-commerce` how-to for the sales side.
- **`iris mint status` can hang when its output is piped into something that exits early**
  (`| head`, for instance). Run it plain, or use `--json`.
- Mint is not an accounting system and does not file anything. For double-entry accounts and
  a QuickBooks path, see `track-finances-atlas-ledger`, which is a different subsystem
  (`iris atlas:ledger`) despite the similar-sounding name.

## Troubleshoot

| Symptom | Cause |
| --- | --- |
| Total looks too high | Two budgets cover the same category — read the overlap warning above the bars |
| A budget shows 0% and never moves | No cap set; it cannot produce a variance |
| Business numbers look wrong | `--scope` (whose books) confused with `paid-from` (whose card) |
| `iris mint status` never returns | Piped into a command that exits early — run it plain or `--json` |
| Importing the same CSV twice | Safe, by design — import is idempotent |
