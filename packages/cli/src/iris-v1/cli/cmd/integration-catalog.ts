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
  /** Where the customer goes to issue the credential — `auth.setup_url` in the yml. */
  setupUrl?: string
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
    // 18 connectors already publish this and nothing has ever rendered it — the one link a
    // customer needs at the exact moment they are asked for a key.
    setupUrl: str(auth?.setup_url) || undefined,
    fields: rawFields
      .map((f) => ({
        // Most yml files spell it `name`; tradovate spells it `key`, and reading only `name`
        // dropped all five of its required credentials on the floor — so the CLI saw a
        // connector with no fields, prompted for nothing, and posted an empty credential.
        name: (str(f?.name) || str(f?.key)).trim(),
        label: str(f?.label) || undefined,
        // The ymls overwhelmingly write `help_text`; only wix writes `description`. Reading
        // one and not the other silently threw away the guidance for 13 of the 14 connectors
        // that had bothered to write it — including every line that names where to get a key.
        description: (str(f?.description) || str(f?.help_text)) || undefined,
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

/**
 * Is `target` an integration — given the list compiled into this binary, its slug aliases, and
 * whatever the live registry returned?
 *
 * `exec <type> <fn>` branches on this. When it says no, the call falls through to the V6
 * system-tool path, which DISCARDS the function argument and asks for a tool named by the bare
 * type — so a real integration answers "Unknown tool: <type>", the same words an unregistered
 * one produces. Measured 2026-09-06: the compiled array held 41 types and the registry 95, and
 * everything in that gap failed this way.
 *
 * The compiled list is checked first so the common case costs no network, and it is a fallback
 * rather than the authority: when the registry is unreachable, `entries` is empty and behaviour
 * is exactly what it was before the lookup existed.
 */
export function isKnownIntegration(
  target: string,
  compiled: readonly string[],
  aliases: Record<string, string>,
  entries: CatalogEntry[],
): boolean {
  const wanted = String(target ?? "").trim().toLowerCase()
  if (!wanted) return false
  if (compiled.includes(wanted)) return true

  const alias = aliases?.[wanted]
  if (alias && compiled.includes(alias)) return true

  return findEntry(entries, wanted) !== null || (alias ? findEntry(entries, alias) !== null : false)
}

/**
 * Would `connect` post an empty credential?
 *
 * A non-OAuth connector whose registry entry declares no `auth.fields` collects nothing:
 * `missingRequired` is empty, so the prompt never fires, and the flow posts `credentials: {}`.
 * The API answers 422 and the CLI reports "Could not store the credential" — blaming storage
 * for a value that was never gathered, at the exact moment someone is trying to connect.
 *
 * Eight connectors were in this state on 2026-09-06 (1password, apollo, cloudflare-api-key,
 * google-gemini, mailjet, mercury, reclaim, vapi), each because its
 * `config/integrations/<type>.yml` declares `auth: {type: api_key}` and no fields.
 *
 * The field names cannot be guessed — mailjet needs api_key AND api_secret, and storing a
 * half-credential would move the failure somewhere later and less legible. So the caller
 * refuses and says where the gap is.
 */
export function hasNothingToCollect(entry: CatalogEntry, provided: Record<string, string>): boolean {
  // Narrow on purpose. Run against the live registry, the obvious formulation
  // ("non-OAuth, no required fields, nothing supplied") matched 28 of 95 connectors, and
  // 16 of them were working correctly. Each exclusion below is one of those, found by
  // measuring rather than by reasoning about it:
  //
  //   auth: none        atlas-os, genesis, pathways, macos and ~12 more are in-process and
  //                     hold no credential. An empty POST is the CORRECT call for them.
  //   optional fields   courtlistener and google-scholar-legal declare a field with
  //                     `required: false` — both work unauthenticated, at a lower rate limit.
  //   other schemes     savelife-ai is `keycloak`. Whatever that flow does, it is not one
  //                     this guard has evidence about, so it is left alone.
  //
  // What is left is the case actually diagnosed: `api_key`, no declared fields at all, and
  // nothing passed on the command line.
  if (isOAuthEntry(entry)) return false
  if (entry.authType !== "api_key") return false
  if (entry.fields.length > 0) return false
  return Object.keys(provided ?? {}).length === 0
}
