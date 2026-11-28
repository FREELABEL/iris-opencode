/**
 * Five panes read as records a person acts on (#194582): Integrations, Genesis Sites, MCP, Hive
 * Peers and Atlas Schemas. Each used to fall back to a raw key/value list and a copy-command; the
 * raw record now lives only in the JSON tab. Pure, so it is tested without a DOM: the words, the
 * status, and which facts are worth a line. The buttons are in iris-detail-panes.tsx.
 *
 * No internal ids in what a person reads — connection UUIDs, integration ids, board numbers stay
 * in JSON (or "Copy id").
 */
import type { StatusTone } from "@opencode-ai/ui/status-badge"

type T = (key: string, params?: Record<string, string>) => string

export type PaneFact = {
  label: string
  value?: string
  /** An ISO time: drawn relative ("5m ago"), exact on hover. */
  time?: string
  numeric?: boolean
  wide?: boolean
  /** Short words drawn as chips (what a peer may do). */
  chips?: string[]
}
export type PaneDetail = {
  title: string
  subtitle?: string
  badge?: { label: string; tone: StatusTone }
  facts: PaneFact[]
}

export const DETAIL_PANES = new Set(["integrations", "sites", "mcp", "peers", "schemas"])

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

// ── Integrations ──

export type IntegrationState = "connected" | "attention" | "untested" | "off"

/** One word for where a connection stands. A failing one is the row you opened the list to find. */
export function integrationState(r: any): IntegrationState {
  if (r?.status === "error" || text(r?.lastError)) return "attention"
  if (!r?.connected) return "off"
  if (r?.needsTesting === true) return "untested"
  return "connected"
}

export const INTEGRATION_TONE: Record<IntegrationState, StatusTone> = {
  connected: "success",
  attention: "critical",
  untested: "neutral",
  off: "neutral",
}

/**
 * Why it failed, in words a person can act on. The provider's own message is kept underneath
 * (it is what support asks for); this is the sentence on top. Unknown shapes pass through.
 */
export function plainIntegrationError(raw: string | undefined, t: T): string | undefined {
  const s = text(raw)
  if (!s) return undefined
  const e = s.toLowerCase()
  if (/invalid_grant|expired|revoked|unauthori[sz]ed|\b401\b|invalid[_ ]token|token.*(invalid|missing)|re-?auth/.test(e)) return t("iris.dv.int.why.expired")
  if (/forbidden|\b403\b|permission|scope|insufficient/.test(e)) return t("iris.dv.int.why.forbidden")
  if (/rate.?limit|too many requests|\b429\b|quota/.test(e)) return t("iris.dv.int.why.rateLimited")
  if (/timeout|timed out|econn|enotfound|network|\b50[0-9]\b|unavailable|bad gateway/.test(e)) return t("iris.dv.int.why.unreachable")
  return s
}

function integrationDetail(r: any, t: T): PaneDetail {
  const state = integrationState(r)
  const why = plainIntegrationError(r.lastError, t)
  const scope = r.scope === "project" ? t("iris.dv.int.scope.project") : r.scope === "organization" ? t("iris.dv.int.scope.organization") : r.scope === "user" ? t("iris.dv.int.scope.user") : undefined
  const provider = text(r.health?.state)
  return {
    title: String(r.name ?? ""),
    subtitle: text(r.account) ?? text(r.category),
    badge: { label: t(`iris.dv.int.state.${state}`), tone: INTEGRATION_TONE[state] },
    facts: [
      { label: t("iris.dv.int.why"), value: why, wide: true },
      // The provider's own words, only when the sentence above rephrased them.
      { label: t("iris.dv.int.details"), value: why && why !== text(r.lastError) ? text(r.lastError) : undefined, wide: true },
      { label: t("iris.dv.int.lastTested"), time: text(r.lastTested), value: r.lastTested ? undefined : t("iris.dv.int.neverTested") },
      { label: t("iris.dv.int.account"), value: text(r.account) },
      { label: t("iris.dv.int.sharedWith"), value: scope },
      {
        label: t("iris.dv.int.provider"),
        value: provider ? (provider === "operational" ? t("iris.dv.int.provider.up") : provider === "unknown" ? undefined : t("iris.dv.int.provider.other", { state: provider })) : undefined,
      },
      { label: t("iris.dv.int.actions"), value: count(r.functionsCount) ? String(r.functionsCount) : undefined, numeric: true },
    ],
  }
}

