# Refactor: Centralize iMessage + Contact Resolution

## Problem

iMessage SQLite access and phone→lead resolution are duplicated across 5 files. Each has its own `queryMessages()`, its own DB path, its own lead lookup. Bug fixes have to be applied in multiple places and they drift.

## Files with duplicate iMessage logic

| File | What it does | Duplicate code |
|------|-------------|----------------|
| `src/cli/cmd/platform-imessage.ts` | Search, chats, send, read | `queryMessages()`, `MESSAGES_DB`, lead resolution (2 places) |
| `src/cli/cmd/platform-atlas-comms.ts` | Ingest iMessage into lead_comms | `MESSAGES_DB`, `execSync(sqlite3...)`, `resolveLead()` |
| `src/cli/cmd/platform-customer.ts` | Customer iMessage lookup | `queryMessagesDb()`, separate DB path |
| `src/cli/cmd/platform-leads.ts` | Pulse iMessage scan | Bridge HTTP call (different approach, same goal) |
| `src/cli/cmd/platform-doctor.ts` | Health check for iMessage access | Inline `execSync(sqlite3...)` |

## What to extract

### 1. `src/cli/lib/imessage.ts` — iMessage SQLite utility

```typescript
// Single source of truth for iMessage database access
import { execSync } from "child_process"
import { homedir } from "os"
import { existsSync } from "fs"

const MESSAGES_DB = `${homedir()}/Library/Messages/chat.db`

export function isAvailable(): boolean {
  return process.platform === "darwin" && existsSync(MESSAGES_DB)
}

export function query(sql: string): string {
  return execSync(`sqlite3 "${MESSAGES_DB}" "${sql.replace(/"/g, '\\"')}"`, {
    encoding: "utf-8",
    timeout: 10000,
  }).trim()
}

export function searchByHandle(handle: string, days = 30, limit = 50): Message[] {
  // Normalize phone to last 10 digits
  const digits = handle.replace(/[^0-9]/g, "")
  const search = digits.length >= 10 ? digits.slice(-10) : handle

  const cutoffSeconds = days * 86400
  const sql = `SELECT ... WHERE chat_identifier LIKE '%${search}%' AND date > cutoff`
  // Return parsed messages
}

export function listChats(days = 30, limit = 50): Chat[] {
  // Return recent conversations
}

export interface Message {
  id: string
  date: string
  from_me: boolean
  text: string
  chat_identifier?: string
}

export interface Chat {
  identifier: string
  message_count: number
  last_message: string
}
```

### 2. `src/cli/lib/contacts.ts` — Contact resolution utility

```typescript
// Single source of truth for phone/email → lead name resolution
import { irisFetch } from "../cmd/iris-api"

// Cache to avoid repeated API calls for the same number in one session
const cache = new Map<string, string | null>()

export async function resolveContactName(identifier: string): Promise<string | null> {
  if (cache.has(identifier)) return cache.get(identifier) ?? null

  const digits = identifier.replace(/[^0-9]/g, "")
  const search = digits.length >= 10 ? digits.slice(-10) : identifier

  try {
    const res = await irisFetch(`/api/v1/leads?search=${encodeURIComponent(search)}&per_page=1`)
    if (res.ok) {
      const data = (await res.json()) as any
      const leads = data?.data ?? []
      if (Array.isArray(leads) && leads.length > 0) {
        const name = leads[0].name ?? leads[0].first_name ?? null
        cache.set(identifier, name)
        return name
      }
    }
  } catch {}

  cache.set(identifier, null)
  return null
}

export async function resolveContactNames(identifiers: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  // Batch — resolve up to 10 in parallel
  const batch = identifiers.slice(0, 10)
  await Promise.allSettled(batch.map(async (id) => {
    const name = await resolveContactName(id)
    if (name) result.set(id, name)
  }))
  return result
}
```

## Files to refactor

### `platform-imessage.ts`
- Delete `MESSAGES_DB`, `queryMessages()`
- Import from `../lib/imessage`
- Replace inline lead resolution with `resolveContactName()`
- Replace bulk resolution with `resolveContactNames()`

### `platform-atlas-comms.ts`
- Delete `MESSAGES_DB`, inline `execSync(sqlite3...)`
- Import `query()` and `searchByHandle()` from `../lib/imessage`
- Replace `resolveLead()` with shared `resolveContactName()`

### `platform-customer.ts`
- Delete `queryMessagesDb()`
- Import from `../lib/imessage`

### `platform-leads.ts` (pulse)
- Pulse iMessage scan uses the bridge HTTP API (different path) — leave as-is for now
- But lead resolution in pulse should use `resolveContactName()` from the shared lib

### `platform-doctor.ts`
- Replace inline `execSync(sqlite3...)` with `isAvailable()` from shared lib

## Tests to write

File: `test/cli/imessage-contacts.test.ts`

```typescript
describe("contacts resolution", () => {
  test("normalizes phone to last 10 digits")
  test("caches results — second call doesn't hit API")
  test("returns null for unknown contacts")
  test("batch resolution deduplicates")
})

describe("iMessage utility", () => {
  test("isAvailable returns false on non-darwin")
  test("query escapes double quotes in SQL")
  test("searchByHandle normalizes phone digits")
})
```

## Implementation order

1. Create `src/cli/lib/imessage.ts` — extract from `platform-imessage.ts`
2. Create `src/cli/lib/contacts.ts` — extract lead resolution
3. Write tests for both
4. Refactor `platform-imessage.ts` to use shared libs
5. Refactor `platform-atlas-comms.ts`
6. Refactor `platform-customer.ts`
7. Refactor `platform-doctor.ts`
8. Run full test suite — 777+ tests must still pass
9. Build and verify CLI works

## Notes

- The pulse iMessage scan in `platform-leads.ts` uses the bridge HTTP API at `localhost:3200`, not direct SQLite. This is a different code path and should stay separate for now — the bridge handles the SQLite access on the daemon side.
- The `resolveContactName` cache is per-session (in-memory Map). It won't persist across CLI invocations. This is intentional — leads can change between runs.
- Don't break the `--json` output format on any command — scripts may depend on it.
