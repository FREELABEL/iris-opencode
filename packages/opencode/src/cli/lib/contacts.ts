/**
 * Contact resolution utility — single source of truth for phone/email → lead name.
 *
 * Used by: platform-imessage.ts, platform-atlas-comms.ts, platform-leads.ts
 * Cache is per-session (in-memory Map), intentionally not persisted.
 */

import { irisFetch } from "../cmd/iris-api"
import { resolveFromAddressBook, findContactsByName } from "./address-book"

export interface ResolvedHandle {
  name: string
  handle: string // phone (last 10 digits) or email
}

/**
 * Resolve a free-text name to a saved contact's iMessage handle (phone or email)
 * via macOS Contacts. Returns null if no saved contact matches.
 */
export function resolveHandleByName(name: string): ResolvedHandle | null {
  const matches = findContactsByName(name)
  for (const m of matches) {
    if (m.phones.length) return { name: m.name, handle: m.phones[0] }
    if (m.emails.length) return { name: m.name, handle: m.emails[0] }
  }
  return null
}

const cache = new Map<string, string | null>()

/**
 * Normalize a phone/email/handle for search.
 * Handles E.164 (+14695633672), parens ((469) 563-3672), and raw digits.
 */
function normalizeForSearch(identifier: string): string {
  // Strip + prefix and all non-digits
  const digits = identifier.replace(/[^0-9]/g, "")
  // If it looks like a phone (7+ digits), take last 10 (strip country code)
  if (digits.length >= 7) return digits.slice(-10)
  return identifier
}

/**
 * Resolve a phone number, email, or handle to a lead name.
 * Returns null if no match found. Results are cached per-session.
 */
export async function resolveContactName(identifier: string): Promise<string | null> {
  if (!identifier) return null
  if (cache.has(identifier)) return cache.get(identifier) ?? null

  // 1. Local macOS Contacts (AddressBook) — instant, no network, and the
  //    authoritative source for personal contacts who aren't CRM leads.
  const saved = resolveFromAddressBook(identifier)
  if (saved) {
    cache.set(identifier, saved)
    return saved
  }

  // 2. Fall back to the leads CRM for business contacts not in Contacts.app.
  const search = normalizeForSearch(identifier)

  try {
    const res = await irisFetch(`/api/v1/leads?search=${encodeURIComponent(search)}&per_page=5`)
    if (res.ok) {
      const data = (await res.json()) as any
      const leads = data?.data?.data ?? data?.data ?? []
      if (Array.isArray(leads) && leads.length > 0) {
        // Prefer a lead whose name contains the search term (case-insensitive)
        const searchLower = search.toLowerCase()
        const nameMatch = leads.find((l: any) =>
          (l.name || l.nickname || "").toLowerCase().includes(searchLower)
        )
        const lead = nameMatch ?? leads[0]
        const name = lead.name ?? lead.nickname ?? lead.first_name ?? null
        cache.set(identifier, name)
        return name
      }
    }
  } catch {}

  cache.set(identifier, null)
  return null
}

/**
 * Batch-resolve multiple identifiers to names.
 * Resolves up to 10 in parallel, returns a Map of identifier → name.
 */
export async function resolveContactNames(identifiers: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const unique = [...new Set(identifiers.filter(Boolean))]

  // Pass 1 — resolve everything possible from local Contacts (free, no network).
  const unresolved: string[] = []
  for (const id of unique) {
    if (cache.has(id)) {
      const cached = cache.get(id)
      if (cached) result.set(id, cached)
      continue
    }
    const saved = resolveFromAddressBook(id)
    if (saved) {
      cache.set(id, saved)
      result.set(id, saved)
    } else {
      unresolved.push(id)
    }
  }

  // Pass 2 — only the leftovers hit the CRM, still bounded to avoid hammering it.
  const batch = unresolved.slice(0, 10)
  await Promise.allSettled(
    batch.map(async (id) => {
      const name = await resolveContactName(id)
      if (name) result.set(id, name)
    })
  )

  return result
}

/**
 * Clear the cache (useful for testing or long-running sessions).
 */
export function clearContactCache(): void {
  cache.clear()
}
