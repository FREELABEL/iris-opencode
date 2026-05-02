# How to: Expose Atlas dataset as a REST API

## What this does
Serve Atlas dataset records via authenticated REST API endpoints so external apps, dashboards, or client systems can consume the data. Three methods: direct API, BloqItem public sharing, and Pages (Genesis) dashboard embedding.

## Prerequisites
- IRIS CLI authenticated
- Atlas schema created with records
- API token (Bearer auth) for authenticated access

## Method 1: Direct REST API (Authenticated)

The Atlas dataset endpoints are available at `/api/v1/atlas/datasets/{schema-slug}`. These require a Bearer token (Passport OAuth or service token).

### List records
```bash
$ curl -s https://raichu.heyiris.io/api/v1/atlas/datasets/cases \
    -H "Authorization: Bearer YOUR_TOKEN" \
    -H "Accept: application/json"
```

### Filter by field
```bash
$ curl -s "https://raichu.heyiris.io/api/v1/atlas/datasets/cases?filter[stage_name]=Negotiating" \
    -H "Authorization: Bearer YOUR_TOKEN"
```

### Search
```bash
$ curl -s "https://raichu.heyiris.io/api/v1/atlas/datasets/cases?search=Usman" \
    -H "Authorization: Bearer YOUR_TOKEN"
```

### Get summary stats
```bash
$ curl -s "https://raichu.heyiris.io/api/v1/atlas/datasets/cases/summary?group_by=stage_name&sum=invoice_total" \
    -H "Authorization: Bearer YOUR_TOKEN"
```

### Upsert (sync external data)
```bash
$ curl -s -X POST "https://raichu.heyiris.io/api/v1/atlas/datasets/cases/upsert" \
    -H "Authorization: Bearer YOUR_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "external_id": "CAS103544",
      "data": {
        "servis_case_id": "CAS103544",
        "patient_name": "Ayesha Usman",
        "stage_name": "Negotiating",
        "invoice_total": 1940908
      }
    }'
```

### Available endpoints
```
GET    /api/v1/atlas/schemas                  List all schemas
POST   /api/v1/atlas/schemas                  Create schema
GET    /api/v1/atlas/schemas/{slug}           Get schema definition
PATCH  /api/v1/atlas/schemas/{slug}           Update schema (creates new version)

GET    /api/v1/atlas/datasets/{slug}          List records (paginated)
POST   /api/v1/atlas/datasets/{slug}          Create record
GET    /api/v1/atlas/datasets/{slug}/summary  Aggregate stats
POST   /api/v1/atlas/datasets/{slug}/upsert   Upsert by external_id
GET    /api/v1/atlas/datasets/{slug}/{id}     Get single record
PATCH  /api/v1/atlas/datasets/{slug}/{id}     Update record
DELETE /api/v1/atlas/datasets/{slug}/{id}     Soft delete record
```

### Query parameters for listing
| Param | Example | Description |
|-------|---------|-------------|
| filter[field] | filter[stage_name]=Treating | Exact match on JSON field |
| search | search=Usman | Full-text search across all fields |
| sort | sort=invoice_total | Sort by JSON field |
| dir | dir=desc | Sort direction (asc/desc) |
| per_page | per_page=50 | Records per page (max 200) |
| bloq_id | bloq_id=40 | Filter by bloq |
| external_id | external_id=CAS103544 | Filter by external ID |

## Method 2: BloqItem Public Sharing (No Auth)

Atlas records are automatically projected into BloqItems for RAG search. Each BloqItem can be made public with a UUID link.

```bash
# Get the bloq item for a case
$ iris bloqs get 40   # Lists items in the Cases bloq list

# Make an item public (generates shareable URL)
# This is done via the API:
$ curl -X POST "https://raichu.heyiris.io/api/v1/users/1/bloqs/40/items/{item_id}/toggle-public" \
    -H "Authorization: Bearer YOUR_TOKEN"

# Public URL (no auth needed):
# https://elon.freelabel.net/iris/bloq/item/{public_uuid}
```

## Method 3: Genesis Dashboard Page

Build a dashboard page that renders dataset data live. The Pages system fetches data from iris-api's app-data proxy.

```bash
# Create a dashboard page for Pathways
$ iris pages compose "Pathways CFO Dashboard showing:
  - Pipeline overview: cases by stage with totals
  - Audit flags: services with $0 billing
  - Top 10 cases by invoice value
  - Financial summary: total pipeline value"

# The page will be served at:
# https://freelabel.net/p/pathways-cfo-dashboard
```

The dashboard page can pull live data from the Atlas dataset API on each page load.

## Method 4: Agent Integration (Chat-Based Access)

IRIS agents can query datasets directly via the `manage_dataset` integration:

```bash
# Chat with an agent that has Atlas access
$ iris agents chat <agent-id> "Show me all cases in Negotiating stage with invoice total over $10,000"

# The agent calls:
#   atlas manage_dataset action=query schema=cases filters={stage_name: "Negotiating"}
# Then filters results by invoice_total > 1000000 (cents)
```

## Example: Building a Client Dashboard

```bash
# 1. Create the schema (one-time)
$ iris atlas:datasets schemas show cases

# 2. Populate with data
# (via Servis AI sync or manual upsert)

# 3. Build the page
$ iris pages compose "Dashboard for Pathways Injury Consultants"

# 4. Share the URL with Haroon
# https://freelabel.net/p/pathways-dashboard

# 5. Set up daily audit email
$ iris schedules create \
    --agent=<cfo-agent-id> \
    --frequency=daily \
    --prompt="Run audit on cases dataset, email summary to rdelgado@vanguardhcs.com"
```

## Security notes
- REST API requires Bearer token auth (Passport OAuth or service token)
- BloqItem public sharing is opt-in per item (is_public flag)
- Pages are public by default when published (use unpublish to restrict)
- Agent access scoped by bloq_id (user_id + bloq_id tenancy boundary)

## Related recipes
- `atlas-datasets` — Atlas datasets CLI usage
- `pathways-cfo-workflow` — End-to-end Pathways accounting pipeline
- `pages` — Genesis page builder
