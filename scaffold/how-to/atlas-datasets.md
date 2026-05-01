# How to: Use Atlas Datasets (schema-driven data)

## What this does
Create custom datasets for any business vertical — cases, invoices, inventory, medical records, fleet vehicles — without writing code or running migrations. Define a schema once, store records against it, query/export/audit from CLI.

## Prerequisites
- IRIS CLI authenticated (`iris auth`)
- Atlas dataset migration deployed on fl-api

## Steps

### 1. View available schemas
```bash
$ iris atlas:datasets schemas list
```

### 2. View a schema's field definitions
```bash
$ iris atlas:datasets schemas show cases
```

### 3. List records in a dataset
```bash
# All records
$ iris atlas:datasets records list --schema=cases

# Filter by field value
$ iris atlas:datasets records list -s cases --filter stage_name=Negotiating

# Search across all fields
$ iris atlas:datasets records list -s cases --search "Usman"

# Limit results
$ iris atlas:datasets records list -s cases --limit=10

# Raw JSON output (for piping)
$ iris atlas:datasets records list -s cases --json
```

### 4. View a single record
```bash
$ iris atlas:datasets records show 1 --schema=cases
$ iris atlas:datasets records show 1 -s cases --json
```

### 5. Get summary stats
```bash
# Group by stage
$ iris atlas:datasets records summary -s cases --group-by stage_name

# Sum a money field
$ iris atlas:datasets records summary -s cases --sum invoice_total

# Both
$ iris atlas:datasets records summary -s cases --group-by stage_name --sum invoice_total
```

### 6. Export to CSV (for QuickBooks, Excel, etc.)
```bash
# Default CSV export (all fields)
$ iris atlas:datasets export --schema=cases

# Specific fields only
$ iris atlas:datasets export -s cases --fields=servis_case_id,patient_name,invoice_total

# Custom output path
$ iris atlas:datasets export -s cases --out=pathways-cases.csv

# JSON export
$ iris atlas:datasets export -s cases --format=json -o cases.json
```

### 7. Run a data quality audit
```bash
$ iris atlas:datasets audit --schema=cases

# Machine-readable output
$ iris atlas:datasets audit -s cases --json
```

## Expected output

**Records list** shows case ID, patient name, stage, and key fields inline:
```
  #1  Ayesha Usman  CAS103544
    dob: 1982-12-10  ·  stage_name: Negotiating  ·  severity: High
```

**Summary** shows totals, groupings, and sums:
```
  Total Records: 22
  Sum (invoice_total): $881,386.23
  By stage_name:
    Treating                  16
    Negotiating                1
    Awaiting Payment           1
```

**Audit** flags data quality issues by severity:
```
  WARNINGS (56)
    ⚠️  CAS106139  services.Merge Health  $0 billing
  INFO (3)
    ℹ️  CAS112725  Dirshelle Washington  No services
```

## Common errors

| Error | Fix |
|-------|-----|
| "Schema not found" | Check slug with `iris atlas:datasets schemas list` |
| "Authentication required" | Run `iris auth` to log in |
| Empty results | Check `--bloq` filter or remove filters |

## Related recipes
- `track-finances-atlas-ledger` — Atlas financial transactions
- `payment-gate-contracts` — Invoicing and payment collection
- `lead-to-proposal` — Lead management pipeline
