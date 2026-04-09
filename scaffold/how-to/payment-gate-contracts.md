# How to: Send a contract + invoice + payment gate to a lead

## What this does

Creates a unified deal flow for a lead: contract (scope of work + signature), proposal page (deliverables + line items), and Stripe payment checkout — all generated from one command. The lead receives links to sign the contract, review the proposal, and pay. Auto-reminders follow up at D+1, D+3, and D+7 if they haven't paid.

This uses the **PaymentGateService** orchestrator which creates everything in one shot: the CustomRequest (invoice), the Atlas contract (signing page), the Stripe checkout session, and the outreach step with auto-reminders.

## Prerequisites

- Authenticated (`iris-login` complete — see `iris-login.md`)
- A lead exists with a `lead_id` (e.g. lead 110)
- Stripe connected on the platform (Settings → Integrations → Stripe) for real payments
- (Optional) Deliverables attached to the lead via `iris leads deliverables`

## The full deal flow

```
[1] CREATE INVOICE  →  [2] ATTACH DELIVERABLES  →  [3] SEND PAYMENT GATE
         ↓                       ↓                          ↓
   CustomRequest          CloudFile rows              PaymentGateService:
   + line items           linked to invoice            - Contract (signing URL)
   + pricing                                           - Proposal page
                                                       - Stripe checkout
                                                       - D+1/D+3/D+7 reminders
```

## Quick path (5 minutes — just invoice + pay link)

```bash
# Create an invoice for the lead
iris invoices create <lead_id> --price=5000 --title="Website Development Phase 2"

# Generate the Stripe checkout link
iris invoices checkout <invoice_id>

# Send the payment email
iris invoices send <invoice_id>
```

The lead gets a Stripe payment link. Simple but no scope of work or deliverables list.

## Full path (contract + proposal + payment gate)

### Step 1: Create deliverables (if not already done)

```bash
# List existing deliverables
iris leads deliverables <lead_id>

# Create deliverables via SDK
iris sdk:call leads.deliverables.create lead_id=<lead_id> \
  title="Home Page Design" is_deliverable=true external_url="https://..."
```

### Step 2: Create the payment gate (one command, creates everything)

The payment gate API endpoint orchestrates the full flow:

```bash
# Via the platform API (the PaymentGateService orchestrator)
curl -X POST "https://raichu.heyiris.io/api/v1/leads/<lead_id>/payment-gate" \
  -H "Authorization: Bearer $IRIS_SDK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 5000,
    "scope": "Website development: home page, services page, training portal. Includes 2 rounds of revisions.",
    "bloq_id": <your_bloq_id>,
    "auto_send_reminders": true,
    "user_id": <your_user_id>
  }'
```

This creates:
- A **CustomRequest** (invoice) with the scope and amount
- A **proposal page** at `https://main.heyiris.io/proposal/<token>` — shows scope, deliverables, line items, total, and a "Sign & Accept" form
- A **contract** at `https://main.heyiris.io/sign/<token>` — 1099-style contractor agreement with digital signature
- A **Stripe checkout session** — payment link
- A **payment gate outreach step** on the lead's timeline
- **3 auto-reminder steps** at D+1, D+3, and D+7

The response contains all the URLs:
```json
{
  "step": {
    "data": {
      "contract_signing_url": "https://main.heyiris.io/sign/abc123...",
      "stripe_checkout_url": "https://...",
      "proposal_url": "https://main.heyiris.io/proposal/def456..."
    }
  }
}
```

### Step 3: Send to the client

Share the URLs with the client. Options:
- Email via `iris invoices send <invoice_id>`
- Draft via macOS Mail: `iris integrations exec macos draft_email --params-file /tmp/deal-email.json`
- Manually copy-paste the signing URL + checkout URL

### Step 4: Track the deal status

```bash
# Check if they've signed and paid
curl "https://raichu.heyiris.io/api/v1/leads/<lead_id>/deal-status" \
  -H "Authorization: Bearer $IRIS_SDK_TOKEN"
```

Response shows:
- `contract_signed`: true/false (+ timestamp)
- `payment_received`: true/false (+ timestamp)
- Reminder status (sent count, next due)

