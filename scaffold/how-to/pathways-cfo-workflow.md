# How to: Run the Pathways CFO Workflow (Service AI → Atlas → QuickBooks)

## What this does
Pull case data from Servis AI, aggregate into Atlas datasets, run audits for data quality, and export to QuickBooks Desktop-compatible CSV. This is the end-to-end financial accounting pipeline for Pathways Injury Consultants.

## Prerequisites
- IRIS CLI authenticated
- Servis AI integration connected (Client Credentials OAuth2)
- Atlas "cases" schema created (slug: `cases`, bloq: 40)

## Steps

### 1. Check current dataset status
```bash
# How many cases do we have?
$ iris atlas:datasets records summary -s cases --group-by stage_name --sum invoice_total

# List all cases sorted by invoice total
$ iris atlas:datasets records list -s cases --sort invoice_total --limit=50
```

### 2. Pull cases from Servis AI
Cases are ingested from Servis AI using `get_case_details` + `list_services`. Each case gets:
- Patient info (name, DOB, DOI, address)
- Case status (stage, severity, type, law firm, attorney, case manager)
- Financial data (policy limit, AR balance, invoice total)
- All services (provider, amount, dates, LOP status, type)
- Google Drive folder link

To run a batch sync (via agent or workflow):
```bash
$ iris agents chat <cfo-agent-id> "Sync the latest 20 cases from Servis AI into the cases dataset"
```

### 3. Run the audit
```bash
# Full audit — checks for:
#   - Missing required fields
#   - $0 billing on services (missing amounts)
#   - Cases with no services attached
#   - Missing Google Drive links
$ iris atlas:datasets audit -s cases

# JSON output for piping to other tools
$ iris atlas:datasets audit -s cases --json
```

### 4. Review specific cases
```bash
# Find cases in Negotiating stage
$ iris atlas:datasets records list -s cases --filter stage_name=Negotiating

# Search by patient name
$ iris atlas:datasets records list -s cases --search "Usman"

# View full case detail (shows all services)
$ iris atlas:datasets records show 1 -s cases
```

### 5. Export for QuickBooks Desktop
```bash
# Full CSV export
$ iris atlas:datasets export -s cases --out=pathways-export.csv

# Just the fields QuickBooks needs
$ iris atlas:datasets export -s cases \
  --fields=servis_case_id,patient_name,law_firm,invoice_total,date_of_referral \
  --out=qb-import.csv
```

### 6. Check pipeline by stage
```bash
$ iris atlas:datasets records summary -s cases --group-by stage_name
```

Expected stages (from Servis AI):
```
  Intake → Coordinating Care → Treating → Packaging →
  Legal Review → Negotiating → Awaiting Payment →
  Processing Payment → Closed
```

## Data flow diagram
```
  Service AI ──→ IRIS Agent ──→ Atlas Dataset (cases) ──→ CSV Export
       ↓              ↓               ↓                      ↓
  Case details   Aggregates      Audit flags           QuickBooks
  + Services     from Drive      $0 billing            Desktop
  + Billing      + Email         Missing docs           import
```

## Key case fields
| Field | Source | Type |
|-------|--------|------|
| servis_case_id | Servis AI seq_id (CAS######) | text |
| patient_name | Servis AI patient_name | text |
| stage_name | Servis AI stage (computed from stage_sequence) | text |
| invoice_total | Sum of all service amounts (cents) | money |
| services | Array of provider records with billing | array |
| g_drive_link | Servis AI case record | url |
| law_firm | Servis AI law_firm reference | text |

## Common errors

| Error | Fix |
|-------|-----|
| "Schema not found" | Schema slug is `cases` — check with `schemas list` |
| Servis AI 401 | Check SERVIS_AI_CLIENT_ID/SECRET env vars |
| $0 billing on services | Usually means billing not yet entered in Service AI — flag for Robyn |
| Duplicate case on sync | System uses `external_id` (CAS######) for dedup — safe to re-run |

## Related recipes
- `atlas-datasets` — General Atlas datasets usage
- `track-finances-atlas-ledger` — Atlas financial transactions
