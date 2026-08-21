# How to: Track finances with Atlas Ledger

## What this does
Record revenue, expenses, and transfers using the Atlas ledger. Set up a chart of accounts for proper categorization. View summaries and prepare for QuickBooks sync.

## Prerequisites
- IRIS CLI authenticated
- Atlas migrations run on your fl-api instance

## Steps

### 1. Create a chart of accounts
```bash
# Asset accounts
iris atlas:accounts create --name="Cash" --account-type=Asset
iris atlas:accounts create --name="Accounts Receivable" --account-type=Asset

# Liability accounts
iris atlas:accounts create --name="Accounts Payable" --account-type=Liability

# Income accounts
iris atlas:accounts create --name="Service Revenue" --account-type=Income
iris atlas:accounts create --name="Product Sales" --account-type=Income

# Expense accounts
iris atlas:accounts create --name="Contractor Pay" --account-type=Expense
iris atlas:accounts create --name="Software Subscriptions" --account-type=Expense
iris atlas:accounts create --name="Marketing Spend" --account-type=Expense

# View the tree
iris atlas:accounts tree
```

### 2. Record transactions
```bash
# Record revenue
iris atlas:ledger add \
  --type=revenue \
  --description="Acme Corp Q2 retainer" \
  --amount-cents=600000 \
  --category="Service Revenue" \
  --date=2026-04-01 \
  --account-id=4

# Record expense
iris atlas:ledger add \
  --type=expense \
  --description="AWS hosting March" \
  --amount-cents=45000 \
  --category="Infrastructure" \
  --date=2026-03-31

# Record with QuickBooks reference (for sync tracking)
iris atlas:ledger add \
  --type=revenue \
  --description="Invoice #1042 payment" \
  --amount-cents=250000 \
  --source=invoice \
  --qb-id=INV-1042 \
  --qb-entity-type=Invoice
```

### 3. View summary
```bash
# Overall P&L summary
iris atlas:ledger summary

# Filter by date range
iris atlas:ledger summary --from=2026-01-01 --to=2026-03-31

# Filter by bloq (project-level P&L)
iris atlas:ledger summary --bloq=217
```

### 4. Check QB sync readiness
```bash
# See what's synced vs unsynced
iris atlas:ledger reconcile

# List transactions missing QB IDs (need to be pushed)
iris atlas:ledger list --source=manual
```

### 5. Feed into Good Deals projections
```bash
# The three-statement pulls actual transaction data automatically
iris good-deals three-statement <bloq_id>
# → inputs section shows actual_revenue_cents, actual_expense_cents, actual_net_cents
# → balance_sheet uses atlas_accounts balances when seeded
```

## Transaction types
- `revenue` — money in (sales, retainers, product income)
- `expense` — money out (payroll, subscriptions, COGS)
- `transfer` — between accounts (checking → savings)
- `journal` — double-entry adjustments (debit_cents + credit_cents)

## Source tracking
- `manual` — entered via CLI or UI
- `qb` — synced from QuickBooks
- `stripe` — auto-created from Stripe payments
- `invoice` — linked to an Iris invoice
- `import` — bulk imported from CSV/file

## Tips
- All amounts are in cents (600000 = $6,000.00) to avoid floating-point issues
- Use `--account-id` to post to a specific chart-of-accounts entry
- The `reconcile` command is a placeholder until Track 2 (bidirectional QB sync) ships
- Transactions are scoped by `bloq_id` via the `BelongsToBloq` trait — multi-tenant safe