When BOTH `contract_signed` AND `payment_received` are true, the payment gate step auto-completes and remaining reminders are cancelled.

## What the client sees

### Proposal page (`/proposal/{token}`)
- Scope of work
- Line items with pricing (if added via custom_request_items)
- Deliverables list
- Completeness score (0-100%)
- "Sign & Accept" form (name + checkbox)
- First view timestamp tracked automatically

### Contract page (`/sign/{token}`)
- Parties (your company + the client)
- Term dates
- Scope of work
- Compensation breakdown
- Standard clauses (IP, confidentiality, termination)
- "Sign" form (name + agreement checkbox)
- Signature recorded with IP + user agent + timestamp
- Status badge: PENDING SIGNATURE → ACTIVE (after signing)

### Stripe checkout
- Standard Stripe checkout page with the amount
- Connected to your Stripe account (payments go directly to you)

## Adding line items to the invoice

```bash
# Add line items for detailed pricing breakdown
curl -X POST "https://raichu.heyiris.io/api/v1/custom-requests/<invoice_id>/items" \
  -H "Authorization: Bearer $IRIS_SDK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "item_type": "service",
    "description": "Home Page Design & Development",
    "quantity": 1,
    "unit_price": 2500,
    "is_billable": true,
    "is_taxable": true
  }'

# Set tax rate
curl -X PATCH "https://raichu.heyiris.io/api/v1/custom-requests/<invoice_id>/tax-rate" \
  -H "Authorization: Bearer $IRIS_SDK_TOKEN" \
  -d '{"tax_rate": 8.25}'
```

Line items appear on the proposal page automatically. Item types: `service`, `product`, `hours`, `expense`, `discount`, `credit`, `adjustment`.

## Common errors

### `iris leads packages <lead_id>` crashes with `$this->api undefined`

**Known bug** — the PHP SDK's LeadsCommand has an uninitialized `$api` property on the packages/deal-status paths. Use the REST API directly (curl examples above) until this is fixed in the Node CLI.

### Duplicate invoices

If you accidentally created multiple invoices, list them:
```bash
iris leads invoices <lead_id>
```
Delete the duplicates via the API or the Bloq dashboard.

### Stripe not connected

Payment gates require Stripe. Check:
```bash
iris integrations list-connected
```
If Stripe isn't listed, connect it via the platform UI (Settings → Integrations → Stripe) or:
```bash
iris integrations connect stripe
```

## Key API endpoints (reference)

```
POST   /api/v1/leads/{id}/payment-gate                    # Create payment gate (the orchestrator)
GET    /api/v1/leads/{id}/deal-status                      # Check signing + payment status
POST   /api/v1/leads/{id}/payment-gate/{stepId}/toggle-reminders  # Enable/disable auto-reminders

POST   /api/v1/leads/{id}/invoice/create                   # Create invoice (without payment gate)
GET    /api/v1/leads/{id}/invoices                         # List lead's invoices
POST   /api/v1/custom-requests/{id}/generate-checkout      # Generate Stripe checkout URL

POST   /api/v1/custom-requests/{id}/items                  # Add line item
PATCH  /api/v1/custom-requests/items/{id}                  # Update line item
DELETE /api/v1/custom-requests/items/{id}                  # Remove line item
PATCH  /api/v1/custom-requests/{id}/tax-rate               # Set tax rate

GET    /api/v1/leads/{id}/deliverables                     # List deliverables
POST   /api/v1/leads/{id}/deliverables                     # Create deliverable
POST   /api/v1/leads/{id}/deliverables/send                # Email deliverables to client

GET    /sign/{token}                                        # Contract signing page (public)
POST   /sign/{token}                                        # Submit signature
GET    /proposal/{token}                                    # Proposal view page (public)
POST   /proposal/{token}                                    # Accept proposal
```

## Related recipes

- `iris-login.md` — must be authenticated first
- `lead-to-proposal.md` — the Atlas OS overview of the lead→deal flow
- `outreach-campaign.md` — where most leads come from before they get invoiced
