import { cmd } from "./cmd"
import {
  IntegrationsShareCommand,
  IntegrationsUnshareCommand,
  IntegrationsDisconnectCommand,
  IntegrationsSetupNativeCommand,
} from "./platform-integrations"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  requireUserId,
  handleApiError,
  printDivider,
  dim,
  bold,
  success,
  highlight,
  IRIS_API,
  FL_API,
  PLATFORM_URLS,
  getBridgeToken, writeJson } from "./iris-api"
import { exec } from "child_process"
import { randomBytes } from "node:crypto"
import { detectNewConnection, extractConnections, shouldPrintUrlOnly, type ConnectionRow } from "./integration-connect-state"
import { verifyProbeFor, isProbeSuccess, isProbeInconclusive } from "./integration-verify-probe"
import {
  normalizeCatalog, normalizeEntry, findEntry, isOAuthEntry, requiredFields,
  missingRequired, parseFieldFlags, connectCommandHint, groupByCategory,
  type CatalogEntry,
} from "./integration-catalog"
import { isLocalOAuthProvider, runLocalOAuthConnect } from "./integration-oauth-connect"
import { PathwaysCommand } from "./platform-integrations-pathways"
import { firstArray } from "../../util/array"

// ============================================================================
// Known integration types — anything else routes to V6 system tools.
// ============================================================================

const INTEGRATION_TYPES = [
  // Communication
  "gmail", "outlook", "slack", "whatsapp",
  // Calendar
  "google-calendar", "outlook-calendar",
  // Storage / Docs
  "google-drive", "googledrive", "google-docs", "googledocs", "dropbox", "onedrive",
  // Design / Content
  "canva", "buffer",
  // CRM / Lead enrichment
  "apollo", "hubspot", "pipedrive",
  // Accounting / Banking
  "quickbooks", "xero", "mercury",
  // Payments
  "stripe",
  // Secrets
  "1password",
  // Advertising
  // #180716-adjacent: the 16 Meta Ads actions were mapped in fl-iris-api's ComposioClient
  // all along, but this list is what `iris integrations connect` offers — so the toolkit was
  // built and unreachable. Adding the string is the whole fix.
  "meta-ads",
  // Legal practice management
  "clio",
  // Infrastructure
  "cloudflare", "github",
  // Internal
  "atlas-os", "beatbox-showcase", "copycat-ai", "fal-ai", "fl-api",
  "genesis", "github-copilot", "google-gemini", "macos", "savelife-ai",
  "servis-ai", "twitch", "vagaro", "vapi", "workflow-composer",
]

// Known functions per integration — shown when user runs `exec <type>` without a function
const INTEGRATION_FUNCTIONS: Record<string, { name: string; description: string }[]> = {
  // Verified against GET /v3/tools?toolkit_slug=metaads — the toolkit publishes 16 tools.
  // NOTE: it has NO ad-account, business or page discovery, so every create needs an
  // ad_account_id the caller already has.
  "meta-ads": [
    { name: "create_campaign", description: "Create a campaign (objective, budget, status)" },
    { name: "update_campaign", description: "Update a campaign" },
    { name: "pause_campaign", description: "Pause a campaign — stops spend" },
    { name: "resume_campaign", description: "Resume a paused campaign" },
    { name: "delete_campaign", description: "Delete a campaign" },
    { name: "create_ad_set", description: "Create an ad set (targeting, schedule, budget)" },
    { name: "read_adsets", description: "Read ad sets for a campaign" },
    { name: "create_ad", description: "Create an ad inside an ad set" },
    { name: "create_ad_creative", description: "Create the creative (copy + image)" },
    { name: "get_ad_creative", description: "Fetch one creative" },
    { name: "update_ad_creative", description: "Update a creative" },
    { name: "delete_ad_creative", description: "Delete a creative" },
    { name: "upload_ad_image", description: "Upload the graphic and get an image hash" },
    { name: "preview_ad_creative", description: "Render the ad before it goes live (approval step)" },
    { name: "create_custom_audience", description: "Create a custom audience" },
    { name: "get_insights", description: "Performance data for a campaign/ad set/ad" },
  ],
  "gmail": [
    { name: "read_emails", description: "Read emails from inbox (limit, unread_only, query)" },
    { name: "search_emails", description: "Search emails with Gmail query syntax" },
    { name: "send_email", description: "Send an email (to, subject, body)" },
  ],
  "google-drive": [
    { name: "search_files", description: "Search for files by name" },
    { name: "export_file", description: "Export a file as plain text (file_id)" },
    { name: "read_doc", description: "Read a Google Doc (alias for export_file)" },
  ],
  "google-calendar": [
    { name: "get_events", description: "Get calendar events (max_results, time_min, time_max)" },
    { name: "create_event", description: "Create a calendar event" },
    { name: "update_event", description: "Update an event (event_id, title, start_time, end_time, description, location)" },
    { name: "delete_event", description: "Delete an event (event_id)" },
  ],
  "slack": [
    { name: "send_message", description: "Send a message to a channel (channel, text)" },
    { name: "list_channels", description: "List available channels" },
  ],
  "canva": [
    { name: "list_designs", description: "List your Canva designs" },
    { name: "export_design", description: "Export a design (design_id, format)" },
  ],
  "buffer": [
    { name: "create_post", description: "Schedule a social post (text, profile_ids)" },
    { name: "list_profiles", description: "List connected social profiles" },
  ],
  "mercury": [
    { name: "list_accounts", description: "List all bank accounts with balances" },
    { name: "get_account", description: "Get account details (account_id)" },
    { name: "get_transactions", description: "Get transactions (account_id, start, end, search, limit)" },
    { name: "get_transaction", description: "Get single transaction detail (transaction_id)" },
    { name: "get_recipients", description: "List saved payment recipients" },
    { name: "generate_tax_summary", description: "Yearly P&L breakdown for tax prep (account_id, year)" },
    { name: "categorize_expenses", description: "AI-categorize expenses by tax category (account_id, start, end)" },
    { name: "find_1099_payments", description: "Find payments >$600 per recipient for 1099s (account_id, year)" },
  ],
  "twitch": [
    { name: "get_users", description: "Get your Twitch profile (username, email, broadcaster type)" },
    { name: "get_streams", description: "Get live streams (user_id, game_id, language, first)" },
    { name: "get_channel_information", description: "Get channel details (broadcaster_id)" },
    { name: "modify_channel_information", description: "Update title/game/tags (broadcaster_id, title, game_id)" },
    { name: "search_channels", description: "Search channels by name (query, live_only)" },
    { name: "get_channel_followers", description: "Get followers (broadcaster_id, first)" },
    { name: "get_user_subscriptions", description: "Get subscribers (broadcaster_id)" },
    { name: "get_clips", description: "Get clips (broadcaster_id, first, started_at, ended_at)" },
    { name: "get_videos", description: "Get VODs/highlights (user_id, type, first)" },
    { name: "get_chatters", description: "Get chatters in chat (broadcaster_id, moderator_id)" },
    { name: "send_chat_message", description: "Send chat message (broadcaster_id, sender_id, message)" },
    { name: "get_top_games", description: "Get trending games/categories (first)" },
    { name: "search_categories", description: "Search game categories (query)" },
    { name: "get_stream_schedule", description: "Get stream schedule (broadcaster_id)" },
    { name: "get_followed_streams", description: "Get live streams you follow (user_id)" },
    { name: "create_stream_marker", description: "Bookmark a stream moment (user_id, description)" },
  ],
}

const OAUTH_TYPES = [
  "google-drive", "google-docs", "google-calendar", "gmail",
  "outlook", "outlook-calendar", "onedrive",
  "slack", "github", "mailchimp",
  "canva", "dropbox", "apollo", "hubspot", "pipedrive",
  "quickbooks", "xero",
  "1password",
  "twitch",
  "whatsapp",
  // Meta Marketing API — OAuth2, needs an app with ads_management. Composio carries the
  // app registration, which is why this works where a direct integration does not.
  "meta-ads",
]
const APIKEY_TYPES = ["vapi", "servis-ai", "smtp-email", "mailjet", "google-gemini", "savelife-ai", "mercury"]

// Composio toolkits that use API key auth (use `iris integrations setup <type>-api-key --api-key <key>`)
const COMPOSIO_APIKEY_TOOLKITS: Record<string, string> = {
  cloudflare: "cloudflare_api_key",
  openai: "openai_api_key",
  anthropic: "anthropic_api_key",
  perplexity: "perplexity_api_key",
}

function isIntegration(t: string): boolean {
  return INTEGRATION_TYPES.includes(t.toLowerCase())
}

/**
 * The catalog the SERVER knows, with the hardcoded array as a labelled fallback.
 *
 * #182712: the array above listed 41 types while the registry held 69 enabled ones, so 37
 * built integrations — wix, shopify, jira, linkedin, trello, zoho, notion … — could not be
 * found or connected by anyone. The registry is the source of truth; this binary's list is
 * only a last resort, and when we fall back to it we SAY so rather than presenting a partial
 * catalog as the whole thing.
 */
async function loadCatalog(): Promise<{ entries: CatalogEntry[]; degraded: string | null }> {
  try {
    const res = await irisFetch("/api/v1/integrations-temp/registry", {}, IRIS_API)
    if (res.ok) {
      const entries = normalizeCatalog(await res.json())
      if (entries.length > 0) return { entries, degraded: null }
      return { entries: fallbackCatalog(), degraded: "the registry returned nothing" }
    }
    return { entries: fallbackCatalog(), degraded: `registry HTTP ${res.status}` }
  } catch (e) {
    return { entries: fallbackCatalog(), degraded: e instanceof Error ? e.message : String(e) }
  }
}

function fallbackCatalog(): CatalogEntry[] {
  return INTEGRATION_TYPES.map((t) => normalizeEntry({ type: t })!).filter(Boolean)
}

// Fetch a Composio auth_config and build the connection.state.val payload
// using its expected_input_fields. Composio v3 requires credentials on the
// connected_account in the exact field shape declared by the auth_config.
async function buildComposioConnectionState(
  authConfigId: string,
  apiKey?: string | null,
): Promise<{ authScheme: string; val: Record<string, string> } | null> {
  try {
    const res = await composioFetch(`/v3/auth_configs/${authConfigId}`)
    if (!res.ok) return null
    const ac = (await res.json()) as any
    const fields: any[] = firstArray(ac?.expected_input_fields, ac?.deprecated_params?.expected_input_fields)
    const scheme = ac?.auth_scheme ?? "API_KEY"
    // Use provided key, falling back to whatever is stored on the auth_config
    const key = apiKey ?? ac?.credentials?.api_key ?? ac?.credentials?.generic_api_key ?? null
    if (!key) return null
    const val: Record<string, string> = {}
    if (fields.length > 0) {
      // Populate every required string field with the same key
      for (const f of fields) {
        if (f?.required && f?.type === "string") val[f.name] = String(key)
      }
      if (Object.keys(val).length === 0) val[fields[0].name] = String(key)
    } else {
      val.generic_api_key = String(key)
    }
    return { authScheme: scheme, val }
  } catch {
    return null
  }
}

