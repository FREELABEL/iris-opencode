# Bug Bounty — Source of Truth (READ BEFORE REPORTING ANY $)

The bug-bounty payout state (opp **#581**) had drifted — internal wallet **accruals** were being
reported as real **payouts**. It's reconciled now. **Do not compute bounty money yourself from raw
records.** Use the commands/endpoints below — they all share one definition.

This doc is the LEDGER: what the money states mean and how to read them without inventing a
second answer. What a hunter does — the email gate, applying, signing, self-serve payouts —
is [bounty-os-hunter-journey](bounty-os-hunter-journey.md). A hunter's own view of these same
numbers is `GET /v1/bounty/gated`, which aggregates the services below rather than
recomputing them.

## The money states — exact meanings

| State | Means | Counts as "paid"? |
|-------|-------|-------------------|
| **reported** | bugs attributed to the hunter | — |
| **verified** | bug `status = done` | — |
| **owed** | verified, not yet paid | no (still owed) |
| **accrued** | credited to an internal wallet (`rail=wallet`, `status=sent`) — a promise, **$0 real money moved** | **NO** |
| **paid** | REAL disbursement — off-platform manual (apple_pay/venmo/cash) or Stripe cashout (`status=sent` AND `rail != wallet`) | **YES** |
| **potential** | if every reported bug verified | — |

**THE RULE:** `paid` = money the hunter actually received. A `rail=wallet` accrual is **never** paid —
it's `accrued`. Reporting an accrual as "paid" is the exact bug that happened (the false "$5 paid").

The one definition lives in `BugBountyPayoutService::isRealDisbursement()` / `isWalletAccrual()` —
every leaderboard / summary / command routes through it. Never re-derive `status === 'sent'` yourself.

## Canonical commands (fl-api artisan — prod via `railway ssh -s fl-api -- …`)

```bash
php artisan bounty:hunters   --opportunity=581        # leaderboard: reported/verified/owed/PAID per hunter
php artisan bounty:payouts   --opportunity=581        # ledger: every record + rail + Accrued vs Cashed-out
php artisan bounty:audit     --opportunity=581        # reconcile records ↔ wallet balance ↔ credit ledger
php artisan bounty:identity  --opportunity=581        # hunter user/lead map + duplicate/misdirection flags
php artisan bounty:log-manual-hunter <lead> --amount=<$> --method=apple_pay   # record a REAL off-platform payout (dry-run; add --execute)
php artisan bounty:void-accruals --opportunity=581    # reverse unbacked wallet accruals (dry-run; add --execute)
```

`--json` on any of these for machine-readable output.

## Queryable dataset (easiest for agents) — `bounty-ledger` Atlas dataset

The reconciled per-hunter state is projected into an Atlas dataset (a VIEW of `leaderboard()`, so it
can't drift). One row per hunter with `owed_cents / paid_cents / accrued_cents / potential_cents`.

```
GET  /api/v1/atlas/datasets/bounty-ledger            # all hunter rows (reconciled)
GET  /api/v1/atlas/datasets/bounty-ledger/summary    # totals
GET  /api/v1/atlas/datasets/bounty-ledger/aggregate  # AVG/SUM/etc over the rows
```

Refresh it after any payout: `php artisan bounty:sync-ledger --opportunity=581`. (It's a projection —
NEVER write bounty numbers into it by hand; re-sync from the service instead.)

## API endpoints (agents/UI — already reconciled)

```
GET  /api/v1/public/opportunities/{id}/bug-bounty/leaderboard   # public, privacy-shaped, paid = real
GET  /api/v1/marketplace/opportunities/{id}/bug-bounty/leaderboard  # owner
GET  /api/v1/marketplace/opportunities/{id}/bug-bounty/hunter?lead_id=<id>   # owner: one hunter's bugs
```

Response money fields: `paid_cents` (real), `accrued_cents` (wallet, not paid), `owed_cents`,
`potential_cents`. Public `earned_cents` = owed + paid + accrued (all verified value).

## Rules for agents

1. **Never post a "$ paid" number pulled from raw payout records.** Run `bounty:hunters` (or the
   leaderboard endpoint) — its `paid` is already real-disbursement only.
2. **Wallet accrual ≠ paid.** If you see `rail=wallet`, it's `accrued` — money hasn't moved.
3. **Before reporting money, run `bounty:audit`** — it flags any drift between records, wallet
   balances, and the credit ledger.
4. **Do NOT auto-pay or auto-cashout.** Hunter identity is currently tangled (leads mis-linked to the
   admin user — see bug **#177956**); a payout could hit the wrong account. Manual, human-confirmed only.
5. **To record a real off-platform payment** (Apple Pay/cash), use `bounty:log-manual-hunter`
   (dry-run first). It draws the pool down, marks bugs paid, and credits no wallet.

## A dated snapshot (opp #581, 2026-07-28 — NOT live)

Kept as a worked example of the states above, not as current state. Figures move; re-read
them with the commands in this doc rather than quoting the numbers below.

Real disbursed **$24** (Rashad, Apple Pay) · Accrued **$0** (the fake $35 was voided) · Stripe **$0** ·
Owed **~$49** (Rashad $19 + Flo $30). Full audit page: `heyiris.io/p/bounty-audit-581`.
