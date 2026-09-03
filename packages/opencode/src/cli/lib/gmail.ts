/**
 * Gmail access — routed through the IRIS backend, never straight to Google.
 *
 * WAS (broken for everyone, #178282): getToken() fetched a raw OAuth access token from
 * /api/v1/integrations/gmail/credentials and this module called googleapis.com directly.
 * That route DOES NOT EXIST in fl-api — grepping the whole routes tree finds no
 * /credentials registration, and it 404s live. So getToken() always returned null and
 * every `iris gmail` subcommand printed "No Gmail connected" regardless of the account's
 * real state. It had never worked for anybody.
 *
 * NOW: everything goes through POST /api/v1/users/{id}/integrations/execute-direct on
 * iris-api — the same path `iris integrations exec gmail ...` uses, which demonstrably
 * reaches Gmail. That is also what CLAUDE.md requires ("Frontend calls backend API
 * endpoints, never directly calls external APIs"), and it means a Google access token is
 * never handed to the client.
 *
 * The exported signatures still take a leading `token` argument so the three consumers
 * (platform-gmail.ts, platform-atlas-comms.ts, platform-inbox.ts) keep working unchanged.
 * The value is now an opaque sentinel from getToken() and is deliberately ignored.
 */

// ── Types ──

export interface GmailMessage {
  id: string
  thread_id: string
  from: string
  to: string
  subject: string
  date: string
  snippet: string
  body_text: string
  labels: string[]
  is_unread: boolean
}

export interface GmailLabel {
  id: string
  name: string
  type: string
  messages_total: number
  messages_unread: number
}

export interface GmailThread {
  id: string
  snippet: string
  messages: GmailMessage[]
}

// ── Backend session ──

/**
 * Opaque sentinel. Callers pass it back into the functions below; it carries no
 * credential. Kept only so existing call sites (which expect a token string) work
 * unchanged now that auth lives entirely on the backend.
 */
const BACKEND = "iris-backend"

let _checked: string | null = null

/**
 * Confirm Gmail is usable via the backend. Returns the sentinel when it is, null when
 * it is not — and on null, lastError() explains WHY, which the old implementation could
 * never do because it had no idea whether a null token meant "not connected", "expired"
 * or "the endpoint does not exist".
 */
export async function getToken(): Promise<string | null> {
  if (_checked) return _checked

  // DEEP. This gate exists in front of commands that are about to make a real Gmail request
  // anyway, so a shallow pre-check buys nothing and can only be wrong — and it was.
  //
  // The shallow path reads /api/v1/integrations, which does not surface Composio-backed
  // connections. On 2026-08-28 that made `iris gmail inbox` refuse to run for a client whose
  // Gmail was live and working: the very same execute-direct call the command was about to
  // make returned her inbox fine. She was told "No Gmail connection found", her agent believed
  // it, and the reconnect attempts that followed created duplicate dead connections that then
  // shadowed the working one.
  //
  // getGmailStatus's own comment already said the shallow read "is not authoritative" and that
  // "the truth is only ever what a live request returns". It was right; this just never used it.
  const status = await getGmailStatus({ deep: true })
  if (status.ok) {
    _checked = BACKEND
    return BACKEND
  }

  _lastError = status.reason
  return null
}

let _lastError = "No Gmail connected."

/** Human-readable reason the last getToken() failed. */
export function lastError(): string {
  return _lastError
}

export function clearTokenCache(): void {
  _checked = null
}

/**
 * Ask the platform whether this user has a usable Gmail connection, and say precisely
 * what is wrong when they do not. Distinguishing "never connected" from "expired" is the
 * whole point — conflating them is what made #178282 unreadable for weeks.
 */
