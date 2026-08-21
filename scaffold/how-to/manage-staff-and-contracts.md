# How to: Manage staff, contractors, and contracts

## What this does
Add staff members (employees, contractors, vendors, volunteers), set hourly rates, send contracts for signing, and track contract status.

## Steps

### 1. Add staff members
```bash
# Employee
iris atlas:staff add \
  --name="Jordan Rivera" \
  --role="CFO" \
  --email="jordan@example.com" \
  --department="Finance" \
  --hourly-rate-cents=25000 \
  --staff-type=employee

# Contractor
iris atlas:staff add \
  --name="Kyle" \
  --role="Creative Director" \
  --staff-type=contractor \
  --hourly-rate-cents=15000 \
  --contract-type=project \
  --contract-value-cents=500000

# Event-specific vendor
iris atlas:staff add \
  --name="DJ Shadow" \
  --role="Headliner" \
  --staff-type=vendor \
  --event-id=42 \
  --deliverables="2-hour DJ set, meet & greet"
```

### 2. Send a contract for signing
```bash
# Generate a signing token + URL
iris atlas:staff send-contract <staff_id>
# Returns: { signing_token: "abc...", sign_url: "https://freelabel.net/sign/abc..." }

# Send the URL to the staff member (via email, DM, etc.)
# When they visit the URL, it marks the contract as signed
```

### 3. View staff by event
```bash
iris atlas:staff by-event 42
```

### 4. Search and filter
```bash
iris atlas:staff list --department=Finance
iris atlas:staff list --staff-type=contractor
iris atlas:staff list --search="jordan"
iris atlas:staff list --event=42
```

### 5. Track inventory for events
```bash
# Add inventory items
iris atlas:inventory add --name="Archipelago Server" --quantity=5 --sku=ARCH-001 --unit-cost-cents=250000
iris atlas:inventory add --name="Event Wristbands" --quantity=500 --sku=WB-RED --reorder-point=100

# Adjust quantity (e.g., after an event)
iris atlas:inventory adjust <item_id> --delta=-50 --reason="Pete State festival distribution"

# Check what needs reordering
iris atlas:inventory low-stock
```

## Staff types
- `employee` — full-time or part-time team member
- `contractor` — project-based, has contract terms
- `vendor` — external supplier or service provider (DJs, caterers, etc.)
- `volunteer` — unpaid event staff

## Contract lifecycle
1. `null` — no contract yet
2. `sent` — signing token generated, URL sent to staff member
3. `signed` — staff member visited the sign URL, `signed_at` timestamp set

## Tips
- `hourly_rate_cents` enables time tracking cost rollups (Track 5, coming soon)
- Staff members are scoped by `bloq_id` via `BelongsToBloq` — each project has its own team
- Event staff can also appear in the general pool — use `--event-id` to associate
- Contract signing is token-gated, no auth required for the signer — they just visit the URL
- The Operational HQ (`iris good-deals operational-hq`) auto-counts staff and infers needed roles
