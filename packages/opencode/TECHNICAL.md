# IRIS Agent CLI — Technical Reference

## Overview

The IRIS Agent CLI (`iris`) is a unified terminal tool that combines:
1. **AI coding agent** — the opencode fork with full file, bash, LSP, and MCP tool access
2. **IRIS Platform CLI** — direct REST API access to all IRIS cloud platform resources

Binary: `iris` | Package: `iris-agent-cli` | Runtime: Bun

---

## Architecture

```
iris-agent-cli (opencode fork, TypeScript/Bun)
├── AI Coding Agent (TUI + run/generate commands)
│   ├── iris run "build me a feature"
│   ├── iris generate
│   └── iris tui (interactive TUI)
│
└── IRIS Platform Commands (direct HTTP to FL-API)
    ├── iris chat            → POST /api/chat/start + poll
    ├── iris agents          → /api/v1/users/{id}/bloqs/agents
    ├── iris leads           → /api/v1/leads
    ├── iris workflows       → /api/v1/users/{id}/workflows
    ├── iris bloqs           → /api/v1/users/{id}/bloqs
    ├── iris schedules       → /api/v1/schedules
    └── iris marketplace     → /api/v1/marketplace/skills
```

The CLI makes **direct HTTP calls** to the IRIS platform API — it does NOT import the Node or PHP ADK libraries.

---

## Key Files

| Path | Purpose |
|------|---------|
| `src/index.ts` | Entry point — yargs CLI setup, all command registrations |
| `src/cli/cmd/iris-api.ts` | **Shared platform helper**: `irisFetch()`, `requireAuth()`, `requireUserId()`, `handleApiError()`, display helpers |
| `src/cli/cmd/platform-chat.ts` | `iris chat` — polling workflow execution |
| `src/cli/cmd/platform-agents.ts` | `iris agents` — CRUD + chat |
| `src/cli/cmd/platform-leads.ts` | `iris leads` — CRM operations |
| `src/cli/cmd/platform-workflows.ts` | `iris workflows` — execute + status |
| `src/cli/cmd/platform-bloqs.ts` | `iris bloqs` — knowledge base + file ingest |
| `src/cli/cmd/platform-schedules.ts` | `iris schedules` — scheduled jobs |
| `src/cli/cmd/marketplace.ts` | `iris marketplace` — skill browsing + install |
| `src/auth/index.ts` | Auth storage at `~/.local/share/opencode/auth.json` |

---

## Platform API Helper (`iris-api.ts`)

```typescript
import { irisFetch, requireAuth, requireUserId, handleApiError } from "./iris-api"

// Auth-aware fetch to FL-API (default base)
const res = await irisFetch("/api/v1/leads")

// Custom base (IRIS-API for workflow system)
const res = await irisFetch("/api/chat/start", { method: "POST", body: ... }, IRIS_API)

// Guard — returns token or null (prints error message)
const token = await requireAuth()
if (!token) return

// UserId resolution: env var → /api/v1/me → null
const userId = await requireUserId(args["user-id"])
if (!userId) return

// Error handling — returns false and prints message on error
const ok = await handleApiError(res, "Create lead")
if (!ok) return
```

### Auth Token Resolution Priority

1. `Auth.get("iris")` — stored via `iris auth login` at `~/.local/share/opencode/auth.json`
2. `IRIS_API_KEY` env var (backwards compat with PHP CLI users)

### User ID Resolution Priority

1. `--user-id` CLI flag (per-command)
2. `IRIS_USER_ID` env var
3. Auto-fetch from `GET /api/v1/me`

---

## Adding a New Platform Command

```typescript
// src/cli/cmd/platform-{name}.ts

import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, dim, bold } from "./iris-api"

const MyListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list my resources",
  builder: (yargs) =>
    yargs.option("limit", { type: "number", default: 20 }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  My Resources")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/my-resources?per_page=${args.limit}`)
      const ok = await handleApiError(res, "List resources")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any[] }
      const items: any[] = data?.data ?? []
      spinner.stop(`${items.length} item(s)`)

      printDivider()
      for (const item of items) {
        console.log(`  ${bold(item.name)}  ${dim(`#${item.id}`)}`)
      }
      printDivider()

      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

export const PlatformMyResourceCommand = cmd({
  command: "my-resource",
  describe: "manage my resources",
  builder: (yargs) => yargs.command(MyListCommand).demandCommand(),
  async handler() {},
})
```

Then register in `src/index.ts`:
```typescript
import { PlatformMyResourceCommand } from "./cli/cmd/platform-my-resource"
// ...
.command(PlatformMyResourceCommand)
```

---

## API Endpoints Reference

### FL-API (`apiv2.heyiris.io`)

| Resource | List | Get | Create |
|----------|------|-----|--------|
| Agents | `GET /api/v1/users/{id}/bloqs/agents` | `GET .../agents/{id}` | `POST .../agents` |
| Leads | `GET /api/v1/leads` | `GET /api/v1/leads/{id}` | `POST /api/v1/leads` |
| Bloqs | `GET /api/v1/users/{id}/bloqs` | `GET .../bloqs/{id}` | `POST .../bloqs` |
| Workflows | `GET /api/v1/users/{id}/workflows` | `GET /api/v1/workflows/runs/{id}` | - |
| Schedules | `GET /api/v1/schedules` | `GET /api/v1/schedules/{id}` | - |
| Marketplace | `GET /api/v1/marketplace/skills` | `GET .../skills/{slug}` | - |

### Chat / Workflow Execution

```
POST /api/chat/start          → { workflow_id }
GET  /api/workflows/{id}      → { status, summary, error }
POST /api/v1/workflows/{id}/execute/v6
GET  /api/v1/workflows/runs/{id}
```

---

## Testing

```bash
cd packages/opencode

# Run all tests
bun test

# Run only platform tests
bun test test/platform/

# Run specific test file
bun test test/platform/iris-api.test.ts
bun test test/platform/platform-commands.test.ts

# Run with verbose output
bun test --verbose test/platform/
```

### Test Strategy

- **`test/platform/iris-api.test.ts`** — Unit tests for helper functions, ANSI display, `handleApiError`, `irisFetch` with mocked fetch
- **`test/platform/platform-commands.test.ts`** — Command export shape, subcommand structure, API response parsing patterns, fetch integration with mocked responses

---

## Build & Install

```bash
# Build binary
bun run build

# Install locally (dev)
bun run --conditions=browser ./src/index.ts

# Install script (production)
curl -fsSL https://heyiris.io/install-code | bash
```

The install script downloads a pre-built binary from `github.com/FREELABEL/iris-opencode/releases`.

---

## Phase 2+ Platform Commands (Planned)

The following commands are planned for Phase 2+:

```
iris rag          search <agent-id> <query>, index <agent-id> <text>
iris integrations list, execute <id>
iris automations  list, run <id>, status <run-id>
iris social       publish, status <id>, history
iris tools        list, run <name>
iris articles     list, create, generate
iris voice        list, configure
iris phone        list, get <id>
iris audio        merge, transcribe <url>
iris courses      list, get <id>, enroll <id>
iris payments     list, wallet
iris products     list, get <id>
iris pages        list, get <slug>
iris programs     list, enroll <id>
iris users        me, list
iris profiles     me, update
iris services     list, get <id>
iris usage        summary, details
iris iris-models  list
```
