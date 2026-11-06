/**
 * The pure half of Agents › Agents (#192619): ELON's agents gallery (AITeamPanel + BaseAgentCard,
 * fl-elon-web-ui 3585291) as rules the Desktop card and toolbar read. Kept word-for-word where
 * ELON words it, so the two products describe one agent the same way.
 *
 * One view replaces All / Scheduled / On demand / Live: ELON filters by kind (All · People ·
 * Agents), workspace and sort, and an agent's live state opens from its card.
 */

export type GalleryAgent = {
  id: number
  name: string
  status?: string
  model?: string
  heartbeat?: boolean
  schedule?: string
  description?: string
  active?: boolean
  createdAt?: string
  type?: string
  isHuman?: boolean
  isVirtual?: boolean
  email?: string
  linkedUserId?: number
  workspaceId?: number
  workspaceMatch?: string
  lastUsedAt?: string
  files?: number
  flags?: string[]
  functions?: string[]
  integrations?: string[]
}

export type KindFilter = "all" | "human" | "ai"
export type WorkspaceFilter = "all" | "synced" | "orphaned"
export type SortKey = "last_opened_desc" | "created_at_desc" | "name_asc"

export const SORTS: { value: SortKey; label: string }[] = [
  { value: "last_opened_desc", label: "Recent" },
  { value: "created_at_desc", label: "Newest" },
  { value: "name_asc", label: "A-Z" },
]
export const WORKSPACES: { value: WorkspaceFilter; label: string }[] = [
  { value: "all", label: "All Workspaces" },
  { value: "synced", label: "Google-synced" },
  { value: "orphaned", label: "No workspace" },
]

const isHuman = (a: GalleryAgent) => a.isHuman === true

/** AITeamPanel filteredAgents: search, kind, workspace, then sort. */
export function galleryAgents(
  agents: readonly GalleryAgent[],
  f: { query?: string; kind: KindFilter; workspace: WorkspaceFilter; sort: SortKey; lastOpened: Record<string, string> },
): GalleryAgent[] {
  const q = (f.query ?? "").trim().toLowerCase()
  let out = agents.filter((a) => {
    if (q && ![a.name, a.description, ...capabilities(a)].some((s) => (s ?? "").toLowerCase().includes(q))) return false
    if (f.kind === "ai" && (isHuman(a) || a.isVirtual)) return false
    if (f.kind === "human" && !(isHuman(a) || a.linkedUserId)) return false
    if (f.workspace === "synced" && a.workspaceMatch !== "matched") return false
    if (f.workspace === "orphaned" && (a.workspaceId || a.isVirtual)) return false
    return true
  })
  const time = (v: string | undefined) => (v ? new Date(v).getTime() || 0 : 0)
  out = [...out].sort((a, b) => {
    if (f.sort === "name_asc") return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    if (f.sort === "created_at_desc") return time(b.createdAt) - time(a.createdAt)
    return time(f.lastOpened[String(b.id)]) - time(f.lastOpened[String(a.id)])
  })
  return out
}

// ── the card (BaseAgentCard) ───────────────────────────────────────────────────────────────

export type Theme = "yellow" | "blue" | "green" | "purple" | "red" | "gray" | "pink" | "orange"

const TYPE_THEMES: Record<string, Theme> = {
  human: "gray",
  chat: "blue",
  content: "orange",
  automation: "purple",
  social: "green",
  research: "pink",
  support: "blue",
  AI: "yellow",
}

export function theme(a: GalleryAgent): Theme {
  if (isHuman(a)) return "gray"
  return TYPE_THEMES[a.type || "AI"] ?? "yellow"
}

export type IconName = "user" | "robot" | "pen" | "share" | "brain" | "headset"

export function icon(a: GalleryAgent): IconName {
  if (isHuman(a)) return "user"
  const byType: Record<string, IconName> = { chat: "robot", content: "pen", automation: "robot", social: "share", research: "brain", support: "headset" }
  return byType[a.type || "AI"] ?? "robot"
}

export const typeLabel = (a: GalleryAgent) => (isHuman(a) ? "Human" : "AI")
export const iconTooltip = (a: GalleryAgent) => (isHuman(a) ? "Human Team Member" : "AI Agent")

const MODEL_NAMES: Record<string, string> = {
  gpt4o: "GPT-4o",
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o Mini",
  "gpt-4o-mini-2024-07-18": "GPT-4o Mini",
  "gpt-4-turbo": "GPT-4 Turbo",
  "gpt-4": "GPT-4",
  "gpt-3.5-turbo": "GPT-3.5",
  "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
  "claude-3-5-sonnet": "Claude 3.5 Sonnet",
  "claude-3-sonnet": "Claude 3 Sonnet",
  "claude-3-haiku": "Claude 3 Haiku",
  "claude-3-opus": "Claude 3 Opus",
  "gemini-pro": "Gemini Pro",
  "gemini-1.5-pro": "Gemini 1.5 Pro",
  "gemini-1.5-flash": "Gemini 1.5 Flash",
  "llama-3.1-405b": "Llama 3.1 405B",
  "llama-3.1-70b": "Llama 3.1 70B",
  "llama-3.1-8b": "Llama 3.1 8B",
  "mistral-large": "Mistral Large",
  "mistral-medium": "Mistral Medium",
  "mistral-small": "Mistral Small",
  "deepseek/deepseek-r1-0528-qwen3-8b:free": "DeepSeek R1",
  "openai/gpt-oss-20b:free": "GPT OSS 20B",
  "qwen/qwen3-30b-a3b:free": "Qwen3 30B",
}