// ============================================================================
// Param parsing — key=value pairs into typed object
// ============================================================================

function parseParams(raw: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of raw) {
    if (!p.includes("=")) continue
    const eq = p.indexOf("=")
    const key = p.slice(0, eq)
    let val: unknown = p.slice(eq + 1).replace(/^["']|["']$/g, "")
    if (typeof val === "string") {
      if (/^-?\d+$/.test(val)) val = parseInt(val, 10)
      else if (/^-?\d*\.\d+$/.test(val)) val = parseFloat(val)
      else if (val === "true") val = true
      else if (val === "false") val = false
    }
    out[key] = val
  }
  return out
}

// ============================================================================
// Integration execute (routes through fl-api execute-direct)
// ============================================================================

/**
 * macOS integration is inherently local — Mail.app, Messages.app, Calendar etc.
 * live on the user's machine, not the cloud. Route these calls directly to the
 * local bridge daemon at localhost:3200 instead of through the remote API.
 *
 * Returns null if the function is not a known macos function (caller should
 * fall back to the remote API path).
 */
async function executeMacosLocal(
  fn: string,
  params: Record<string, unknown>,
): Promise<any | null> {
  const bridgePort = process.env.BRIDGE_PORT ?? "3200"
  const bridgeBase = process.env.BRIDGE_URL ?? `http://localhost:${bridgePort}`

  // Map function name → { method, path, body? }
  type Route = { method: "GET" | "POST"; path: string; useBody: boolean }
  const routes: Record<string, Route> = {
    send_email: { method: "POST", path: "/api/mail/send", useBody: true },
    draft_email: { method: "POST", path: "/api/mail/draft", useBody: true },
    search_mail: { method: "GET", path: "/api/mail/search", useBody: false },
    send_imessage: { method: "POST", path: "/api/imessage/direct-send", useBody: true },
    search_imessages: { method: "GET", path: "/api/imessage/search", useBody: false },
    get_conversations: { method: "GET", path: "/api/imessage/conversations", useBody: false },
    get_calendar_events: { method: "GET", path: "/api/calendar/events", useBody: false },
    list_calendars: { method: "GET", path: "/api/calendar/list", useBody: false },
    create_calendar_event: { method: "POST", path: "/api/calendar/create-event", useBody: true },
    search_apps: { method: "GET", path: "/api/apps/search", useBody: false },
    open_app: { method: "POST", path: "/api/apps/open", useBody: true },
  }

  const route = routes[fn]
  if (!route) return null // unknown function — fall back to remote API

  // CR-14 bypass 2. `iris run send_imessage` / `send_email` mapped straight onto the bridge, so
  // they had full send capability and wrote nothing to the comms log. Route them through the
  // Comms Router instead, exactly as `iris imessage send` and `iris mail send` now are.
  //
  // On router failure we FALL THROUGH to the bridge rather than blocking the send — `run` is the
  // low-level escape hatch and taking away someone's ability to send when the API is down would
  // be a worse trade than an unlogged message. It is announced on stderr either way, because an
  // unlogged send that nobody is told about is the failure this whole epic is about.
  if (fn === "send_imessage" || fn === "send_email") {
    const handle = String(params.handle ?? params.chat_guid ?? params.to_email ?? params.to ?? "")
    const message = String(params.text ?? params.body_text ?? params.message ?? "")

    if (handle && message) {
      try {
        const { routerSend } = await import("./comms-send")
        const routed = await routerSend({
          toHandle: handle,
          channel: fn === "send_imessage" ? "imessage" : "apple_mail",
          subject: params.subject ? String(params.subject) : undefined,
          message,
          origin: "cli.reachr",
        })
        if (routed.ok && routed.sent) {
          return { sent: true, channel: routed.channel, comm_id: routed.commId, logged: Boolean(routed.commId) }
        }
        console.error(`[iris run] comms router declined (${routed.error ?? "unknown"}) — sending via bridge, NOT logged.`)
      } catch (e) {
        console.error(`[iris run] comms router unavailable — sending via bridge, NOT logged.`)
      }
    }
  }

  let url = `${bridgeBase}${route.path}`
  let body: string | undefined

  if (route.useBody) {
    body = JSON.stringify(params)
  } else {
    // GET — encode params as query string
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v))
    }
    if ([...qs].length > 0) url += `?${qs.toString()}`
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: route.method,
      headers: route.useBody ? { "Content-Type": "application/json" } : undefined,
      body,
    })
  } catch (e) {
    throw new Error(
      `Cannot reach local bridge at ${bridgeBase}. ` +
        `Start it with: iris-daemon start  (error: ${e instanceof Error ? e.message : String(e)})`,
    )
  }

  const text = await res.text().catch(() => "")
  if (!res.ok) {
    let errMsg = text
    try {
      const parsed = JSON.parse(text)
      errMsg = parsed.error ?? text
    } catch { /* keep raw text */ }
    throw new Error(`Bridge ${route.method} ${route.path} failed (HTTP ${res.status}): ${errMsg}`)
  }

  let data: any = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }

  // Wrap to match the iris-api response shape (success/data/message)
  return {
    success: true,
    data,
    message: data.message ?? `${fn} completed via local bridge`,
  }
}

/**
 * Look up an integration_id from a user-supplied --account hint.
 * Matches case-insensitively against account_email and name. Returns
 * the first match. If multiple exist, the user should disambiguate
 * with --integration-id directly.
 */
export async function resolveAccountToIntegrationId(
  userId: number,
  normalizedType: string,
  account: string,
): Promise<number | null> {
  try {
    const res = await irisFetch(`/api/v1/users/${userId}/integrations`, {}, IRIS_API)
    if (!res.ok) return null
    const data = (await res.json()) as any
    const items: any[] = firstArray(data?.connections, data?.data, data)
    const needle = account.toLowerCase()
    const candidates = items.filter((i) => {
      if (String(i.type ?? "").toLowerCase() !== normalizedType) return false
      const email = String(i.account_email ?? "").toLowerCase()
      const name = String(i.name ?? "").toLowerCase()
      return email === needle || name === needle || email.includes(needle) || name.includes(needle)
    })
    if (candidates.length === 0) return null
    return Number(candidates[0].id) || null
  } catch (err) {
    // Distinguish network/transport errors (which should surface) from a
    // genuine "no match". Previously swallowed as null, masking outages
    // (bug #16).
    if (err instanceof TypeError || (err as any)?.name === "FetchError" || (err as any)?.code === "ECONNREFUSED") {
      throw err
    }
    if (process.env.IRIS_DEBUG) {
      console.error(dim(`[resolveAccountToIntegrationId] lookup failed for ${normalizedType}/${account}:`), err)
    }
    return null
  }
}

// Composio returns slugs without hyphens (googledrive), but iris-api expects
// the hyphenated form (google-drive). Normalize before sending to backend.
const SLUG_ALIASES: Record<string, string> = {
  googledrive: "google-drive",
  googledocs: "google-docs",
  googlecalendar: "google-calendar",
  outlookcalendar: "outlook-calendar",
}

export async function executeIntegrationCall(
  type: string,
  fn: string,
  params: Record<string, unknown>,
  options: { integrationId?: number; account?: string } = {},
): Promise<any> {
  // Local fast path for macos — calls the bridge directly, no remote API.
  if (type === "macos") {
    const localResult = await executeMacosLocal(fn, params)
    if (localResult !== null) return localResult
    // Unknown macos function (e.g. calendar) — fall through to remote API
  }

  const normalized = SLUG_ALIASES[type] ?? type
  const userId = await requireUserId()
  if (!userId) throw new Error("user_id required")

  // Resolve --account "alex@gmail.com" to an integration_id by querying the
  // user's connections. If multiple match, prefer one whose account_email or
  // name matches case-insensitively.
  let integrationId: number | undefined = options.integrationId
  if (!integrationId && options.account) {
    integrationId = (await resolveAccountToIntegrationId(userId, normalized, options.account)) ?? undefined
    if (!integrationId) {
      throw new Error(
        `No connection for type='${normalized}' matching --account='${options.account}'. ` +
        `Run: iris integrations list`
      )
    }
  }

  // Canva uses native service on fl-api (Composio has 0 actions)
  if (normalized === "canva") {
    const res = await irisFetch(
      `/api/v1/integrations/execute`,
      {
        method: "POST",
        body: JSON.stringify({ integration: "canva", action: fn, parameters: params }),
      },
      FL_API,
    )
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`HTTP ${res.status}: ${text}`)
    }
    return res.json()
  }

  const body: Record<string, unknown> = { integration: normalized, action: fn, params }
  if (integrationId) body.integration_id = integrationId

  const res = await irisFetch(
    `/api/v1/users/${userId}/integrations/execute-direct?user_id=${userId}`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    IRIS_API, // execute-direct lives on iris-api, not fl-api
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  return await res.json()
}

function displayArrayItems(items: any[], indent = "    "): void {
  for (const item of items.slice(0, 25)) {
    if (typeof item === "object" && item !== null) {
      const label = item.name ?? item.title ?? item.summary ?? item.subject ?? item.filename ?? item.email ?? item.id ?? ""
      const id = item.id && label !== item.id ? dim(` #${String(item.id).slice(0, 12)}`) : ""
      const type = item.mimeType ?? item.type ?? ""
      // Calendar events: show start/end time
      // start may be a string ("2026-04-18T09:00:00") or object ({ dateTime: "..." })
      const rawStart = item.start
      const startTime = typeof rawStart === "string" ? rawStart : (rawStart?.dateTime ?? rawStart?.date ?? item.start_time ?? "")
      const timeLabel = startTime ? dim(` ${startTime}`) : ""
      console.log(`${indent}${bold(String(label))}${id}${timeLabel}${type ? `  ${dim(type)}` : ""}`)
    } else {
      console.log(`${indent}${item}`)
    }
  }
  if (items.length > 25) console.log(`${indent}${dim(`…and ${items.length - 25} more`)}`)
}

