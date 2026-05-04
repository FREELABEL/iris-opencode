# Spec: `iris events production` — Event Production Management CLI

## Context

Event production (Song Wars, showcases, live streams) is a core revenue activity. The current CLI handles event CRUD and tickets, but has no surface for production planning — stage layout, AV signal chain, power distribution, runsheet, staff assignments, vendor management, or budget tracking. All of this data either lives in the user's head, scattered notes, or the frontend admin panel with no CLI access.

Bug #58892 surfaced this gap during the Song Wars Ep.1 event (Apr 18, 2026).

## What exists today

- `iris events create/get/push/pull/diff` — basic event CRUD
- `iris events stages` — stage list (name only, no layout data)
- `iris events vendors` — vendor list (no CRUD from CLI)
- `iris events tickets` — full ticket CRUD + checkout
- `iris events preflight` — production readiness checks (OBS, bridge, tickets, checkout)
- `iris atlas:staff` — staff management + contracts
- Event admin panel on frontend (freelabel.net/events/{id}?admin=1) — shows vendors, budget, timeline, capacity

## What to build

### `iris events production <event-id>` — subcommand group

```
iris events production <event-id>

  Subcommands:
    overview          full production dashboard (like pulse for events)
    runsheet          show/edit the event timeline/run-of-show
    av                AV signal chain — inputs, channels, outputs
    power             power distribution — circuits, loads, devices
    stage             stage layout — dimensions, positions, monitors
    budget            budget/P&L — income, expenses, margin
    checklist         production checklist with completion tracking
```

### `iris events production overview <event-id>`

The "pulse for events" — one command, full picture:

```
◈  Production: Song Wars Ep.1 (#1350)
────────────────────────────────────────
  Date:     Apr 18, 2026 7:00 PM
  Venue:    Vuka Bouldin Creek
  Status:   LIVE

  Readiness: 85%  missing: power plan, AV check

  Runsheet (6 items)
    4:00 PM  Load-in & AV Setup
    6:30 PM  Sound Check
    7:00 PM  Doors Open
    7:30 PM  Round 1 — Battle
    9:00 PM  Round 2 — Final
    10:30 PM  Tear-down

  Tickets
    GA: 45/100 sold ($15)   Door: 12 sold ($25)
    Revenue: $975

  Staff (8)
    ✓ Door Check-in    — Emily
    ✓ Green Room Host   — TBD
    ○ Sound Engineer    — not assigned

  Vendors (3)
    Vuka Bouldin Creek — venue ($500)
    DJ Equipment Co    — PA rental ($200)
    Catering TBD       — food ($150)

  Budget
    Income:   $975 (tickets) + $500 (sponsors)
    Expenses: $850
    Margin:   $625

  AV Signal Chain
    Ch 1: SM58 → Main L/R (vocals)
    Ch 2: DI Box → Main L/R (guitar)
    Ch 3: Laptop → Main L/R (backing tracks)

  Power
    Circuit A (20A): PA Main, Subs
    Circuit B (15A): Stage Monitors, Lighting
────────────────────────────────────────
```

### Data model

All production data stored in the event's `metadata` JSON column (using the pass-through system we built). Schema:

```json
{
  "production": {
    "runsheet": [
      { "time": "16:00", "title": "Load-in & AV Setup", "duration_min": 150, "status": "done", "notes": "" },
      { "time": "18:30", "title": "Sound Check", "duration_min": 30, "status": "pending" }
    ],
    "av_signal_chain": [
      { "channel": 1, "input": "SM58 Mic", "output": "Main L/R", "purpose": "vocals", "phantom": false },
      { "channel": 2, "input": "DI Box", "output": "Main L/R + Monitor 2", "purpose": "guitar", "phantom": true }
    ],
    "power_distribution": [
      { "circuit": "A", "amps": 20, "devices": ["PA Main", "Subs"], "location": "Stage Left" },
      { "circuit": "B", "amps": 15, "devices": ["Stage Monitors", "Lighting"], "location": "Stage Right" }
    ],
    "stage_layout": {
      "width_ft": 20, "depth_ft": 12,
      "positions": [
        { "name": "Vocalist", "x": 10, "y": 3 },
        { "name": "DJ Booth", "x": 15, "y": 6 },
        { "name": "Monitor 1", "x": 5, "y": 1 }
      ]
    },
    "budget": {
      "income": [
        { "source": "tickets", "amount": 975, "status": "partial" },
        { "source": "sponsors", "amount": 500, "status": "confirmed" }
      ],
      "expenses": [
        { "item": "Venue rental", "vendor": "Vuka", "amount": 500, "status": "paid" },
        { "item": "PA rental", "amount": 200, "status": "pending" }
      ]
    },
    "checklist": [
      { "item": "Book venue", "done": true },
      { "item": "Confirm sound engineer", "done": false },
      { "item": "Print waivers", "done": true },
      { "item": "Test OBS scenes", "done": false }
    ]
  }
}
```

### CLI commands — detailed

#### `iris events production runsheet <event-id>`
- Shows the run-of-show timeline
- `--add "18:30 Sound Check 30min"` — add an item
- `--done 2` — mark item #2 as done
- `--edit` — opens in $EDITOR as YAML
- `--json` — JSON output

#### `iris events production av <event-id>`
- Shows AV signal chain table
- `--add "ch=3 input='Laptop HDMI' output='Main L/R' purpose='backing tracks'"` — add channel
- `--json` — JSON output

#### `iris events production power <event-id>`
- Shows power distribution
- `--add "circuit=C amps=20 devices='LED Wash,Spot' location='Truss'"` — add circuit

#### `iris events production budget <event-id>`
- Shows income vs expenses with margin
- `--add-income "source=sponsors amount=500 status=confirmed"`
- `--add-expense "item='PA rental' amount=200 vendor='DJ Equipment Co'"`
- Calculates totals and margin automatically

#### `iris events production checklist <event-id>`
- Shows checklist with completion %
- `--add "Test live stream"` — add item
- `--done 3` — mark item #3 as done
- `--clear-done` — remove completed items

#### `iris events production stage <event-id>`
- Shows stage dimensions and positions
- `--set "width=24 depth=16"` — set stage dimensions
- JSON output for positions

### Integration with existing commands

- `iris events preflight` should read from `production.checklist` and `production.av_signal_chain`
- `iris events push/pull` already handles metadata pass-through — production data roundtrips
- `iris atlas:staff` manages staff — production overview reads from event staff assignments
- `iris atlas:ledger` tracks finances — budget section should cross-reference

### Implementation approach

1. All data lives in `metadata.production` — no new tables, no migrations
2. The `metadata_field_usage` table tracks which production sub-fields get used
3. CLI reads/writes via `iris events pull` → edit metadata → `iris events push`
4. Production overview aggregates from: metadata, tickets, staff, vendors APIs
5. If production fields hit high usage, promote to dedicated `event_production` table later

### Files to create/modify

| File | Action |
|------|--------|
| `src/cli/cmd/platform-events-production.ts` | Create — all production subcommands |
| `src/cli/cmd/platform-events.ts` | Modify — register production subcommand group |
| `test/cli/event-production.test.ts` | Create — tests for runsheet, budget, checklist logic |

### Test plan

1. Create event, add production metadata via push, verify overview renders
2. Add runsheet items via CLI, verify order and status
3. Add budget items, verify margin calculation
4. Mark checklist items done, verify completion %
5. Verify preflight reads production data
6. Full pull/push roundtrip preserves all production metadata
