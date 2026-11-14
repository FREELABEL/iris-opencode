/**
 * The integration catalog, as the SERVER knows it.
 *
 * WHY THIS EXISTS (#182712, measured 2026-08-28).
 *
 * `list-available` iterated a hardcoded array compiled into this binary. Two more hardcoded
 * lists sat beside it (APIKEY_TYPES, COMPOSIO_APIKEY_TOOLKITS). So the catalog a person
 * browses was whatever someone last remembered to type here:
 *
 *     CLI showed                        41
 *     server registry, enabled          69
 *     BUILT BUT INVISIBLE               37
 *
 * Among the invisible: wix, shopify, jira, linkedin, trello, zoho, notion, discord. A user
 * asked an agent "can we connect to wix" and was told Wix was not an available integration
 * and offered a custom build — while WixIntegrationService.php and wix.yml had been live for
 * some time, with seven working functions.
 *
 * The server already serves the real thing at /api/v1/integrations-temp/registry, including
 * each integration's auth TYPE and the exact credential FIELDS with labels and help text.
 * Driving the CLI from that means a new integration is self-serve the day it ships, with no
 * CLI release — which is the actual fix, rather than adding "wix" to an array and waiting
 * for the next one to go missing.
 */

export interface CatalogAuthField {
  name: string
  label?: string
  description?: string
  required?: boolean
}

export interface CatalogEntry {
  type: string
  name: string
  description?: string
  category?: string
  authType: string
  fields: CatalogAuthField[]
  functions: string[]
  isLive: boolean
  isConnected: boolean
  source?: string
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

export function normalizeEntry(raw: any): CatalogEntry | null {
  const type = str(raw?.type).trim().toLowerCase()
  if (!type) return null

  const auth = raw?.auth ?? {}
  const rawFields: any[] = Array.isArray(auth?.fields) ? auth.fields : []

  return {
    type,
    name: str(raw?.name) || type,
    description: str(raw?.description) || undefined,
    category: str(raw?.category) || undefined,
    // A missing auth block means nobody declared one. Treat that as oauth2 — the historical
    // default this CLI assumed — rather than inventing a credential prompt for it.
    authType: (str(auth?.type) || "oauth2").toLowerCase(),
    fields: rawFields
      .map((f) => ({
        name: str(f?.name).trim(),
        label: str(f?.label) || undefined,
        description: str(f?.description) || undefined,
        // Only an explicit `false` makes a declared field optional.
        required: f?.required !== false,
      }))
      .filter((f) => f.name.length > 0),
    functions: Array.isArray(raw?.functions) ? raw.functions.map(str).filter(Boolean) : [],
    isLive: raw?.isLive !== false,
    isConnected: raw?.isConnected === true,
    source: str(raw?.source) || undefined,
  }
}

/** Accepts the registry envelope in any of the shapes the endpoint has used. */
export function normalizeCatalog(payload: any): CatalogEntry[] {
  const rows = payload?.data ?? payload?.integrations ?? (Array.isArray(payload) ? payload : [])
  if (!Array.isArray(rows)) return []

  const seen = new Set<string>()
  const out: CatalogEntry[] = []
  for (const row of rows) {
    const e = normalizeEntry(row)
    if (!e || seen.has(e.type)) continue
    seen.add(e.type)
    out.push(e)
  }
  return out
}

export function findEntry(entries: CatalogEntry[], type: string): CatalogEntry | null {
  const wanted = String(type ?? "").trim().toLowerCase()
  return entries.find((e) => e.type === wanted) ?? null
}

/**
 * Does this integration authorise through a browser?
 *
 * Anything that declares credential FIELDS is answered by collecting them, whatever the
 * auth label says — that is the distinction the old APIKEY_TYPES array was standing in for,
 * and it got Wix wrong: wix is api_key, was absent from that array, so `connect wix` fell
 * through to the OAuth branch and died with "OAuth URL generation not supported".
 */
export function isOAuthEntry(entry: CatalogEntry): boolean {
  if (entry.fields.length > 0) return false
  return entry.authType.startsWith("oauth")
}

export function requiredFields(entry: CatalogEntry): CatalogAuthField[] {
  return entry.fields.filter((f) => f.required !== false)
}

export function missingRequired(entry: CatalogEntry, provided: Record<string, string>): CatalogAuthField[] {
  return requiredFields(entry).filter((f) => !String(provided?.[f.name] ?? "").trim())
}

/** `--field api_key=abc --field site_id=123` → { api_key: "abc", site_id: "123" } */
export function parseFieldFlags(pairs: string[] | string | undefined): Record<string, string> {
  const list = Array.isArray(pairs) ? pairs : pairs ? [pairs] : []
  const out: Record<string, string> = {}
  for (const raw of list) {
    const s = String(raw ?? "")
    const eq = s.indexOf("=")
    if (eq <= 0) continue
    const k = s.slice(0, eq).trim()
    const v = s.slice(eq + 1)
    if (k) out[k] = v
  }
  return out
}

/**
 * The exact command that would work — for a caller with no terminal to be prompted in.
 *
 * "No credentials provided. Use --api-key, --token, or --webhook-url" was the old message,
 * and for Wix every one of those three was wrong.
 */
export function connectCommandHint(entry: CatalogEntry): string {
  const fields = requiredFields(entry)
  if (fields.length === 0) return `iris integrations connect ${entry.type}`
  const flags = fields.map((f) => `--field ${f.name}=<${f.name}>`).join(" ")
  return `iris integrations connect ${entry.type} ${flags}`
}

export function groupByCategory(entries: CatalogEntry[]): Array<[string, CatalogEntry[]]> {
  const groups = new Map<string, CatalogEntry[]>()
  for (const e of entries) {
    const key = e.category || "other"
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(e)
  }
  return [...groups.entries()]
    .map(([k, v]) => [k, v.sort((a, b) => a.type.localeCompare(b.type))] as [string, CatalogEntry[]])
    .sort((a, b) => a[0].localeCompare(b[0]))
}