function displayResult(result: any, name: string): void {
  const ok = result?.success ?? !result?.error
  if (!ok) {
    prompts.log.error(result?.error ?? "Execution failed")
    return
  }
  console.log(`  ${success("✓")} ${bold(name)} completed`)
  for (const [k, v] of Object.entries(result ?? {})) {
    if (k === "success" || k === "status") continue
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      console.log(`  ${dim(k + ":")} ${v}`)
    } else if (Array.isArray(v)) {
      console.log(`  ${dim(k + ":")} ${dim(`(${v.length} items)`)}`)
      displayArrayItems(v)
    } else if (typeof v === "object" && v !== null) {
      // Drill into nested objects — find arrays inside (e.g. data.files) (#55730)
      const nestedArrays = Object.entries(v).filter(([, val]) => Array.isArray(val))
      const nestedPrimitives = Object.entries(v).filter(([, val]) => typeof val === "string" || typeof val === "number" || typeof val === "boolean")

      if (nestedArrays.length > 0) {
        // Show primitives first (e.g. kind, incompleteSearch)
        for (const [nk, nv] of nestedPrimitives) {
          console.log(`  ${dim(nk + ":")} ${nv}`)
        }
        // Expand each nested array
        for (const [nk, nv] of nestedArrays) {
          const arr = nv as any[]
          console.log(`  ${dim(nk + ":")} ${dim(`(${arr.length} items)`)}`)
          displayArrayItems(arr)
        }
      } else {
        const enc = JSON.stringify(v, null, 2)
        if (enc.length < 2000) {
          const lines = enc.split("\n")
          console.log(`  ${dim(k + ":")}`)
          for (const line of lines) console.log(`    ${line}`)
        } else {
          const keys = Object.keys(v)
          console.log(`  ${dim(k + ":")} {${keys.slice(0, 10).join(", ")}${keys.length > 10 ? ", …" : ""}}`)
        }
      }
    }
  }
}

// ============================================================================
// Composio OAuth URL via iris-api
// ============================================================================

