/**
 * Slack Web API utility — thin wrapper for CLI message reading.
 *
 * Token flow: bot_token stored in fl-api integrations table,
 * fetched via irisFetch, then used directly against Slack API.
 *
 * Used by: platform-slack.ts, platform-atlas-comms.ts, platform-inbox.ts
 */

const SLACK_API = "https://slack.com/api"

// ── Types ──

export interface SlackChannel {
  id: string
  name: string
  is_private: boolean
  is_im: boolean
  is_mpim: boolean
  topic: string
  purpose: string
  num_members: number
  updated: number
}

export interface SlackMessage {
  ts: string
  text: string
  user: string
  username: string
  timestamp: string // ISO
  thread_ts?: string
  reply_count?: number
  attachments?: { fallback?: string }[]
}

export interface SlackUser {
  id: string
  name: string
  real_name: string
  display_name: string
  is_bot: boolean
  is_admin: boolean
}

// ── Token ──

let _cachedToken: string | null = null

export async function getToken(): Promise<string | null> {
  if (_cachedToken) return _cachedToken

  try {
    // Try fl-api integration credentials
    const { irisFetch } = await import("../cmd/iris-api")
    const res = await irisFetch("/api/v1/integrations/slack/credentials")
    if (res.ok) {
      const data = (await res.json()) as any
      const token = data?.data?.bot_token ?? data?.bot_token ?? data?.data?.access_token ?? null
      if (token) { _cachedToken = token; return token }
    }

    // Fallback: try env var
    if (process.env.SLACK_BOT_TOKEN) {
      _cachedToken = process.env.SLACK_BOT_TOKEN
      return _cachedToken
    }
  } catch {}

  return null
}

export function clearTokenCache(): void {
  _cachedToken = null
}

// ── API Calls ──

async function slackFetch(method: string, token: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${SLACK_API}/${method}`)
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v)
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) throw new Error(`Slack API ${method}: HTTP ${res.status}`)
  const data = await res.json()
  if (!data.ok) throw new Error(`Slack API ${method}: ${data.error || "unknown error"}`)
  return data
}

// ── Channels ──

export async function listChannels(token: string, limit = 100): Promise<SlackChannel[]> {
  const data = await slackFetch("conversations.list", token, {
    types: "public_channel,private_channel",
    exclude_archived: "true",
    limit: String(Math.min(limit, 1000)),
  })

  return (data.channels ?? []).map((ch: any) => ({
    id: ch.id,
    name: ch.name,
    is_private: ch.is_private ?? false,
    is_im: ch.is_im ?? false,
    is_mpim: ch.is_mpim ?? false,
    topic: ch.topic?.value || "",
    purpose: ch.purpose?.value || "",
    num_members: ch.num_members ?? 0,
    updated: ch.updated ?? 0,
  })) as SlackChannel[]
}

// ── Messages ──

export async function getMessages(token: string, channelId: string, limit = 50): Promise<SlackMessage[]> {
  const data = await slackFetch("conversations.history", token, {
    channel: channelId,
    limit: String(Math.min(limit, 200)),
  })

  // Build a user cache for display names
  const userIds = new Set<string>((data.messages ?? []).map((m: any) => m.user).filter(Boolean))
  const userMap = await resolveUsers(token, [...userIds])

  return (data.messages ?? []).map((m: any) => ({
    ts: m.ts,
    text: m.text || "",
    user: m.user || "",
    username: userMap.get(m.user) || m.username || m.user || "?",
    timestamp: tsToISO(m.ts),
    thread_ts: m.thread_ts,
    reply_count: m.reply_count,
    attachments: m.attachments,
  })) as SlackMessage[]
}

// ── Search ──

export async function searchMessages(token: string, query: string, limit = 20): Promise<SlackMessage[]> {
  try {
    const data = await slackFetch("search.messages", token, {
      query,
      count: String(Math.min(limit, 100)),
      sort: "timestamp",
      sort_dir: "desc",
    })

    const matches = data.messages?.matches ?? []
    return matches.map((m: any) => ({
      ts: m.ts,
      text: m.text || "",
      user: m.user || "",
      username: m.username || m.user || "?",
      timestamp: tsToISO(m.ts),
      thread_ts: m.thread_ts,
      reply_count: m.reply_count,
    })) as SlackMessage[]
  } catch (err: any) {
    // search.messages requires search:read scope — fall back to per-channel scan
    if (err.message?.includes("missing_scope") || err.message?.includes("not_allowed")) {
      return []
    }
    throw err
  }
}

// ── Users ──

export async function listUsers(token: string, limit = 200): Promise<SlackUser[]> {
  const data = await slackFetch("users.list", token, {
    limit: String(Math.min(limit, 1000)),
  })

  return (data.members ?? [])
    .filter((u: any) => !u.deleted)
    .map((u: any) => ({
      id: u.id,
      name: u.name,
      real_name: u.real_name || u.name,
      display_name: u.profile?.display_name || u.real_name || u.name,
      is_bot: u.is_bot ?? false,
      is_admin: u.is_admin ?? false,
    })) as SlackUser[]
}

// ── Helpers ──

function tsToISO(ts: string): string {
  if (!ts) return ""
  const secs = parseFloat(ts)
  if (isNaN(secs)) return ts
  return new Date(secs * 1000).toISOString()
}

async function resolveUsers(token: string, userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (userIds.length === 0) return map

  try {
    const data = await slackFetch("users.list", token, { limit: "500" })
    for (const u of data.members ?? []) {
      map.set(u.id, u.profile?.display_name || u.real_name || u.name || u.id)
    }
  } catch { /* user list might fail, display IDs instead */ }

  return map
}
