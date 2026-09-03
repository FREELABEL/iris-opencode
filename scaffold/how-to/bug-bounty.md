---
category: Bounty & Community
level: beginner
tags: [bounty, payments, community]
duration_min: 10
---
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

## Attribution — what makes work earn at all (2026-09-01)

Money can only reach somebody the item is CREDITED to, and credit is set when the item is
**filed**. Get this wrong and nothing errors: the item saves, the board looks right, and the
reporter simply never appears in a tally.

**Two boards can earn, and only two.** `config('bounty.credited_bloq_ids')` = bugs on **#297**
and feature requests on **#652**. The list is short on purpose — every id on it becomes payable
in a sweep. **Bloq 503 is deliberately absent**: it holds 914 items and adding it would make all
of them payable at once.

```bash
# A bug
iris bug report "<title>" -s high --reporter-lead <leadId> \
  -d "Reported by <Name>, <date>. <observed vs expected>"

# A feature request (defaults to bloq 652 / Requested; --bloq and --list override)
iris feature report "<title>" -d "<what it should do, and why>" --reporter-lead <leadId>

# Anything else that should carry credit
iris bloqs add-item <bloq> <list> --title "<t>" --text "<body>" --reporter-lead <leadId>
```

**Read the credit back — do not assume it landed.** Attribution failing is silent:

```bash
iris bug show <id>     # look for:  lead: <leadId>  under Attribution
```

Three rules that have each cost something:

1. **Attribution goes on at FILING time.** `bug update --reporter-lead` repairs a ticket already
   filed, but it only reaches the bug board — an item filed anywhere else answers "not found"
   and cannot be repaired afterwards.
2. **Never pass `--reporter-name`.** It is a per-bug snapshot; using it to correct one
   attribution once renamed a hunter across all 108 of their bugs. The display name resolves
   from the lead, so `--reporter-lead` alone is both correct and safe.
3. **Split by reporter before quoting any total.** 791 of 1,052 attributed bugs are
   admin-filed, so a raw count overstates hunter contribution by roughly 5x.

**Features earn on the same terms as bugs** — a leadership decision, wired through the six
`BugBountyPayoutService` enumeration queries and the `BloqItemObserver` auto-pay gate. Auto-pay
itself is still gated per-opportunity (`proposal_metadata.bounty_auto_pay`, default OFF), so
widening which boards *can* pay did not turn paying on.

**Runnable version of all of this:** `iris playbook run bounty-os`.

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

Real disbursed **$24** (one hunter, Apple Pay) · Accrued **$0** (a mistaken $35 accrual was
voided) · Stripe **$0** · Owed **~$49** across two hunters.

Individual hunters and the amounts owed to each are deliberately not named here. This page is
public, and who is owed what is between us and them — read the live figures with the commands
above, which are scoped to the caller.