const titleCase = (s: string) => s.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())

/** The model an AI agent runs on; ELON's fallback when none is set is gpt-4o-mini. Humans have none. */
export function model(a: GalleryAgent): string | null {
  if (isHuman(a)) return null
  return a.model || "gpt-4o-mini"
}

export function modelName(a: GalleryAgent): string {
  const m = model(a)
  if (!m) return ""
  if (MODEL_NAMES[m]) return MODEL_NAMES[m]
  if (m.includes("/")) return titleCase(m.split("/").pop()!.replace(/:free$/, ""))
  return titleCase(m)
}

const INTEGRATION_NAMES: Record<string, string> = {
  gmail: "Gmail",
  "google-drive": "Google Drive",
  "google-calendar": "Google Calendar",
  slack: "Slack",
  github: "GitHub",
  trello: "Trello",
  discord: "Discord",
  mailjet: "Mailjet",
  bloq_memory: "Memory",
  "case-reviewer": "Case Reviewer",
  vector_search: "Vector Search",
  template_engine: "Templates",
  document_processing: "Documents",
  searchNews: "News Search",
  searchPlaces: "Places",
  executeWebSearch: "Web Search",
  searchShoppingProducts: "Shopping",
  mapWebsite: "Website Mapping",
  scrapeWebPage: "Web Scraping",
  manageLeads: "Lead Management",
  manageBloqItems: "Content Management",
  searchMarketplace: "Marketplace",
  "servis-ai": "Servis AI",
  servis: "Servis AI",
}

export const integrationName = (key: string) =>
  INTEGRATION_NAMES[key] ?? key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())

const has = (a: GalleryAgent, flag: string) => (a.flags ?? []).includes(flag)

/** generateCapabilities: functions, then flags, then up to three integrations. */
export function capabilities(a: GalleryAgent): string[] {
  const out = [...(a.functions ?? [])]
  if (has(a, "webAccess")) out.push("Web Search")
  if (has(a, "canCreateContent")) out.push("Content Creation")
  if (has(a, "useKnowledgeBase")) out.push("Knowledge Base")
  if (has(a, "functionCalling")) out.push("API Integration")
  if (has(a, "memoryPersistence")) out.push("Memory & Context")
  if (has(a, "pipeline_flow")) out.push("Workflow Integration")
  if (has(a, "writing_styles")) out.push("Multi-Style Writing")
  out.push(...(a.integrations ?? []).map(integrationName).slice(0, 3))
  return [...new Set(out)]
}

export type Chip = { name: string; icon: "plug" | "globe" | "book" | "tasks" | "pen" | "code" | "brain" | "chart" }

/** generateIntegrations: each enabled integration, then the capability flags, all "connected". */
export function integrationChips(a: GalleryAgent): Chip[] {
  const out: Chip[] = (a.integrations ?? []).map((k) => ({ name: integrationName(k), icon: "plug" }))
  const flags: [string, string, Chip["icon"]][] = [
    ["webAccess", "Web Access", "globe"],
    ["useKnowledgeBase", "Knowledge Base", "book"],
    ["canManageTasks", "Task Management", "tasks"],
    ["canCreateContent", "Content Creation", "pen"],
    ["functionCalling", "API Functions", "code"],
    ["memoryPersistence", "Memory", "brain"],
    ["canAnalyzeData", "Data Analysis", "chart"],
  ]
  for (const [flag, name, ic] of flags) if (has(a, flag)) out.push({ name, icon: ic })
  return out
}

const TYPE_DESCRIPTIONS: Record<string, string> = {
  chat: "Conversational AI assistant for general tasks and communication",
  content: "Content creation and writing specialist",
  automation: "Workflow automation and process management",
  social: "Social media management and content curation",
  research: "Research and data analysis specialist",
  support: "Customer support and assistance specialist",
}

/** The agent's description, or generateDescription's sentence when it has none. */
export function description(a: GalleryAgent): string {
  if (a.description) return a.description
  const type = a.type || "AI"
  if (isHuman(a)) return `Human team member specializing in ${type === "human" ? "collaboration and oversight" : type}`
  const caps = capabilities(a)
  if (caps.length) return `AI assistant specialized in ${caps.slice(0, 2).join(" and ").toLowerCase()}`
  return TYPE_DESCRIPTIONS[type] ?? "AI assistant for various tasks"
}

/** formatTimeAgo, and "Never used" when the agent never ran. */
export function lastActivity(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "Never used"
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return "Never used"
  const s = Math.floor((now - t) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 2592000) return `${Math.floor(s / 86400)}d ago`
  return `${Math.floor(s / 2592000)}mo ago`
}

/** ELON shows "More" once an agent has more capabilities than this. */
export const MAX_VISIBLE_CONFIG = 6

// ── "Recent" = last opened here (ELON keeps agent_last_opened_{bloqId} in localStorage) ─────

const OPENED_KEY = "iris.agents.lastOpened"

export function readLastOpened(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(OPENED_KEY) ?? "{}")
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}

export function markOpened(id: number, now = new Date()): Record<string, string> {
  const next = { ...readLastOpened(), [String(id)]: now.toISOString() }
  try {
    localStorage.setItem(OPENED_KEY, JSON.stringify(next))
  } catch {}
  return next
}

/** ELON's own chat page for the agent (its card's "Open public chat"). */
export const chatUrl = (id: number) => `https://web.heyiris.io/agent/simple/${id}`