export async function getGmailStatus(opts: { deep?: boolean } = {}): Promise<{ ok: boolean; reason: string }> {
  // Deep check: make a real Gmail call. The shallow check below reads the LOCAL
  // integrations row, which is not authoritative — it reported "active" while Composio
  // reported the connected account EXPIRED. Callers that must not be wrong (doctor,
  // anything reporting health) should pass deep:true; the truth is only ever what a
  // live request returns.
  if (opts.deep) {
    try {
      await getLabels("")
      return { ok: true, reason: "" }
    } catch (e: any) {
      return { ok: false, reason: String(e?.message ?? "Gmail request failed.") }
    }
  }

  try {
    const { irisFetch } = await import("../cmd/iris-api")
    const res = await irisFetch("/api/v1/integrations")

    if (!res.ok) {
      return { ok: false, reason: `Could not read your integrations (HTTP ${res.status}).` }
    }

    const body = (await res.json()) as any
    const raw = body?.data ?? body?.integrations ?? body
    const list: any[] = Array.isArray(raw) ? raw : Object.values(raw ?? {}).flat().filter((x: any) => x && typeof x === "object")

    const gmail = list.filter((i) => /gmail/i.test(String(i?.name ?? i?.slug ?? i?.service ?? i?.type ?? "")))
    if (gmail.length === 0) {
      return { ok: false, reason: "No Gmail connection found. Connect it with: iris integrations connect gmail" }
    }

    const active = gmail.find((i) => String(i?.status ?? "").toLowerCase() === "active")
    if (!active) {
      const statuses = [...new Set(gmail.map((i) => String(i?.status ?? "unknown")))].join(", ")
      return {
        ok: false,
        reason: `Gmail is connected but not usable (status: ${statuses}). Reconnect with: iris integrations connect gmail --yes`,
      }
    }

    // A local row saying "active" is NOT proof the connection works — this exact row read
    // active while Composio had the account EXPIRED. Treat it as "worth trying"; the
    // authoritative answer comes from the execution error, which now propagates verbatim.
    return { ok: true, reason: "" }
  } catch (e: any) {
    return { ok: false, reason: `Could not reach the platform: ${e?.message ?? "unknown error"}` }
  }
}

// ── API Calls (via the backend integration executor) ──

/**
 * Execute a Gmail action through iris-api. Throws with the upstream message on failure —
 * including Composio's own errors (e.g. a connected account in EXPIRED state), which is
 * the signal that used to be thrown away.
 */
async function gmailExec(action: string, params: Record<string, unknown>): Promise<any> {
  const { irisFetch, IRIS_API, resolveUserId } = await import("../cmd/iris-api")

  const userId = await resolveUserId()
  if (!userId) throw new Error("Not signed in — run: iris auth login")

  const res = await irisFetch(
    `/api/v1/users/${userId}/integrations/execute-direct`,
    { method: "POST", body: JSON.stringify({ integration: "gmail", action, params }) },
    IRIS_API,
  )

  const data = (await res.json().catch(() => ({}))) as any

  if (!res.ok) {
    throw new Error(data?.error ?? data?.message ?? `Gmail request failed (HTTP ${res.status}).`)
  }
  if (data?.success === false) {
    clearTokenCache()
    throw new Error(String(data?.error ?? data?.message ?? "Gmail request failed."))
  }

  return data?.data ?? data?.result ?? data
}

// ── Labels ──

export async function getLabels(_token: string): Promise<GmailLabel[]> {
  const data = await gmailExec("get_labels", {})
  const labels = data?.labels ?? data?.response_data?.labels ?? (Array.isArray(data) ? data : [])
  return (labels ?? []).map((l: any) => ({
    id: l.id ?? "",
    name: l.name ?? "",
    type: l.type ?? "",
    messages_total: l.messagesTotal ?? l.messages_total ?? 0,
    messages_unread: l.messagesUnread ?? l.messages_unread ?? 0,
  })) as GmailLabel[]
}

// ── Messages ──

export async function listMessages(_token: string, query = "", limit = 20): Promise<GmailMessage[]> {
  const data = await gmailExec("read_emails", {
    query: query || "in:inbox",
    max_results: Math.min(limit, 100),
  })
  return extractMessages(data).slice(0, limit)
}

