/**
 * Gmail API utility — uses OAuth token from fl-api integrations table.
 *
 * Token flow: user connects Gmail via iris channels connect gmail (or fl-api OAuth),
 * token stored in integrations table, fetched via irisFetch, then calls Gmail API directly.
 *
 * Used by: platform-gmail.ts, platform-atlas-comms.ts, platform-inbox.ts
 */

const GMAIL_API = "https://www.googleapis.com/gmail/v1"

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

// ── Token ──

let _cachedToken: string | null = null

export async function getToken(): Promise<string | null> {
  if (_cachedToken) return _cachedToken

  try {
    const { irisFetch } = await import("../cmd/iris-api")

    // Try the integration credentials endpoint
    const res = await irisFetch("/api/v1/integrations/gmail/credentials")
    if (res.ok) {
      const data = (await res.json()) as any
      const token = data?.data?.access_token ?? data?.access_token ?? data?.data?.token ?? null
      if (token) { _cachedToken = token; return token }
    }

    // Fallback: try Google integration
    const res2 = await irisFetch("/api/v1/integrations/google/credentials")
    if (res2.ok) {
      const data = (await res2.json()) as any
      const token = data?.data?.access_token ?? data?.access_token ?? null
      if (token) { _cachedToken = token; return token }
    }
  } catch {}

  return null
}

export function clearTokenCache(): void {
  _cachedToken = null
}

// ── API Calls ──

async function gmailFetch(path: string, token: string): Promise<any> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  })

  if (res.status === 401) {
    clearTokenCache()
    throw new Error("Gmail token expired. Reconnect: iris channels connect gmail")
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any
    throw new Error(err?.error?.message || `Gmail API: HTTP ${res.status}`)
  }
  return res.json()
}

// ── Labels ──

export async function getLabels(token: string): Promise<GmailLabel[]> {
  const data = await gmailFetch("/users/me/labels", token)
  return (data.labels ?? []).map((l: any) => ({
    id: l.id,
    name: l.name,
    type: l.type,
    messages_total: l.messagesTotal ?? 0,
    messages_unread: l.messagesUnread ?? 0,
  })) as GmailLabel[]
}

// ── Messages ──

export async function listMessages(token: string, query = "", limit = 20): Promise<GmailMessage[]> {
  const q = encodeURIComponent(query || "in:inbox")
  const data = await gmailFetch(`/users/me/messages?q=${q}&maxResults=${Math.min(limit, 100)}`, token)
  const messageIds = (data.messages ?? []).map((m: any) => m.id)

  if (messageIds.length === 0) return []

  // Fetch full message details in parallel (batch of up to 20)
  const messages: GmailMessage[] = []
  for (const id of messageIds.slice(0, limit)) {
    try {
      const msg = await getMessageById(token, id)
      if (msg) messages.push(msg)
    } catch { /* skip individual failures */ }
  }

  return messages
}

export async function getMessageById(token: string, messageId: string): Promise<GmailMessage | null> {
  try {
    const data = await gmailFetch(`/users/me/messages/${messageId}?format=full`, token)
    return parseMessage(data)
  } catch {
    return null
  }
}

export async function searchMessages(token: string, query: string, limit = 20): Promise<GmailMessage[]> {
  return listMessages(token, query, limit)
}

// ── Threads ──

export async function getThread(token: string, threadId: string): Promise<GmailThread | null> {
  try {
    const data = await gmailFetch(`/users/me/threads/${threadId}?format=full`, token)
    const messages = (data.messages ?? []).map(parseMessage).filter(Boolean) as GmailMessage[]
    return {
      id: data.id,
      snippet: data.snippet || "",
      messages,
    }
  } catch {
    return null
  }
}

// ── Helpers ──

function parseMessage(data: any): GmailMessage | null {
  if (!data) return null

  const headers = data.payload?.headers ?? []
  const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || ""

  // Extract body text
  let bodyText = ""
  const parts = data.payload?.parts ?? []
  if (parts.length > 0) {
    const textPart = parts.find((p: any) => p.mimeType === "text/plain")
    if (textPart?.body?.data) {
      bodyText = decodeBase64Url(textPart.body.data)
    }
  } else if (data.payload?.body?.data) {
    bodyText = decodeBase64Url(data.payload.body.data)
  }

  return {
    id: data.id,
    thread_id: data.threadId,
    from: getHeader("From"),
    to: getHeader("To"),
    subject: getHeader("Subject"),
    date: getHeader("Date"),
    snippet: data.snippet || "",
    body_text: bodyText,
    labels: data.labelIds ?? [],
    is_unread: (data.labelIds ?? []).includes("UNREAD"),
  }
}

function decodeBase64Url(encoded: string): string {
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/")
    return Buffer.from(base64, "base64").toString("utf-8")
  } catch {
    return ""
  }
}
