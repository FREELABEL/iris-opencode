# IRIS How-To Recipes

This directory contains step-by-step recipes for common IRIS workflows. Each file is **self-contained** — assume the agent reads only one recipe at a time, so each file repeats whatever context it needs.

## When to read what

| User intent (what they say) | Read this recipe |
|---|---|
| "I just installed iris", "how do I sign in", "auth not working", "where's my .env" | `iris-login.md` |
| "send a campaign", "outreach", "find leads on linkedin/twitter/instagram", "DM people", "discover prospects" | `outreach-campaign.md` |
| "connect my machine", "hive", "distributed", "run on multiple machines", "node not registering" | `hive-dispatch.md` |
| "send a proposal", "create a deal", "invoice a client", "contract", "payment gate" | `lead-to-proposal.md` |
| "manage deals", "deal pipeline", "deal status", "payment reminder", "stale deals", "win-back", "recover deal" | `deals.md` |
| "build a page", "create a landing page", "genesis", "add components", "page builder" | `pages.md` |
| "dataset", "schema", "custom data", "store records", "atlas datasets", "create a tracker" | `atlas-datasets.md` |
| "expose data", "REST API", "public endpoint", "serve data", "embed dataset", "dashboard API" | `expose-dataset-api.md` |
| "pathways", "CFO", "cases", "servis ai", "quickbooks", "billing audit", "service AI sync" | `pathways-cfo-workflow.md` |
| "track finances", "ledger", "transactions", "revenue", "expenses", "accounts" | `track-finances-atlas-ledger.md` |
| "staff", "contractors", "team", "contracts", "signing" | `manage-staff-and-contracts.md` |
| "events", "venue", "stages", "set times", "vendors", "tickets" | `event-production.md` |

## How to use these files

1. **List the directory** to see what's available: `ls ~/.iris/how-to/`
2. **Read this README** to map the user's intent to a recipe
3. **Read the recipe file** for exact commands, expected output, and gotchas
4. **Run the commands** with the user's specific values substituted in

## File format

Every recipe follows the same structure:

- **What this does** — one-sentence summary
- **Prerequisites** — what must be true before starting (auth state, installed daemons, etc.)
- **Steps** — numbered, exact commands with `$` prefixes for what to run
- **Expected output** — what success looks like
- **Common errors** — failure modes and fixes
- **Related recipes** — links to other files in this directory

## Adding new recipes

These files are managed by the IRIS installer and updated from `https://github.com/FREELABEL/iris-opencode/tree/dev/scaffold/how-to/`. To add a new recipe:

1. Open a PR against `FREELABEL/iris-opencode` adding `scaffold/how-to/<your-recipe>.md`
2. Add an entry to `scaffold/manifest.json`
3. Update this `README.md` with the user-intent mapping
4. On next install (or `iris install --only-docs`), users get the new recipe