export async function getMessageById(_token: string, messageId: string): Promise<GmailMessage | null> {
  try {
    const data = await gmailExec("read_emails", { message_id: messageId, max_results: 1 })
    return extractMessages(data)[0] ?? null
  } catch {
    return null
  }
}

export async function searchMessages(token: string, query: string, limit = 20): Promise<GmailMessage[]> {
  return listMessages(token, query, limit)
}

// ── Threads ──

export async function getThread(_token: string, threadId: string): Promise<GmailThread | null> {
  try {
    const data = await gmailExec("read_emails", { thread_id: threadId, max_results: 50 })
    const messages = extractMessages(data)
    return { id: threadId, snippet: messages[0]?.snippet ?? "", messages }
  } catch {
    return null
  }
}

/**
 * Normalise whatever shape the backend/Composio hands back into GmailMessage[].
 *
 * Deliberately tolerant across nestings and both camelCase and snake_case, because the
 * response shape varies by Composio tool version. Note the lesson from #178548: a wide
 * `??` chain across a service boundary can silently yield empty strings forever, so the
 * fallbacks here are for KNOWN alias spellings of the same field, never a shrug.
 */
function extractMessages(data: any): GmailMessage[] {
  const arr =
    data?.messages ??
    data?.response_data?.messages ??
    data?.data?.messages ??
    (Array.isArray(data) ? data : [])

  if (!Array.isArray(arr)) return []

  return arr.map((m: any): GmailMessage => {
    // Composio may return pre-parsed fields, or raw Gmail payload headers.
    const headers = m?.payload?.headers ?? []
    const hdr = (name: string) =>
      headers.find((h: any) => String(h?.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? ""

    const labels = m.labelIds ?? m.label_ids ?? m.labels ?? []

    // Verified field names from a live GMAIL_FETCH_EMAILS response (2026-08-02):
    //   messageId · threadId · sender · to · subject · messageTimestamp ·
    //   messageText · labelIds · preview{body,subject} · payload{...}
    // NOTE `preview` is an OBJECT, not a string — reading it as one crashed the
    // renderer with "msg.snippet.slice is not a function". str() coerces defensively
    // so a shape change degrades to "" instead of throwing mid-render.
    return {
      id: str(m.messageId ?? m.id ?? m.message_id),
      thread_id: str(m.threadId ?? m.thread_id),
      from: str(m.sender ?? m.from ?? hdr("From")),
      to: str(m.to ?? m.recipient ?? hdr("To")),
      subject: str(m.subject ?? m.preview?.subject ?? hdr("Subject")),
      date: str(m.messageTimestamp ?? m.date ?? m.message_timestamp ?? hdr("Date")),
      snippet: str(m.preview?.body ?? m.snippet ?? m.preview),
      body_text: str(m.messageText ?? m.body_text ?? m.message_text ?? m.body) || decodePayload(m),
      labels: Array.isArray(labels) ? labels : [],
      is_unread: (Array.isArray(labels) ? labels : []).includes("UNREAD"),
    }
  })
}

/**
 * Coerce to a string. Composio returns some fields as objects (notably `preview`), and
 * the renderer calls .slice() on them — so anything non-string must become "" here
 * rather than crash the command halfway through printing results.
 */
function str(v: any): string {
  return typeof v === "string" ? v : ""
}

/** Fall back to decoding a raw Gmail payload when no pre-parsed body is present. */
function decodePayload(m: any): string {
  const parts = m?.payload?.parts ?? []
  const textPart = parts.find((p: any) => p?.mimeType === "text/plain")
  if (textPart?.body?.data) return decodeBase64Url(textPart.body.data)
  if (m?.payload?.body?.data) return decodeBase64Url(m.payload.body.data)
  return ""
}

// ── Helpers ──

function decodeBase64Url(encoded: string): string {
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/")
    return Buffer.from(base64, "base64").toString("utf-8")
  } catch {
    return ""
  }
}