// ── Sites ──

/** Where the site lives: its home link when it has one, else its path. */
export function siteAddress(r: any): string | undefined {
  const home = Array.isArray(r?.navItems) ? r.navItems.find((n: any) => text(n?.url)) : undefined
  if (home) return String(home.url)
  return text(r?.slug) ? `/${r.slug}` : undefined
}

/** A link that opens in a browser, or nothing. A bare path is not one. */
export function siteOpenUrl(r: any): string | undefined {
  const a = siteAddress(r)
  return a && /^https?:\/\//.test(a) ? a : undefined
}

function siteDetail(r: any, t: T): PaneDetail {
  const live = r.status === "published"
  const pages = count(r.pagesCount) ?? 0
  return {
    title: String(r.name ?? ""),
    subtitle: text(r.description),
    badge: { label: live ? t("iris.sites.status.published") : r.status === "archived" ? t("iris.dv.site.archived") : t("iris.sites.status.draft"), tone: live ? "success" : "neutral" },
    facts: [
      { label: t("iris.dv.site.pages"), value: pages === 1 ? t("iris.dv.site.onePage") : t("iris.dv.site.pagesN", { count: String(pages) }), numeric: true },
      { label: t("iris.dv.site.address"), value: siteAddress(r) },
      { label: t("iris.dv.site.signIn"), value: r.requiresAuth ? t("iris.dv.site.signIn.yes") : t("iris.dv.site.signIn.no") },
      { label: t("iris.dv.site.edited"), time: text(r.updatedAt) },
    ],
  }
}

// ── MCP ──

export type McpState = "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration"
const MCP_TONE: Record<string, StatusTone> = { connected: "success", failed: "critical", needs_auth: "warning", needs_client_registration: "warning", disabled: "neutral" }

export function mcpStatusWord(status: string | undefined, t: T): { label: string; tone: StatusTone } {
  const s = MCP_TONE[status ?? ""] ? String(status) : "disabled"
  return { label: t(`iris.dv.mcp.state.${s}`), tone: MCP_TONE[s] }
}

/** The one line a row says: how many tools, or what went wrong. */
export function mcpRowLine(r: any, tools: number | undefined, t: T): string {
  if (text(r?.error)) return String(r.error)
  if (r?.status === "needs_auth") return t("iris.dv.mcp.line.needsAuth")
  if (r?.status === "connected") return tools == null ? t("iris.dv.mcp.line.connected") : tools === 1 ? t("iris.dv.mcp.tools.one") : t("iris.dv.mcp.tools.other", { count: String(tools) })
  return r?.type === "remote" ? t("iris.dv.mcp.kind.remote") : t("iris.dv.mcp.kind.local")
}

function mcpDetail(r: any, t: T, tools?: number): PaneDetail {
  return {
    title: String(r.name ?? ""),
    subtitle: r.type === "remote" ? t("iris.dv.mcp.kind.remote") : r.type === "local" ? t("iris.dv.mcp.kind.local") : undefined,
    badge: mcpStatusWord(r.status, t),
    facts: [
      { label: t("iris.dv.mcp.lastError"), value: text(r.error), wide: true },
      { label: t("iris.dv.mcp.tools"), value: tools == null ? undefined : String(tools), numeric: true },
      { label: r.type === "remote" ? t("iris.dv.mcp.address") : t("iris.dv.mcp.command"), value: text(r.target), wide: true },
      { label: t("iris.dv.mcp.startsWith"), value: r.enabled === false ? t("iris.dv.mcp.startsOff") : undefined },
    ],
  }
}

// ── Hive peers ──

/** What a peer may do, in words. Unknown permissions keep their own name. */
export function peerPermissionWords(perms: unknown, t: T): string[] {
  const known: Record<string, string> = {
    files: "iris.dv.peer.can.files",
    chat: "iris.dv.peer.can.chat",
    terminal: "iris.dv.peer.can.terminal",
    tasks: "iris.dv.peer.can.tasks",
    inference: "iris.dv.peer.can.inference",
  }
  return (Array.isArray(perms) ? perms : []).map((p) => (known[String(p)] ? t(known[String(p)]) : String(p)))
}

