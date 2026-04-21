# Event Production — How-To

Set up a live event with ticket sales, QR check-in, door payments, and production management — all from the CLI.

## Quick Reference

```bash
iris events list                           # list all events
iris events get <id>                       # show event details
iris events tickets <id>                   # list ticket tiers
iris events tickets-pull <id>              # download tickets to JSON
iris events tickets-push <id>              # sync local JSON to API
iris events tickets-diff <id>              # preview changes
iris events ticket-checkout <id>           # generate Stripe checkout link
```

## Full Playbook (Song Wars example)

### 1. Create the event

```bash
# Create via API or frontend at web.freelabel.net/dashboard
# Event #1343: Song Wars Live ATX Edition
# Set: title, date, time, venue, description, photo
```

### 2. Set up ticket tiers

```bash
# Pull tickets (creates .iris/events/{id}-tickets.json)
iris events tickets-pull 1343

# Edit the JSON:
{
  "event_id": 1343,
  "tickets": [
    {
      "title": "Online Ticket",
      "price": "10",
      "description": "Early bird entry",
      "sale_end_date": "2026-04-19T00:00:00",
      "quantity_total": 30,
      "max_per_order": 5,
      "sort_order": 0
    },
    {
      "title": "Door Entry",
      "price": "15",
      "sale_start_date": "2026-04-19T00:00:00",
      "sale_end_date": "2026-04-19T04:00:00",
      "max_per_order": 5,
      "sort_order": 1
    },
    {
      "title": "Membership",
      "price": "25",
      "sale_end_date": "2026-04-19T04:00:00",
      "quantity_total": 15,
      "max_per_order": 1,
      "sort_order": 2
    }
  ]
}

# Push to create/update/delete tiers
iris events tickets-push 1343
```

**Timezone warning:** All dates are UTC. For CDT (Austin), add 5 hours. 7PM CDT = midnight UTC next day.

### 3. Stripe checkout

Tickets auto-generate Stripe Checkout sessions. Buyers pay via Apple Pay / Google Pay / card.

```bash
# Generate a checkout link for door sales
iris events ticket-checkout 1343
# → pick ticket → enter email → get Stripe URL

# Non-interactive (for scripts)
iris events ticket-checkout 1343 --ticket 12 --email door@venue.com --open
```

### 4. QR check-in

After payment, buyer sees a QR code on the success page. Staff scans with phone camera.

```
Staff scans QR → opens freelabel.net/checkin/{token}
→ shows ticket info (name, email, tier, quantity)
→ taps "Check In Now"
→ green checkmark (prevents double entry)
```

Guest list: `GET /api/v1/events/1343/purchases` — all purchases with check-in status.

### 5. Door sales (Apple Pay)

The event page has a "Pay at Door" panel (owner-only) with QR codes per tier. Customer scans with phone → email prompt → Stripe Checkout → Apple Pay → done. No card reader needed.

### 6. Production management

Set up equipment, stages, sponsors, venue deal via the admin panel at `web.freelabel.net/events/{id}` (logged in as owner).

**Equipment** — stored as AtlasInventoryItem with category='equipment':
```
Camera A → Judges Stage → Twitch
Camera B → Host Stage → YouTube
Mixer → All Stages
4x Wireless Lavs → Judges Stage
```

**Venue deal** — stored in event_venue_deals:
```
Remedy Elixer House — barter deal, 90-day booking rights
```

**Admin panel** shows: readiness score, checklist, stats, equipment grid, sponsors, stages, timeline, contracts, budget.

### 7. Day-of toolkit

```bash
iris obs dashboard 1343            # OBS control from phone
iris obs scene "CAM 1"             # Switch cameras
iris obs stream start              # Go live
iris obs marker "highlight"        # Mark for clips
iris events production -e 1343 runsheet    # Run-of-show
iris events production -e 1343 checklist   # Todo list
```

## Ticket Fields Reference

| Field | Type | Description |
|-------|------|-------------|
| title | string | Tier name (GA, VIP, Membership) |
| price | string | Dollar amount ("10", "25.00") |
| description | string | What's included |
| sale_start_date | datetime | When tickets go on sale (UTC) |
| sale_end_date | datetime | When sales close (UTC) |
| quantity_total | int/null | Max inventory (null = unlimited) |
| quantity_sold | int | Auto-incremented on checkout |
| max_per_order | int | Max tickets per purchase (default 10) |
| min_per_order | int | Min tickets per purchase (default 1) |
| is_visible | boolean | Show/hide from buyers |
| sort_order | int | Display order |
| status | enum | active, paused, sold_out, ended |

## Revenue Math (50-person event)

| Scenario | Ticket Revenue | Membership Upsell | Total |
|----------|---------------|-------------------|-------|
| Conservative (60/40 online/door) | $600 | $250 (10 converts) | $850 |
| Expected (50/50 + 15 members) | $625 | $375 | $1,000 |
| Aggressive (full + 25 members) | $750 | $625 | $1,375 |
