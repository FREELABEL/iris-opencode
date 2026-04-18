/**
 * Contact resolution utility — single source of truth for phone/email → lead name.
 *
 * Used by: platform-imessage.ts, platform-atlas-comms.ts, platform-leads.ts
 * Cache is per-session (in-memory Map), intentionally not persisted.
 */

import { irisFetch } from "../cmd/iris-api"

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

  const search = normalizeForSearch(identifier)

  try {
    const res = await irisFetch(`/api/v1/leads?search=${encodeURIComponent(search)}&per_page=1`)
    if (res.ok) {
      const data = (await res.json()) as any
      const leads = data?.data?.data ?? data?.data ?? []
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

/**
 * Batch-resolve multiple identifiers to names.
 * Resolves up to 10 in parallel, returns a Map of identifier → name.
 */
export async function resolveContactNames(identifiers: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const unique = [...new Set(identifiers.filter(Boolean))]
  const batch = unique.slice(0, 10)

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