export function peerStatusWord(r: any, t: T): { label: string; tone: StatusTone } {
  if (r?.status === "active") return { label: t("iris.dv.peer.state.active"), tone: "success" }
  if (r?.status === "pending") return { label: t("iris.dv.peer.state.pending"), tone: "warning" }
  return { label: t("iris.dv.peer.state.ended"), tone: "neutral" }
}

/** The text "Copy invite" puts on the clipboard: what the other person does with the code. */
export function peerInviteText(r: any, t: T): string | undefined {
  const code = text(r?.inviteCode)
  return code ? t("iris.dv.peer.inviteText", { code }) : undefined
}

function peerDetail(r: any, t: T): PaneDetail {
  const pending = r.status === "pending"
  return {
    title: String(r.name ?? ""),
    subtitle: r.inviter ? t("iris.dv.peer.youInvited") : t("iris.dv.peer.theyInvited"),
    badge: peerStatusWord(r, t),
    facts: [
      { label: t("iris.dv.peer.canDo"), chips: peerPermissionWords(r.permissions, t), value: (r.permissions ?? []).length ? undefined : t("iris.dv.peer.nothingYet") },
      { label: t("iris.dv.peer.inviteCode"), value: pending ? text(r.inviteCode) : undefined },
      { label: pending ? t("iris.dv.peer.expires") : t("iris.dv.peer.accepted"), time: pending ? text(r.expiresAt) : text(r.acceptedAt) },
    ],
  }
}

// ── Schemas ──

export type SchemaFieldRow = { name: string; key: string; type: string; required: boolean; phi: boolean }

const TYPES = new Set(["string", "text", "number", "integer", "boolean", "date", "datetime", "email", "url", "phone", "select", "enum", "json", "array"])
/** A field type in words ("Yes / no", not "boolean"); an unknown type keeps its own name. */
export function fieldTypeWord(type: unknown, t: T): string {
  const s = String(type ?? "")
  return TYPES.has(s) ? t(`iris.dv.schema.type.${s}`) : s
}

export function schemaFieldRows(r: any, t: T): SchemaFieldRow[] {
  return (Array.isArray(r?.fields) ? r.fields : []).map((f: any) => ({
    name: String(f.label || f.key),
    key: String(f.key),
    type: fieldTypeWord(f.type, t),
    required: f.required === true,
    phi: f.visibility === "phi",
  }))
}

/** "1,240 records" or nothing (an unmeasured count is never a zero). */
export function schemaRecordWords(r: any, t: T): string | undefined {
  const n = count(r?.recordCount)
  if (n == null) return undefined
  return n === 1 ? t("iris.dv.schema.records.one") : t("iris.dv.schema.records.other", { count: n.toLocaleString("en-US") })
}

function schemaDetail(r: any, t: T): PaneDetail {
  const fields = schemaFieldRows(r, t)
  return {
    title: String(r.name ?? ""),
    subtitle: r.scope === "account" ? t("iris.dv.schema.scope.account") : t("iris.dv.schema.scope.board"),
    badge: r.isSystem ? { label: t("iris.dv.schema.system"), tone: "info" } : undefined,
    facts: [
      { label: t("iris.dv.schema.recordsLabel"), value: count(r.recordCount) != null ? Number(r.recordCount).toLocaleString("en-US") : undefined, numeric: true },
      { label: t("iris.dv.schema.fieldsLabel"), value: String(fields.length), numeric: true },
      { label: t("iris.dv.schema.namedBy"), value: fields.find((f) => f.key === r.displayField)?.name },
      { label: t("iris.dv.schema.updated"), time: text(r.updatedAt) },
    ],
  }
}

export function paneDetail(pane: string, r: any, t: T, extra: { tools?: number } = {}): PaneDetail | undefined {
  if (!r) return undefined
  if (pane === "integrations") return integrationDetail(r, t)
  if (pane === "sites") return siteDetail(r, t)
  if (pane === "mcp") return mcpDetail(r, t, extra.tools)
  if (pane === "peers") return peerDetail(r, t)
  if (pane === "schemas") return schemaDetail(r, t)
  return undefined
}