async function getComposioOAuthUrl(type: string): Promise<{ url: string | null; error: string | null }> {
  const userId = await requireUserId()
  if (!userId) return { url: null, error: "Not authenticated" }
  const bases = [IRIS_API, ...PLATFORM_URLS.irisApiFallbacks]
  let lastError: string | null = null
  for (const base of bases) {
    try {
      const res = await irisFetch(
        `/api/v1/integrations-temp/oauth-url/${type}?user_id=${userId}`,
        {},
        base,
      )
      const data = await res.json().catch(() => ({})) as any
      if (res.ok) {
        const url = data?.data?.oauth_url ?? data?.oauth_url ?? data?.url
        if (url) return { url, error: null }
      } else {
        lastError = data?.error ?? data?.message ?? `HTTP ${res.status}`
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }
  return { url: null, error: lastError }
}

function openBrowser(url: string): void {
  const opener =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" :
    "xdg-open"
  exec(`${opener} "${url.replace(/"/g, '\\"')}"`, () => {})
}

// ============================================================================
// Subcommands
// ============================================================================

const ListToolsCommand = cmd({
  command: "list-tools",
  describe: "list V6 system tools",
  builder: (y) => y.option("json", { type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  V6 System Tools")
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    try {
      const res = await irisFetch("/api/v1/tools/registry", {}, IRIS_API)
      if (!res.ok) {
        prompts.log.warn(`Could not fetch registry: HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }
      const data = (await res.json()) as any
      if (args.json) { await writeJson(data); prompts.outro("Done"); return }
      printDivider()
      for (const t of data?.tools ?? data?.data ?? []) {
        const healthy = t.healthy ? success("ok") : dim("?")
        console.log(`  ${highlight(t.name ?? "?")} [${healthy}]`)
      }
      printDivider()
      prompts.outro(dim("iris integrations <tool> key=value …"))
    } catch (e) {
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})

const ListIntegrationsCommand = cmd({
  command: "list-integrations",
  describe: "list known integration types",
  async handler() {
    UI.empty()
    prompts.intro("◈  Available Integrations")
    const { entries, degraded } = await loadCatalog()
    if (degraded) prompts.log.warn(`Showing this binary's built-in list only — could not read the registry (${degraded}).`)
    printDivider()
    for (const e of entries) console.log(`  ${highlight(e.type)}`)
    printDivider()
    console.log(`  ${dim(`${entries.length} integration(s)`)}`)
    prompts.outro(dim("iris integrations <type> <function> key=value …"))
  },
})

const ListConnectedCommand = cmd({
  command: "list-connected",
  aliases: ["list", "ls"],
  describe: "show your connected integrations",
  builder: (y) => y.option("json", { type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Connected Integrations")
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const userId = await requireUserId()
    if (!userId) { prompts.outro("Done"); return }

    // iris-api's /integrations endpoint already merges fl-api local rows with
    // live Composio connected_accounts and surfaces account_email + entity_id
    // per record. Use it directly so multi-account stays visible (a user with
    // 2 Gmail accounts shows 2 rows, not 1 deduped by type).
    // The lookup either SUCCEEDS and returns a list, or it FAILS. Those are different
    // answers and this used to collapse them: a bare `catch {}` plus `if (!res.ok)` fell
    // through to an empty array, and an empty array printed "No integrations connected."
    // So a 401, a 500, or a dropped connection all rendered as the confident claim that the
    // user has nothing connected.
    //
    // On 2026-08-28 that told a client her Gmail was not connected while it was live and
    // working (Composio ca_P1qS3-SNvUKQ, probe OK). Her agent believed the CLI, advised her
    // to re-run `connect`, and the retry created a second half-finished OAuth — which is the
    // single dominant cause of dead connections in the audit. The false negative did not just
    // mislead, it manufactured the failure it described.
    let items: any[] | null = null
    let failure: string | null = null
    try {
      const res = await irisFetch(`/api/v1/users/${userId}/integrations`)
      if (res.ok) {
        const data = (await res.json()) as any
        items = [...(data?.connections ?? data?.data ?? data ?? [])]
      } else {
        failure = `the integrations API returned HTTP ${res.status}`
      }
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e)
    }

    if (args.json) {
      // Machine consumers need the distinction most — an agent parsing `[]` will state it as
      // fact. Emit the error instead of an empty list it cannot tell apart from "none".
      await writeJson(failure ? { error: failure, connections: null } : items)
      prompts.outro("Done")
      return
    }

    if (failure) {
      prompts.log.error(`Could not read your integrations — ${failure}`)
      prompts.log.info(dim("This is NOT the same as having none connected; the lookup did not complete."))
      prompts.log.info(dim("Retry, or check `iris auth whoami`. Do not re-run `connect` on a hunch —"))
      prompts.log.info(dim("an abandoned OAuth leaves a dead connection behind."))
      prompts.outro("Done")
      return
    }

    // `!items` is unreachable here (failure returned above) but narrows the type for the
    // probe loop below, and keeps this honest if the branches above are ever reordered.
    if (!items || items.length === 0) {
      prompts.log.warn("No integrations connected.")
      prompts.outro(dim("iris integrations list-available"))
      return
    }

    // Verify tokens in parallel (#57679) — probe each integration
    const verifySpinner = prompts.spinner()
    verifySpinner.start("Verifying tokens…")

    // A probe reports WHY, not just that it failed. "unverified — could not probe"
    // is unactionable: it collapses "the local bridge isn't running", "the API
    // returned a 500" and "the network is down" into one useless string. Each
    // probe now returns the cause and, where one exists, the command that fixes it.
    // "unknown" is a real answer and a separate one from "broken". If the probe
    // ENDPOINT is missing (404) we cannot tell whether the integration works, and
    // saying either "verified" or "unverified" would be a claim we cannot support.
    // The previous code returned "verified" for any non-401/403 response, so a 404
    // on the probe path rendered as a green [verified] — a false positive that hid
    // the fact that these probe endpoints do not currently resolve.
    type ProbeState = "verified" | "expired" | "error" | "unknown"
    type Probe = { state: ProbeState; reason?: string; fix?: string }

    // fetch() rejects for DNS/connection-refused/timeout. Turn that into a cause
    // the reader can act on rather than a generic failure.
    const netReason = (e: unknown, target: string): string => {
      const msg = String((e as any)?.message ?? e ?? "")
      if (/abort|timeout|timed out/i.test(msg)) return `${target} timed out`
      if (/ECONNREFUSED|refused/i.test(msg)) return `nothing is listening on ${target}`
      if (/ENOTFOUND|EAI_AGAIN|dns/i.test(msg)) return `${target} did not resolve`
      return msg ? `${target} unreachable — ${msg}` : `${target} unreachable`
    }

    const verifyFns: Record<string, (row: any) => Promise<Probe>> = {
      gmail: async () => {
        let r: Response | null = null
        try {
          r = await irisFetch(`/api/v1/leads/0/gmail-threads`)
        } catch (e) {
          return { state: "error", reason: netReason(e, "iris-api") }
        }
        if (!r) return { state: "error", reason: "iris-api unreachable" }
        if (r.status === 401 || r.status === 403)
          return { state: "expired", reason: "Google OAuth token rejected" }
        if (r.status === 404)
          return { state: "unknown", reason: "probe endpoint /leads/0/gmail-threads returned 404" }
        if (!r.ok) return { state: "error", reason: `iris-api returned HTTP ${r.status}` }
        return { state: "verified", reason: "Gmail API reachable" }
      },
      "google-calendar": async () => {
        // Calendar reads go through the LOCAL bridge, not iris-api. The usual
        // cause of failure is that the bridge daemon isn't running at all, which
        // the old "could not probe" text never said.
        const _bh: Record<string, string> = { Accept: "application/json" }
        const _bt = getBridgeToken()
        if (_bt) _bh["X-Bridge-Key"] = _bt
        let r: Response | null = null
        try {
          r = await fetch(`http://localhost:3200/api/calendar/events?days=1&limit=1`, {
            signal: AbortSignal.timeout(3000),
            headers: _bh,
          })
        } catch (e) {
          return {
            state: "error",
            reason: netReason(e, "local bridge on :3200"),
            fix: "iris hive doctor",
          }
        }
        if (!r.ok) {
          if (r.status === 401 || r.status === 403)
            return {
              state: "error",
              reason: _bt ? "bridge rejected the bridge key" : "no bridge key configured",
              fix: "iris hive doctor",
            }
          return { state: "error", reason: `local bridge returned HTTP ${r.status}`, fix: "iris hive doctor" }
        }
        return { state: "verified", reason: "via local bridge" }
      },
      "google-drive": async (row: any) => {
        // Probe THIS row's account. Without integration_id every Drive account
        // gets whichever connection the API picks by default, so three accounts
        // all report one shared result.
        const body: Record<string, unknown> = {
          type: "google-drive",
          function: "list_files",
          params: { maxResults: 1 },
        }
        if (row?.id) body.integration_id = row.id
        let r: Response | null = null
        try {
          r = await irisFetch("/api/v1/integrations/exec", { method: "POST", body: JSON.stringify(body) })
        } catch (e) {
          return { state: "error", reason: netReason(e, "iris-api") }
        }
        if (!r) return { state: "error", reason: "iris-api unreachable" }
        if (r.status === 401 || r.status === 403)
          return { state: "expired", reason: "Google OAuth token rejected" }
        if (r.status === 404)
          return { state: "unknown", reason: "probe endpoint /integrations/exec returned 404" }
        if (!r.ok) return { state: "error", reason: `iris-api returned HTTP ${r.status}` }
        return { state: "verified", reason: "Drive API reachable" }
      },
    }

    // Key by integration id, not type. Keying by type made every account of the
    // same provider share one result — the opposite of the multi-account
    // visibility this command exists to give.
    const probeKey = (i: any) => String(i?.id ?? `type:${i?.type}`)
    const verified = new Map<string, Probe>()
    await Promise.allSettled(
      items.map(async (i) => {
        const fn = verifyFns[i.type]
        if (!fn) return
        const result = await fn(i).catch((e) => ({
          state: "error" as const,
          reason: netReason(e, "probe"),
        }))
        verified.set(probeKey(i), result)
      }),
    )
    verifySpinner.stop("Done")

    printDivider()
    for (const i of items) {
      const v = verified.get(probeKey(i))
      let statusLabel: string
      if (v?.state === "verified") {
        statusLabel = `${success("[verified]")}${v.reason ? ` ${dim(`— ${v.reason}`)}` : ""}`
      } else if (v?.state === "expired") {
        const why = v.reason ? `${v.reason} — ` : ""
        statusLabel = `${UI.Style.TEXT_DANGER}[expired]${UI.Style.TEXT_NORMAL} ${dim(`— ${why}reconnect: iris connect ${i.type}`)}`
      } else if (v?.state === "unknown") {
        // Do not colour this like a failure. The integration may be fine; it is
        // the probe that cannot answer, and the fix is ours, not the user's.
        statusLabel = `${dim("[unknown]")} ${dim(`— ${v.reason ?? "probe unavailable"}; integration status not determined`)}`
      } else if (v?.state === "error") {
        // Always say what failed. Append the fix only when one exists.
        const why = v.reason ?? "probe failed for an unknown reason"
        const fix = v.fix ? ` ${dim(`→ ${v.fix}`)}` : ""
        statusLabel = `${UI.Style.TEXT_WARNING}[unverified]${UI.Style.TEXT_NORMAL} ${dim(`— ${why}`)}${fix}`
      } else {
        statusLabel = i.status === "active" ? dim("[active]") : dim(`[${i.status}]`)
      }
      // Show ID + per-account info so multi-account is discoverable.
      const idLabel = i.id ? dim(`#${i.id}`) : dim("(no local id)")
      const account = i.account_email ?? i.name ?? null
      const accountLabel = account ? `  ${dim("→")} ${bold(String(account))}` : ""
      const provider = i.provider && i.provider !== "native" ? dim(` via ${i.provider}`) : ""
      console.log(`  ${highlight(i.type)}  ${idLabel}  ${statusLabel}${accountLabel}${provider}`)
    }
    printDivider()
    prompts.outro(dim("Pick an account: iris integrations exec <type> <fn> --account=<email>  (or --integration-id=<id>)"))
  },
})

const ListAvailableCommand = cmd({
  command: "list-available",
  describe: "all available integrations + connection status",
  async handler() {
    UI.empty()
    prompts.intro("◈  Available Integrations")
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const userId = await requireUserId()
    const connected = new Set<string>()
    try {
      const res = await irisFetch(`/api/v1/users/${userId}/integrations`)
      if (res.ok) {
        const data = (await res.json()) as any
        for (const i of data?.data ?? data ?? []) {
          if (i.type) connected.add(String(i.type).toLowerCase())
        }
      }
    } catch {}

    const { entries, degraded } = await loadCatalog()
    if (degraded) {
      prompts.log.warn(`Showing this binary's built-in list only — could not read the registry (${degraded}).`)
      prompts.log.warn("Integrations added since this binary was built will be missing from the list below.")
    }

    printDivider()
    for (const [category, group] of groupByCategory(entries)) {
      console.log(`  ${dim(category.toUpperCase())}`)
      for (const e of group) {
        const isOn = connected.has(e.type) || e.isConnected
        const status = isOn ? success("connected") : dim("not connected")
        // How it is connected matters as much as whether: `connect wix` used to route to
        // OAuth and die because nothing said wix takes an api key (#182712).
        const how = isOAuthEntry(e) ? "" : dim(`  ${e.authType}`)
        console.log(`    ${highlight(e.type)}  ${status}${how}`)
      }
    }
    printDivider()
    console.log(`  ${dim(`${entries.length} integration(s) · ${connected.size} connected`)}`)
    prompts.outro(dim("iris integrations connect <type>"))
  },
})

const ConnectCommand = cmd({
  command: "connect <type>",
  describe: "start OAuth or show API-key instructions for an integration",
  builder: (y) =>
    y
      .positional("type", { type: "string", demandOption: true })
      .option("print-url", { type: "boolean", default: false, describe: "print the OAuth URL instead of opening a browser" })
      .option("field", {
        type: "array",
        describe: "credential field for API-key style integrations, repeatable: --field api_key=… --field site_id=…",
      })
      .option("yes", {
        alias: "y",
        type: "boolean",
        default: false,
        describe: "skip the overwrite confirmation (non-interactive / agent use)",
      })
      .option("name", {
        type: "string",
        describe: "label for this connection (e.g. \"Personal\" or \"Work\") — required when adding a 2nd account of the same type",
      })
      // CLI-native OAuth (clio, …) — providers we drive from the binary rather
      // than through Composio or the web UI.
      .option("client-id", { type: "string", describe: "OAuth app client id (CLI-native providers; or <TYPE>_CLIENT_ID)" })
      .option("client-secret", { type: "string", describe: "OAuth app client secret (CLI-native providers; or <TYPE>_CLIENT_SECRET)" })
      .option("port", { type: "number", default: 8787, describe: "loopback port for the OAuth callback (CLI-native providers)" })
      .option("paste", { type: "boolean", default: false, describe: "paste the code instead of running a loopback listener (SSH/headless)" })
      .option("bloq", { type: "number", describe: "share this integration with a bloq" })
      .option("json", { type: "boolean", default: false, describe: "JSON output" })
      .option("user-id", { type: "number", describe: "user ID (or IRIS_USER_ID env)" }),
  async handler(args) {
    UI.empty()
    const labelSuffix = args.name ? ` ${dim(`(${args.name})`)}` : ""
    prompts.intro(`◈  Connect: ${args.type}${labelSuffix}`)

    // NO TERMINAL MEANS THE URL *IS* THE DELIVERABLE.
    //
    // Reported 2026-08-28 (#182693): a user in IRIS Desktop asked an agent to connect an
    // integration and no OAuth URL ever came back. Every non-TTY path through this command
    // ended in `outro("Cancelled")` with NO exit code set — so the caller saw success and
    // nothing else, and could not tell "cancelled" from "worked".
    //
    // Without a TTY nobody can answer a prompt, see a browser we opened, or watch a poll
    // spinner for an authorisation they have no way to perform. In that world the only
    // useful output is the authorize URL itself, which is exactly what --print-url already
    // produces. So absence of a terminal now IMPLIES it rather than disabling the one
    // branch that works.
    const headless = !process.stdin.isTTY
    const printUrlOnly = shouldPrintUrlOnly({ printUrl: Boolean(args["print-url"]), isTTY: Boolean(process.stdin.isTTY) })
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const type = String(args.type)

    // Multi-account guard: warn if a connection of this type already exists
    // and no --name was supplied. Without a label the OAuth callback will
    // overwrite the existing record (single-account legacy behavior).
    if (!args.name) {
      try {
        const userId = await requireUserId()
        if (userId) {
          const res = await irisFetch(`/api/v1/users/${userId}/integrations`, {}, IRIS_API)
          if (res.ok) {
            const data = (await res.json()) as any
            const existing = (data?.connections ?? data?.data ?? []).filter(
              (i: any) => String(i.type ?? "").toLowerCase() === (SLUG_ALIASES[type] ?? type),
            )
            if (existing.length > 0) {
              const accounts = existing.map((i: any) => i.account_email ?? i.name ?? `#${i.id}`).join(", ")
              prompts.log.warn(`You already have ${existing.length} ${type} connection(s): ${accounts}`)
              console.log(`  ${dim("Re-running connect WITHOUT --name will overwrite the existing record.")}`)
              console.log(`  ${dim("To add a second account, re-run with:")} ${highlight(`iris integrations connect ${type} --name="Personal"`)}`)

              // Non-interactive contexts (agents, CI, Claude Code `!`) have no TTY,
              // so the clack confirm would hang forever. Require an explicit --yes
              // to overwrite; otherwise fail fast with guidance instead of blocking.
              const interactive = Boolean(process.stdin.isTTY)
              if (args.yes) {
                prompts.log.info("Overwriting existing connection (--yes)")
              } else if (!interactive) {
                prompts.log.error(
                  `Existing ${type} connection found and no TTY for a prompt. Re-run with ${highlight("--yes")} to overwrite, or ${highlight("--name=\"Personal\"")} to add a new account.`,
                )
                // Refusing is right — overwriting a live credential unasked is worse than
                // stopping. Exiting 0 while refusing is what made this invisible.
                process.exitCode = 1
                prompts.outro("Cancelled")
                return
              } else {
                const proceed = await prompts.confirm({ message: "Continue and overwrite?", initialValue: false })
                if (prompts.isCancel(proceed) || !proceed) {
                  process.exitCode = 1
                  prompts.outro("Cancelled")
                  return
                }
              }
            }
          }
        }
      } catch {
        // non-fatal — fall through to normal connect
      }
    }

    // ── CREDENTIAL-BASED INTEGRATIONS, AS THE REGISTRY DECLARES THEM ──────────
    //
    // #182712. The old code decided how to authenticate from a 7-entry hardcoded array
    // (APIKEY_TYPES). Wix was not in it, so `connect wix` fell through to OAuth and died
    // with "OAuth URL generation not supported for type: wix" — for an integration that had
    // been live for some time and whose own yml says `auth: {type: api_key}` with two
    // fields. The registry knows the auth type AND the exact fields, with labels and help
    // text. Ask it instead of guessing.
    {
      const { entries, degraded } = await loadCatalog()
      const entry = findEntry(entries, type)

      if (!entry && !degraded) {
        // The registry answered and does not have this. That is a real negative, and it can
        // now be stated without hedging — unlike the old array, which could only say "not in
        // the list I was compiled with".
        prompts.log.error(`No integration named ${highlight(type)} in the registry.`)
        console.log(`  ${dim("Browse what exists:")} ${highlight("iris integrations list-available")}`)
        process.exitCode = 1
        prompts.outro("Done")
        return
      }

      if (entry && !isOAuthEntry(entry)) {
        const userId = await requireUserId(args["user-id"] as number | undefined)
        if (!userId) { process.exitCode = 1; prompts.outro("Done"); return }

        const provided = {
          ...parseFieldFlags(args.field as string[] | undefined),
        }
        // --api-key stays supported for the single-field case people already type.
        if (args["api-key"] && requiredFields(entry).length === 1) {
          provided[requiredFields(entry)[0].name] = String(args["api-key"])
        }

        let missing = missingRequired(entry, provided)

        if (missing.length > 0 && process.stdin.isTTY && !args.json) {
          console.log()
          console.log(`  ${entry.name} uses ${highlight(entry.authType)} authentication.`)
          console.log()
          for (const f of missing) {
            if (f.description) console.log(`  ${dim(f.description)}`)
            const v = await prompts.password({
              message: f.label || f.name,
              mask: "•",
              validate: (x) => (!x || !x.trim() ? "Required" : undefined),
            })
            if (prompts.isCancel(v)) {
              process.exitCode = 1
              prompts.outro("Cancelled")
              return
            }
            provided[f.name] = String(v).trim()
          }
          missing = missingRequired(entry, provided)
        }

        if (missing.length > 0) {
          // Name the fields that are actually required, and hand over the command that
          // works. The old message offered --api-key / --token / --webhook-url, and for
          // Wix all three were wrong.
          prompts.log.error(`${entry.name} needs: ${missing.map((f) => f.name).join(", ")}`)
          for (const f of missing) {
            if (f.description) console.log(`  ${dim(`${f.name} — ${f.description}`)}`)
          }
          console.log()
          console.log(`  ${dim("Run:")} ${highlight(connectCommandHint(entry))}`)
          process.exitCode = 1
          prompts.outro("Done")
          return
        }

        const sp = prompts.spinner()
        sp.start(`Connecting ${entry.name}…`)
        try {
          const payload: Record<string, unknown> = { type: entry.type, credentials: provided, status: "active" }
          if (args.name) payload.name = args.name
          if (args.bloq) payload.bloq_id = args.bloq

          const res = await irisFetch(`/api/v1/users/${userId}/integrations`, {
            method: "POST",
            body: JSON.stringify(payload),
          }, IRIS_API)

          if (!res.ok) {
            sp.stop("Failed", 1)
            prompts.log.error(`Could not store the credential (HTTP ${res.status}).`)
            process.exitCode = 1
            prompts.outro("Done")
            return
          }
          sp.stop(`${success("✓")} ${bold(entry.name)} stored`)
        } catch (e) {
          sp.stop("Failed", 1)
          prompts.log.error(e instanceof Error ? e.message : String(e))
          process.exitCode = 1
          prompts.outro("Done")
          return
        }

        // A stored credential is not a working one. Prove it the same way OAuth does now.
        const probe = verifyProbeFor(entry.type)
        if (probe) {
          const vs = prompts.spinner()
          vs.start(`Verifying by ${probe.label}…`)
          try {
            const r = await irisFetch(`/api/v1/users/${userId}/integrations/execute-direct`, {
              method: "POST",
              body: JSON.stringify({ integration: entry.type, action: probe.action, params: probe.params }),
            })
            const body = await r.json().catch(() => null)
            if (isProbeSuccess(body)) {
              vs.stop(`${success("✓")} ${bold(entry.type)} connected — verified by ${probe.label}`)
            } else if (isProbeInconclusive(r.status, body)) {
              vs.stop(`${dim("Stored — could not verify from here (not an authorization failure)")}`)
            } else {
              vs.stop(`${dim("Stored, but a live call did not succeed")}`, 1)
              console.log(`  ${dim("Check with:")} ${highlight(`iris integrations exec ${entry.type} ${probe.action}`)}`)
              process.exitCode = 1
            }
          } catch {
            vs.stop(`${dim("Stored — verification call failed to run")}`)
          }
        } else {
          console.log(`  ${dim("No read-only probe for this integration — stored but not verified.")}`)
        }

        prompts.outro("Done")
        return
      }
    }

    // CLI-native OAuth: the server has no authorize-URL case for these, so the
    // whole dance runs here (loopback listener → token exchange → persist).
    if (isLocalOAuthProvider(type)) {
      await runLocalOAuthConnect(type, args as any)
      return
    }

    if (APIKEY_TYPES.includes(type)) {
      const hints: Record<string, string> = {
        vapi: "https://dashboard.vapi.ai",
        "servis-ai": "https://freeagent.network",
        openai: "https://platform.openai.com/api-keys",
      }
      console.log(`  ${type} uses API key authentication.`)
      if (hints[type]) console.log(`  Get credentials: ${highlight(hints[type])}`)
      console.log(`  Run: ${highlight("iris integrations <type> ...")} once stored.`)
      prompts.outro("Done")
      return
    }

    // WhatsApp requires WABA ID before OAuth — prompt then connect directly via Composio
    if (type === "whatsapp") {
      console.log()
      console.log(`  WhatsApp Business requires a ${highlight("WABA ID")} (WhatsApp Business Account ID).`)
      console.log(`  ${dim("Find it in Meta Business Suite → Business Settings → WhatsApp Accounts")}`)
      console.log()
      const wabaId = await prompts.text({ message: "Paste your WABA ID:" })
      if (prompts.isCancel(wabaId) || !wabaId) { process.exitCode = 1; prompts.outro("Cancelled"); return }

      const sp = prompts.spinner()
      sp.start("Connecting WhatsApp…")
      try {
        const userId = await requireUserId()
        // Find existing auth_config for whatsapp
        const acRes = await composioFetch(`/v3/auth_configs?toolkit_slug=whatsapp&limit=5`)
        const acData = (await acRes.json()) as any
        const items: any[] = firstArray(acData?.items)
        const authConfig = items.find((c: any) => String(c?.status ?? "").toUpperCase() === "ENABLED")
        if (!authConfig?.id) {
          sp.stop("Failed", 1)
          prompts.log.error("No WhatsApp auth config found on Composio. Run: iris integrations setup whatsapp")
          prompts.outro("Done")
          return
        }

        // Create connected_account with WABA ID in state
        const caRes = await composioFetch("/v3/connected_accounts", {
          method: "POST",
          body: JSON.stringify({
            auth_config: { id: authConfig.id },
            connection: {
              user_id: `user-${userId}`,
              callback_url: `${PLATFORM_URLS.irisApi}/api/v1/integrations-temp/oauth-callback/whatsapp?state=${encodeURIComponent(Buffer.from(JSON.stringify({ type: "whatsapp", provider: "composio", user_id: userId, timestamp: Date.now(), nonce: randomBytes(16).toString("hex") }), "utf8").toString("base64"))}`,
              state: { authScheme: "OAUTH2", val: { generic_id: String(wabaId) } },
            },
          }),
        })
        const caData = (await caRes.json()) as any
        if (!caRes.ok) {
          sp.stop("Failed", 1)
          prompts.log.error(`Connection failed (HTTP ${caRes.status})`)
          console.log(dim(JSON.stringify(caData?.error ?? caData, null, 2).slice(0, 500)))
          prompts.outro("Done")
          return
        }
        const oauthUrl = caData?.redirectUrl ?? caData?.connectionData?.redirectUrl ?? caData?.url
        const connId = caData?.id ?? caData?.connectedAccountId
        if (oauthUrl) {
          sp.stop("OAuth URL ready")
          if (printUrlOnly) {
            console.log(`\n  ${highlight(oauthUrl)}\n`)
          } else {
            console.log(`\n  ${dim("Opening browser…")}`)
            openBrowser(oauthUrl)
            console.log(`\n  ${dim("If it didn't open:")} ${highlight(oauthUrl)}\n`)
          }
          if (connId) console.log(`  ${dim("Connection ID:")} ${connId}`)
        } else {
          sp.stop("Connected", 0)
          console.log(`  ${success("WhatsApp connected directly")} ${dim(`(${connId})`)}`)
        }
      } catch (e) {
        sp.stop("Failed", 1)
        prompts.log.error(e instanceof Error ? e.message : String(e))
      }
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Generating OAuth URL…")

    const composioResult = await getComposioOAuthUrl(type)
    let url = composioResult.url
    let composioError = composioResult.error

    // Fallback to fl-api SDK route
    if (!url) {
      try {
        const userId = await requireUserId()
        const res = await irisFetch(`/api/v1/users/${userId}/integrations/oauth-url/${type}`)
        if (res.ok) {
          const data = (await res.json()) as any
          url = data?.url ?? data?.oauth_url ?? null
        }
      } catch {}
    }

    if (!url) {
      // API-key toolkit: prompt inline for the user's key, then create
      // auth_config + connected_account in one shot. No 3-step dump.
      const apiKeyToolkit = COMPOSIO_APIKEY_TOOLKITS[type]
      if (apiKeyToolkit) {
        spinner.stop("API key required")
      } else {
        spinner.stop("Failed", 1)
      }
      if (apiKeyToolkit) {
        const hints: Record<string, string> = {
          cloudflare: "https://dash.cloudflare.com/profile/api-tokens",
          openai: "https://platform.openai.com/api-keys",
          anthropic: "https://console.anthropic.com/settings/keys",
          perplexity: "https://www.perplexity.ai/settings/api",
        }
        console.log()
        console.log(`  ${dim(`Get your ${type} API key:`)} ${highlight(hints[type] ?? "")}`)
        console.log()

        const apiKey = await prompts.password({
          message: `Paste your ${type} API key:`,
          mask: "•",
        })
        if (prompts.isCancel(apiKey) || !apiKey) {
          process.exitCode = 1
          prompts.outro("Cancelled")
          return
        }

        const sp2 = prompts.spinner()
        sp2.start("Checking for existing config…")
        try {
          // 1. Check if an auth_config already exists for this toolkit (avoid duplicates)
          let authConfigId: string | null = null
          try {
            const existingRes = await composioFetch(
              `/v3/auth_configs?toolkit_slug=${encodeURIComponent(apiKeyToolkit)}&limit=10`,
            )
            if (existingRes.ok) {
              const existingData = (await existingRes.json()) as any
              const items: any[] = firstArray(existingData?.items, existingData?.auth_configs, existingData?.data)
              // Pick the first ENABLED config
              const enabled = items.find((c) => String(c?.status ?? c?.state ?? "").toUpperCase() === "ENABLED")
              if (enabled?.id) authConfigId = String(enabled.id)
            }
          } catch {}

          if (authConfigId) {
            sp2.message("Reusing existing config…")
          } else {
            // 2. Create new auth_config with the user's key
            sp2.message("Registering new credentials…")
            const acRes = await composioFetch("/v3/auth_configs", {
              method: "POST",
              body: JSON.stringify({
                toolkit: { slug: apiKeyToolkit },
                auth_config: {
                  name: `${apiKeyToolkit}-${Date.now()}`,
                  type: "use_custom_auth",
                  authScheme: "API_KEY",
                  credentials: { api_key: String(apiKey) },
                },
              }),
            })
            const acText = await acRes.text()
            let acData: any = {}
            try { acData = JSON.parse(acText) } catch {}
            if (!acRes.ok) {
              sp2.stop("Failed", 1)
              prompts.log.error(`Auth config creation failed (HTTP ${acRes.status})`)
              const sanitized = acText.replace(/composio/gi, "integration provider")
              console.log(dim(sanitized.slice(0, 400)))
              prompts.outro("Done")
              return
            }
            authConfigId = acData?.auth_config?.id ?? acData?.id
            if (!authConfigId) {
              sp2.stop("Failed", 1)
              prompts.log.error("Integration provider returned no auth config id")
              prompts.outro("Done")
              return
            }
          }

          // 2. Create connected_account for this user — credentials must
          // be passed in connection.state.val using the field names from
          // the auth_config's expected_input_fields.
          sp2.message("Connecting account…")
          const userId = `user-${(await requireUserId().catch(() => 0)) || "local"}`
          const state = await buildComposioConnectionState(authConfigId, String(apiKey))
          const caRes = await composioFetch("/v3/connected_accounts", {
            method: "POST",
            body: JSON.stringify({
              auth_config: { id: authConfigId },
              connection: state ? { user_id: userId, state } : { user_id: userId },
            }),
          })
          const caText = await caRes.text()
          let caData: any = {}
          try { caData = JSON.parse(caText) } catch {}
          if (!caRes.ok) {
            sp2.stop("Failed", 1)
            prompts.log.error(`Connection failed (HTTP ${caRes.status})`)
            console.log(dim(caText.slice(0, 400)))
            prompts.outro("Done")
            return
          }

          sp2.stop("Connected")
          console.log()
          console.log(`  ${success("✓")} ${type} is now connected.`)
          console.log(`  ${dim("Connected account:")} ${caData?.id ?? caData?.connected_account_id ?? "?"}`)
          prompts.outro("Done")
          return
        } catch (e) {
          sp2.stop("Failed", 1)
          prompts.log.error(e instanceof Error ? e.message : String(e))
          prompts.outro("Done")
          return
        }
      }

      // Detect "no auth_config" errors and surface the actual setup command
      if (composioError && /auth.?config|integration.*not.*found/i.test(composioError)) {
        prompts.log.error(`${type} is not yet configured.`)
        console.log()
        console.log(`  ${bold("Fix:")} An admin needs to register OAuth credentials for ${type}.`)
        console.log(`  ${dim("Or, if this is an API-key integration, run:")}`)
        console.log(`  ${highlight(`iris integrations setup ${type} --api-key <key>`)}`)
        prompts.outro("Done")
        return
      }

      prompts.log.error(`Could not generate OAuth URL for ${type}.`)
      if (composioError) {
        // Sanitize provider names from error messages before showing to users
        const sanitized = String(composioError)
          .replace(/composio/gi, "integration provider")
          .replace(/backend\.composio\.dev/gi, "iris.freelabel.net")
        console.log(`  ${dim("Reason:")} ${sanitized}`)
      } else {
        prompts.log.info("OAuth credentials may not be configured for this provider.")
      }
      console.log()
      console.log(`  ${dim("Try:")} ${highlight("iris integrations list")} to see available integrations.`)
      prompts.outro("Done")
      return
    }

    spinner.stop("Ready")
    console.log()
    if (printUrlOnly) {
      if (headless && !args["print-url"]) {
        // Say why there is no browser, so this does not read as a half-finished run.
        console.log(`  ${dim("No terminal detected — printing the URL instead of opening a browser.")}`)
        console.log()
      }
      console.log(`  ${success("→")} Open this URL to authorize ${highlight(type)}:`)
      console.log()
      console.log(`  ${highlight(url)}`)
      console.log()
      console.log(`  ${dim("After authorizing, verify with:")} ${highlight("iris integrations list-connected")}`)
      prompts.outro("Done")
      return
    }

    // #171182: snapshot what already exists BEFORE authorising. Without this the
    // poll below matches the very connection the user is trying to repair and
    // reports success for a failed OAuth.
    const snapshotUserId = await requireUserId().catch(() => null)
    let connectionsBefore: ConnectionRow[] = []
    if (snapshotUserId) {
      try {
        const beforeRes = await irisFetch(`/api/v1/users/${snapshotUserId}/integrations`)
        if (beforeRes.ok) connectionsBefore = extractConnections(await beforeRes.json())
      } catch {}
    }

    console.log(`  ${success("→")} Opening ${highlight(type)} in your browser to authorize…`)
    openBrowser(url)
    console.log()
    console.log(`  ${dim("If the browser didn't open, run:")} ${dim(`iris integrations connect ${type} --print-url`)}`)
    console.log()

    // Poll for connection confirmation (up to 60s)
    const pollSpinner = prompts.spinner()
    pollSpinner.start("Waiting for authorization… (complete in your browser)")

    const pollUserId = snapshotUserId ?? (await requireUserId().catch(() => null))
    const pollStart = Date.now()
    const pollTimeout = 60_000
    let connected = false
    let verifiedBy: string | null = null

    // A REAL CALL, NOT A LIST DIFF (#182697).
    //
    // The diff below can only report that a ROW CHANGED. It cannot report that the
    // credential works, and every failure we have hit came from that gap: a repair
    // overwrites a row so nothing looks new; the callback can land just after the poll
    // gives up; `status: "active"` is a claim rather than a test; and a live connection
    // can be pointed at entirely the wrong account. So the primary check is now a
    // read-only call THROUGH the new credential — it either returns data or it does not.
    //
    // The diff is kept as a fallback for toolkits we have no trusted read-only probe for.
    const probe = verifyProbeFor(type)

    while (pollUserId && Date.now() - pollStart < pollTimeout) {
      await new Promise((r) => setTimeout(r, 3000))

      if (probe) {
        try {
          const probeRes = await irisFetch(`/api/v1/users/${pollUserId}/integrations/execute-direct`, {
            method: "POST",
            body: JSON.stringify({ integration: type, action: probe.action, params: probe.params }),
          })
          const body = await probeRes.json().catch(() => null)
          if (isProbeSuccess(body)) {
            connected = true
            verifiedBy = probe.label
            break
          }
          // "We were not allowed to ask" is not "your integration is broken" (#182581).
          // Fall through to the diff rather than calling a good connection dead.
          if (!isProbeInconclusive(probeRes.status, body)) {
            // A real, answered failure — keep waiting; the callback may not have landed yet.
          }
        } catch {}
      }

      try {
        const checkRes = await irisFetch(`/api/v1/users/${pollUserId}/integrations`)
        if (checkRes.ok) {
          // #171182: only a NEW or newly-activated connection counts. An unchanged
          // pre-existing row means the authorisation did not go through.
          const match = detectNewConnection(connectionsBefore, extractConnections(await checkRes.json()), type)
          if (match) {
            connected = true
            break
          }
        }
      } catch {}
    }

    if (connected) {
      pollSpinner.stop(
        verifiedBy
          ? `${success("✓")} ${bold(type)} connected — verified by ${verifiedBy}`
          : `${success("✓")} ${bold(type)} connected successfully!`,
      )
      if (!verifiedBy && probe) {
        // Say which half we proved. A row exists; nobody has shown the credential works.
        console.log()
        console.log(`  ${dim("A connection record appeared, but no live call confirmed it yet.")}`)
        console.log(`  ${dim("Confirm with:")} ${highlight(`iris integrations exec ${type} ${probe.action}`)}`)
      }
    } else {
      pollSpinner.stop(`${dim("No new connection detected — authorization did not complete")}`)
      console.log()
      console.log(`  ${dim("The browser step may have failed (a redirect_uri_mismatch shows as a Google 400).")}`)
      console.log(`  ${dim("Verify with:")} ${highlight("iris integrations list-connected")}`)
      console.log(`  ${dim("Retry and read the browser error:")} ${highlight(`iris integrations connect ${type} --print-url`)}`)
      process.exitCode = 1
    }
    prompts.outro("Done")
  },
})

const ExecCommand = cmd({
  command: "exec <target> [function] [params..]",
  aliases: ["call"],
  describe: "execute an integration function or system tool",
  builder: (y) =>
    y
      .positional("target", { type: "string", demandOption: true, describe: "integration type or tool name" })
      .positional("function", { type: "string", describe: "function (for integrations)" })
      .positional("params", { type: "string", array: true, default: [], describe: "key=value params" })
      .option("json", { type: "boolean" })
      .option("params-json", {
        alias: "p",
        type: "string",
        describe: "JSON params string (e.g. '{\"title\":\"My Event\"}'). Merged with key=value positional params.",
      })
      .option("params-file", {
        type: "string",
        describe: "load params from a JSON file (merged with key=value params; key=value wins on conflict)",
      })
      .option("integration-id", {
        type: "number",
        describe: "target a specific connected account by integration record ID (multi-account)",
      })
      .option("account", {
        type: "string",
        describe: "target a connected account by email or name (e.g. --account=alex@gmail.com)",
      }),
  async handler(args) {
    // Suppress all UI chrome when --json for clean pipeable output (#55735)
    if (!args.json) {
      UI.empty()
      prompts.intro(`◈  Run: ${args.target}`)
    }
    if (!(await requireAuth())) { if (!args.json) prompts.outro("Done"); return }

    const target = String(args.target)
    let fn = args.function ? String(args.function) : undefined
    // args.params can be:
    // - string[] from positional: ["title=Test", "start_time=..."]
    // - string from --params flag: '{"title":"Test"}' (yargs positional "params" shadows --params)
    // Because the positional is named "params", yargs merges --params into the same key.
    // We detect JSON strings in the array and parse them as structured params.
    const rawParamsArg = (args as Record<string, unknown>)["params"] as string | string[] | undefined
    let jsonFromFlag: Record<string, unknown> | null = null
    let rawParams: string[] = []

    if (typeof rawParamsArg === "string") {
      // --params consumed as a single string value
      const paramStr: string = rawParamsArg
      if (paramStr.startsWith("{")) {
        try {
          jsonFromFlag = JSON.parse(paramStr)
        } catch {
          prompts.log.error("Invalid JSON in --params")
          prompts.outro("Done")
          return
        }
      } else {
        rawParams = [paramStr]
      }
    } else if (Array.isArray(rawParamsArg)) {
      // Positional array — but --params may have pushed a JSON string into the array
      for (const item of rawParamsArg) {
        const s = String(item)
        if (s.startsWith("{") && s.endsWith("}") && !jsonFromFlag) {
          try {
            jsonFromFlag = JSON.parse(s)
            continue
          } catch { /* not JSON */ }
        }
        rawParams.push(s)
      }
    }

    // Also detect JSON strings that landed in positional args
    let jsonFromPositional: Record<string, unknown> | null = null
    const filteredRaw: string[] = []
    for (const p of rawParams) {
      if (p.startsWith("{") && p.endsWith("}")) {
        try {
          const parsed = JSON.parse(p)
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            jsonFromPositional = { ...(jsonFromPositional ?? {}), ...parsed }
            continue
          }
        } catch { /* not JSON, treat as key=value */ }
      }
      filteredRaw.push(p)
    }
    const cliParams = parseParams(filteredRaw)

    // Merge --params-file (if provided) with CLI key=value params.
    // CLI key=value wins on conflict, so you can override file values inline.
    let params: Record<string, unknown> = {}
    const paramsFile = args["params-file"] as string | undefined
    if (paramsFile) {
      try {
        const fs = await import("fs")
        const fileText = fs.readFileSync(paramsFile, "utf-8")
        const fileJson = JSON.parse(fileText)
        if (typeof fileJson !== "object" || fileJson === null || Array.isArray(fileJson)) {
          throw new Error("--params-file must be a JSON object")
        }
        params = { ...fileJson }
      } catch (e) {
        prompts.log.error(`Failed to load --params-file: ${e instanceof Error ? e.message : String(e)}`)
        prompts.outro("Done")
        return
      }
    }
    params = { ...params, ...cliParams }

    // Merge --params-json / -p (explicit JSON flag)
    const jsonParamsRaw = args["params-json"] as string | undefined
    if (jsonParamsRaw && typeof jsonParamsRaw === "string") {
      try {
        const parsed = JSON.parse(jsonParamsRaw)
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          params = { ...parsed, ...params }
        }
      } catch {
        prompts.log.error("Invalid JSON in --params-json / -p")
        prompts.outro("Done")
        return
      }
    }

    // Merge JSON from --params flag or positional detection
    if (jsonFromFlag) {
      params = { ...jsonFromFlag, ...params }
    }
    if (jsonFromPositional) {
      params = { ...jsonFromPositional, ...params }
    }

    try {
      if (isIntegration(target)) {
        if (!fn) {
          // Show available functions for this integration
          const functions = INTEGRATION_FUNCTIONS[target] ?? INTEGRATION_FUNCTIONS[SLUG_ALIASES[target] ?? ""]
          if (functions) {
            prompts.log.warn(`No function specified for ${target}. Available functions:`)
            console.log()
            for (const f of functions) {
              console.log(`  ${highlight(f.name)}  ${dim(f.description)}`)
            }
            console.log()
            prompts.outro(dim(`iris integrations exec ${target} ${functions[0]?.name ?? "<function>"} key=value …`))
          } else {
            prompts.log.warn(`No function specified for ${target}.`)
            prompts.outro(dim(`iris integrations exec ${target} <function> key=value …`))
          }
          return
        }
        // Skip spinner/ANSI when --json to keep output parseable (#55735)
        const accountOpts = {
          integrationId: args["integration-id"] as number | undefined,
          account: args.account as string | undefined,
        }
        if (args.json) {
          const result = await executeIntegrationCall(target, fn, params, accountOpts)
          await writeJson(result)
          return
        }
        const spinner = prompts.spinner()
        const accountLabel = accountOpts.integrationId
          ? ` ${dim(`(#${accountOpts.integrationId})`)}`
          : accountOpts.account
            ? ` ${dim(`(${accountOpts.account})`)}`
            : ""
        spinner.start(`Executing ${target}.${fn}${accountLabel}…`)
        const result = await executeIntegrationCall(target, fn, params, accountOpts)
        spinner.stop(`${target}.${fn}`)
        displayResult(result, `${target}.${fn}`)
        prompts.outro("Done")
        return
      }

      // System tool path — function name might be a key=value
      if (fn && fn.includes("=")) {
        params = { ...parseParams([fn]), ...params }
        fn = undefined
      }

      const userId = await requireUserId()
      if (args.json) {
        // Clean JSON output — no spinner/ANSI (#55735)
        const res = await irisFetch(`/api/v1/tools/execute`, {
          method: "POST",
          body: JSON.stringify({ tool: target, params, user_id: userId }),
        }, IRIS_API)
        if (!res.ok) {
          console.log(JSON.stringify({ error: `HTTP ${res.status}`, success: false }))
          process.exitCode = 1
          return
        }
        await writeJson(await res.json())
        return
      }
      const spinner = prompts.spinner()
      spinner.start(`Executing tool ${target}…`)
      const res = await irisFetch(`/api/v1/tools/execute`, {
        method: "POST",
        body: JSON.stringify({ tool: target, params, user_id: userId }),
      }, IRIS_API)
      if (!res.ok) {
        spinner.stop("Failed", 1)
        prompts.log.error(`HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }
      const result = await res.json()
      spinner.stop(target)
      displayResult(result, target)
      prompts.outro("Done")
    } catch (e) {
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Root command — `iris integrations …`
// (Top-level `run` is taken by opencode's RunCommand, so we use `integrations`.)
// ============================================================================

// No hardcoded fallback: a stale key here silently 401s every integrations
// call (see bug #164644). Require COMPOSIO_API_KEY and fail loud if missing.
// Read at call-time (not module load) so env vars set after import are honored
// (see bug #17 — COMPOSIO_API_KEY read at module load time missed late-set vars).
const COMPOSIO_BASE = "https://backend.composio.dev/api"

function getComposioKey(): string {
  const key = process.env.COMPOSIO_API_KEY ?? ""
  if (!key) {
    throw new Error(
      "COMPOSIO_API_KEY is not set. Generate a key at https://dashboard.composio.dev → API Keys and export it (e.g. `export COMPOSIO_API_KEY=ak_…`) before running `iris integrations …`.",
    )
  }
  return key
}

async function composioFetch(path: string, init?: RequestInit) {
  const key = getComposioKey()
  return fetch(`${COMPOSIO_BASE}${path}`, {
    ...init,
    headers: {
      "x-api-key": key,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  })
}

const SetupCommand = cmd({
  command: "setup <toolkit>",
  describe: "register an integration's API key (one-time per workspace)",
  builder: (y) =>
    y
      .positional("toolkit", { type: "string", demandOption: true, describe: "integration toolkit slug (e.g., cloudflare_api_key)" })
      .option("api-key", { type: "string", describe: "API key for API_KEY toolkits" })
      .option("managed", { type: "boolean", default: false, describe: "use platform-managed credentials" })
      .option("auth-scheme", { type: "string", default: "API_KEY" })
      .option("name", { type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Setup: ${args.toolkit}`)

    const toolkit = String(args.toolkit)
    const managed = !!args.managed
    const authScheme = String(args["auth-scheme"] ?? "API_KEY")
    const apiKey = args["api-key"] ? String(args["api-key"]) : null

    if (!managed && !apiKey && authScheme === "API_KEY") {
      prompts.log.error("API_KEY toolkits need --api-key <key> or --managed")
      prompts.outro("Done")
      return
    }

    const body = {
      toolkit: { slug: toolkit },
      auth_config: {
        name: args.name ? String(args.name) : `${toolkit}-config`,
        type: managed ? "use_composio_managed_auth" : "use_custom_auth",
        authScheme,
        credentials: apiKey ? { api_key: apiKey } : {},
      },
    }

    const spinner = prompts.spinner()
    spinner.start("Registering credentials…")
    try {
      const res = await composioFetch("/v3/auth_configs", {
        method: "POST",
        body: JSON.stringify(body),
      })
      const text = await res.text()
      let data: any = {}
      try { data = JSON.parse(text) } catch {}

      if (!res.ok) {
        spinner.stop("Failed", 1)
        prompts.log.error(`HTTP ${res.status}`)
        const sanitized = text.replace(/composio/gi, "integration provider")
          .replace(/backend\.composio\.dev/gi, "iris.freelabel.net")
        console.log(sanitized)
        prompts.outro("Done")
        return
      }

      const ac = data.auth_config ?? data
      const id = ac?.id ?? data?.id
      spinner.stop("Credentials registered")
      console.log()
      console.log(`  ${bold("Toolkit:")}      ${highlight(toolkit)}`)
      console.log(`  ${bold("Auth scheme:")}  ${authScheme}`)
      console.log()
      console.log(`  ${bold("Next:")} ${highlight(`iris integrations connect-direct ${toolkit}`)}`)
      prompts.outro("Done")
    } catch (e) {
      spinner.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})

const ConnectComposioCommand = cmd({
  command: "connect-direct <toolkit>",
  aliases: ["connect-composio"],
  describe: "connect an integration using a registered API key (after `setup`)",
  builder: (y) =>
    y
      .positional("toolkit", { type: "string", demandOption: true })
      .option("auth-config", { type: "string", describe: "auth config id (ac_xxx); auto-discovered if omitted" })
      .option("user-id", { type: "number", describe: "user id (defaults to local user)" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Connect: ${args.toolkit}`)

    const toolkit = String(args.toolkit)
    let authConfigId = args["auth-config"] ? String(args["auth-config"]) : null
    const userId = args["user-id"] ? String(args["user-id"]) : `user-${(await requireUserId().catch(() => 0)) || "local"}`

    const spinner = prompts.spinner()

    // Auto-discover auth_config if not provided
    if (!authConfigId) {
      spinner.start("Looking up auth_config…")
      try {
        const res = await composioFetch(`/v3/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}`)
        const data = (await res.json()) as any
        const items = data.items ?? data.data ?? []
        if (items.length === 0) {
          spinner.stop("None found", 1)
          prompts.log.error(`No auth_config for ${toolkit}. Run: iris integrations setup ${toolkit} --api-key <key>`)
          prompts.outro("Done")
          return
        }
        authConfigId = items[0].id
        spinner.stop(`Found ${authConfigId}`)
      } catch (e) {
        spinner.stop("Failed", 1)
        prompts.log.error(e instanceof Error ? e.message : String(e))
        prompts.outro("Done")
        return
      }
    }

    spinner.start("POST /v3/connected_accounts…")
    try {
      // Read expected_input_fields from the auth_config so credentials are
      // submitted in the exact shape Composio requires (e.g. generic_api_key).
      const state = await buildComposioConnectionState(authConfigId!)
      const res = await composioFetch("/v3/connected_accounts", {
        method: "POST",
        body: JSON.stringify({
          auth_config: { id: authConfigId },
          connection: state ? { user_id: userId, state } : { user_id: userId },
        }),
      })
      const text = await res.text()
      let data: any = {}
      try { data = JSON.parse(text) } catch {}

      if (!res.ok) {
        spinner.stop("Failed", 1)
        prompts.log.error(`HTTP ${res.status}`)
        console.log(text)
        prompts.outro("Done")
        return
      }

      const cid = data.id ?? data.connected_account_id
      const url = data.redirect_url ?? data.redirectUrl ?? data.connectionData?.redirectUrl
      const status = data.status ?? data.connectionData?.status

      spinner.stop("Connected account created")
      console.log()
      console.log(`  ${bold("Connected account:")} ${highlight(cid ?? "?")}`)
      console.log(`  ${bold("Status:")}            ${status ?? "?"}`)
      if (url) {
        console.log()
        console.log(`  ${bold("Authorize:")} ${highlight(url)}`)
        openBrowser(url)
        console.log(`  ${dim("(Opened in browser)")}`)
      } else {
        console.log()
        console.log(`  ${dim("API_KEY toolkit — connection is active immediately, no redirect needed.")}`)
      }
      prompts.outro("Done")
    } catch (e) {
      spinner.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Cleanup — find and remove duplicate auth_configs
// ============================================================================

const CleanupCommand = cmd({
  command: "cleanup",
  describe: "find and remove duplicate auth configs (keeps the one with most connections)",
  builder: (y) =>
    y
      .option("yes", { alias: "y", type: "boolean", default: false, describe: "actually delete (default is dry run)" })
      .option("toolkit", { alias: "t", type: "string", describe: "only clean up a specific toolkit slug" })
      .option("json", { type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Cleanup duplicate integrations")

    const sp = prompts.spinner()
    sp.start("Fetching auth configs…")

    // 1. Fetch all auth_configs (paginate if needed)
    const allConfigs: any[] = []
    let cursor: string | null = null
    try {
      do {
        const path = cursor
          ? `/v3/auth_configs?cursor=${encodeURIComponent(cursor)}&limit=100`
          : `/v3/auth_configs?limit=100`
        const res = await composioFetch(path)
        if (!res.ok) {
          sp.stop("Failed to fetch auth configs", 1)
          prompts.log.error(`HTTP ${res.status}`)
          prompts.outro("Done")
          return
        }
        const data = (await res.json()) as any
        const items = data?.items ?? data?.auth_configs ?? data?.data ?? []
        allConfigs.push(...items)
        cursor = data?.next_cursor ?? data?.nextCursor ?? null
      } while (cursor)
    } catch (e) {
      sp.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
      return
    }

    sp.message(`Found ${allConfigs.length} auth configs. Counting connections…`)

    // 2. Fetch all connected_accounts to count usage per auth_config
    const connectionCount = new Map<string, number>()
    cursor = null
    try {
      do {
        const path = cursor
          ? `/v3/connected_accounts?cursor=${encodeURIComponent(cursor)}&limit=100`
          : `/v3/connected_accounts?limit=100`
        const res = await composioFetch(path)
        if (!res.ok) break
        const data = (await res.json()) as any
        const items = data?.items ?? data?.data ?? []
        for (const item of items) {
          const acId = item?.auth_config?.id ?? item?.authConfigId ?? item?.auth_config_id
          if (acId) {
            connectionCount.set(acId, (connectionCount.get(acId) ?? 0) + 1)
          }
        }
        cursor = data?.next_cursor ?? data?.nextCursor ?? null
      } while (cursor)
    } catch {
      // continue with what we have
    }

    sp.stop(`Loaded ${allConfigs.length} configs with connection counts`)

    // 3. Group by toolkit slug, optionally filtered
    const groups = new Map<string, any[]>()
    for (const cfg of allConfigs) {
      const slug = String(cfg?.toolkit?.slug ?? cfg?.toolkit_slug ?? "?").toLowerCase()
      if (args.toolkit && slug !== String(args.toolkit).toLowerCase()) continue
      if (!groups.has(slug)) groups.set(slug, [])
      groups.get(slug)!.push(cfg)
    }

    // 4. For each toolkit with >1 config, mark duplicates for deletion
    type Plan = {
      toolkit: string
      keep: { id: string; name: string; connections: number; updated: string }
      delete: { id: string; name: string; connections: number; updated: string }[]
    }
    const plans: Plan[] = []

    for (const [toolkit, configs] of groups) {
      if (configs.length <= 1) continue

      // Annotate each with connection count and updated timestamp
      const annotated = configs.map((c) => ({
        id: String(c.id ?? ""),
        name: String(c.name ?? c.auth_config?.name ?? "(unnamed)"),
        connections: connectionCount.get(String(c.id ?? "")) ?? 0,
        updated: String(c.updated_at ?? c.last_updated ?? c.created_at ?? ""),
        raw: c,
      }))

      // Sort: most connections first, then most recently updated
      annotated.sort((a, b) => {
        if (b.connections !== a.connections) return b.connections - a.connections
        return b.updated.localeCompare(a.updated)
      })

      const [keep, ...rest] = annotated
      plans.push({
        toolkit,
        keep: { id: keep.id, name: keep.name, connections: keep.connections, updated: keep.updated },
        delete: rest.map((r) => ({ id: r.id, name: r.name, connections: r.connections, updated: r.updated })),
      })
    }

    if (args.json) {
      await writeJson({ dry_run: !args.yes, plans })
      prompts.outro("Done")
      return
    }

    if (plans.length === 0) {
      console.log()
      console.log(`  ${success("✓")} No duplicates found across ${groups.size} toolkit${groups.size === 1 ? "" : "s"}.`)
      prompts.outro("Done")
      return
    }

    // 5. Show the plan
    console.log()
    console.log(bold(`Found ${plans.length} toolkit${plans.length === 1 ? "" : "s"} with duplicates:`))
    printDivider()

    let totalToDelete = 0
    for (const plan of plans) {
      console.log()
      console.log(`  ${highlight(plan.toolkit)}`)
      console.log(`    ${success("KEEP")}    ${dim(plan.keep.id)}  ${plan.keep.name}  ${dim(`(${plan.keep.connections} connections)`)}`)
      for (const del of plan.delete) {
        console.log(`    ${dim("DELETE")}  ${dim(del.id)}  ${del.name}  ${dim(`(${del.connections} connections)`)}`)
        totalToDelete++
      }
    }
    printDivider()
    console.log()

    if (!args.yes) {
      console.log(`  ${dim(`Dry run — would delete ${totalToDelete} auth config${totalToDelete === 1 ? "" : "s"}.`)}`)
      console.log(`  ${dim("Run with")} ${highlight("--yes")} ${dim("to actually delete.")}`)
      prompts.outro("Done")
      return
    }

    // 6. Confirm before deleting connections-bearing configs
    const willDeleteConnections = plans.some((p) => p.delete.some((d) => d.connections > 0))
    if (willDeleteConnections) {
      const ok = await prompts.confirm({
        message: "Some duplicates have active connections. Delete anyway?",
        initialValue: false,
      })
      if (prompts.isCancel(ok) || !ok) {
        prompts.outro("Cancelled")
        return
      }
    }

    // 7. Delete
    const sp2 = prompts.spinner()
    sp2.start(`Deleting ${totalToDelete} duplicate config${totalToDelete === 1 ? "" : "s"}…`)

    let deleted = 0
    let failed = 0
    for (const plan of plans) {
      for (const del of plan.delete) {
        try {
          const res = await composioFetch(`/v3/auth_configs/${del.id}`, { method: "DELETE" })
          if (res.ok || res.status === 204) {
            deleted++
          } else {
            failed++
            console.log()
            console.log(`  ${dim("Failed:")} ${del.id} (HTTP ${res.status})`)
          }
        } catch (e) {
          failed++
          console.log()
          console.log(`  ${dim("Failed:")} ${del.id} (${e instanceof Error ? e.message : String(e)})`)
        }
      }
    }

    sp2.stop(failed === 0 ? `Deleted ${deleted}` : `Deleted ${deleted}, ${failed} failed`, failed === 0 ? 0 : 1)
    prompts.outro("Done")
  },
})

export const PlatformRunCommand = cmd({
  command: "integrations",
  aliases: ["int"],
  describe: "execute integration functions, V6 system tools, OAuth connect",
  builder: (yargs) =>
    yargs
      .command(ExecCommand)
      .command(ListToolsCommand)
      .command(ListIntegrationsCommand)
      .command(ListConnectedCommand)
      .command(ListAvailableCommand)
      .command(ConnectCommand)
      .command(SetupCommand)
      .command(ConnectComposioCommand)
      .command(CleanupCommand)
      // Adopted from platform-integrations.ts (#181924). That module registered the
      // same `integrations` token as this one and lost it to registration order, so
      // these four had no reachable route at all — sharing an integration with a
      // bloq, revoking that share, disconnecting one, and creating a native API-key
      // integration were CLI-unavailable while `iris --help` advertised them.
      .command(IntegrationsShareCommand)
      .command(IntegrationsUnshareCommand)
      .command(IntegrationsDisconnectCommand)
      .command(IntegrationsSetupNativeCommand)
      .command(PathwaysCommand)
      .demandCommand(),
  async handler() {},
})

// Top-level shortcuts so AI agents and users can find these without nesting
export const PlatformConnectCommand = cmd({
  command: "connect <type>",
  describe: "connect an integration via OAuth or API key (alias for `integrations connect`)",
  builder: (yargs) =>
    yargs.positional("type", {
      describe: "integration type (e.g., google-docs, canva, apollo)",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    return ConnectCommand.handler(args as any)
  },
})

export const PlatformListConnectedCommand = cmd({
  command: "list-connected",
  aliases: ["connections"],
  describe: "show your connected integrations (alias for `integrations list-connected`)",
  async handler(args) {
    return ListConnectedCommand.handler(args as any)
  },
})

export const PlatformListAvailableCommand = cmd({
  command: "list-available",
  describe: "show all available integrations + connection status",
  async handler(args) {
    return ListAvailableCommand.handler(args as any)
  },
})

// Top-level `exec` — restores the old `iris run <tool>` workflow that moved under
// `integrations` when opencode took the `run` command (#117198). `iris exec searchPlaces ...`
// or `iris exec gmail search_emails query=...` now works without nesting.
export const PlatformExecCommand = cmd({
  command: "exec <target> [function] [params..]",
  aliases: ["call", "run-tool"],
  describe: "execute an integration function or V6 system tool (alias for `integrations exec`)",
  builder: (ExecCommand as any).builder,
  async handler(args) {
    return (ExecCommand as any).handler(args)
  },
})

export const PlatformListToolsCommand = cmd({
  command: "list-tools",
  describe: "list available V6 system tools (alias for `integrations list-tools`)",
  async handler(args) {
    return (ListToolsCommand as any).handler(args)
  },
})

export const PlatformListIntegrationsCommand = cmd({
  command: "list-integrations",
  describe: "list all integration types (alias for `integrations list-integrations`)",
  async handler(args) {
    return (ListIntegrationsCommand as any).handler(args)
  },
})
