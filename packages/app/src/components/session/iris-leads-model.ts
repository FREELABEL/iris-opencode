import { relativeTime as relativeWords } from "@opencode-ai/ui/relative-time"
/** Desktop Leads (#190553): ELON's rules for reading a lead, with no I/O. Reference: BloqLeadsTab.vue, leadUrgency.js. */
export type LeadTag = { id: number; name: string; color?: string | null }
export type LeadNote = { id: number; content: string; type?: string; activity_type?: string; is_system_generated?: boolean; created_at: string }
export type LeadTask = { id: number; title?: string; description?: string; status?: string; is_completed?: boolean; completed_at?: string | null; due_date?: string | null }
export type LeadRow = {
  id: number
  name?: string | null
  nickname?: string | null
  company?: string | null
  email?: string | null
  phone?: string | null
  website?: string | null
  status?: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  source?: string | null
  price_bid?: string | number | null
  has_replied?: number | boolean
  has_user_account?: boolean
  updated_at?: string | null
  created_at?: string | null
  note_count?: number
  notes_count?: number
  tasks_count?: number
  outreach_total_count?: number
  outreach_completed_count?: number
  tags?: LeadTag[]
  notes?: LeadNote[]
}

export const displayName = (l: LeadRow) => l.nickname || l.name || l.company || l.email || `Lead #${l.id}`

export const initials = (l: LeadRow) =>
  displayName(l)
    .split(/\s+/)
    // "@socialmediamaby" is S, not "?": the first letter or digit of each word, past any @ or #.
    .map((w) => w.match(/[\p{L}\p{N}]/u)?.[0])
    .filter((c): c is string => !!c)
    .slice(0, 2)
    .map((c) => c.toUpperCase())
    .join("") || "?"

const STATUS_COLOR: [RegExp, string][] = [
  [/^(new|lead|prospected)/, "#3498DB"],
  [/^contacted/, "#F1C40F"],
  [/^qualified/, "#2ECC71"],
  [/^(proposal|negotiation)/, "#9B59B6"],
  [/^(won|closed)/, "#27AE60"],
  [/^lost/, "#E74C3C"],
  [/^(inactive|on hold|stale)/, "#95A5A6"],
]

export function statusColor(status: string | null | undefined): string {
  const s = (status ?? "").toLowerCase()
  return STATUS_COLOR.find(([re]) => re.test(s))?.[1] ?? "#95A5A6"
}

export type Urgency = { label: "Fresh" | "Follow Up" | "Urgent" | "Critical"; color: string }

/** ELON's bands, by hours since anything happened on the lead. */
export function urgencyOf(updatedAt: string | null | undefined, now = Date.now()): Urgency | null {
  if (!updatedAt) return null
  const t = new Date(updatedAt).getTime()
  if (Number.isNaN(t)) return null
  const hours = (now - t) / 3_600_000
  if (hours < 24) return { label: "Fresh", color: "#10B981" }
  if (hours < 48) return { label: "Follow Up", color: "#F59E0B" }
  if (hours < 72) return { label: "Urgent", color: "#EF4444" }
  return { label: "Critical", color: "#EF4444" }
}

export function agoLine(iso: string | null | undefined, now = Date.now()): string {
  // The one rule (#194581): just now · 5m ago · yesterday · Nov 3. Under a minute is "just now" (#194506).
  return relativeWords(iso, now)
}

export function humanDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })
}

export function moneyLine(v: string | number | null | undefined): string {
  const n = Number(v)
  return v == null || v === "" || !Number.isFinite(n) || n === 0 ? "" : `$${n.toLocaleString()}`
}

export const noteCount = (l: LeadRow) => l.note_count ?? l.notes_count ?? 0
export const noteTotal = (l: LeadRow) => l.notes?.length ?? noteCount(l)

/** A person's words first: "Attached to board" is history, not a follow-up note. */
export const peopleNotes = (notes: LeadNote[] = []) => notes.filter((n) => !n.is_system_generated)
export const systemNotes = (notes: LeadNote[] = []) => notes.filter((n) => n.is_system_generated)

/**
 * What opening a lead shows first (#194358): the deal value and the newest note a person wrote.
 * The detail opened on company, email and city; a $40,000 lead's value sat fourth in an input and
 * its notes behind a tab. Empty when the lead has neither, so nothing renders as "$0" or "—".
 */
export function leadSummary(l: Pick<LeadRow, "price_bid" | "notes">, max = 200): { value?: string; note?: { text: string; at?: string } } {
  const value = moneyLine(l.price_bid) || undefined
  const newest = [...peopleNotes(l.notes ?? [])]
    .filter((n) => String(n.content ?? "").trim())
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0]
  const text = newest ? String(newest.content).replace(/\\n/g, "\n").trim() : ""
  return {
    ...(value ? { value } : {}),
    ...(text ? { note: { text: text.length > max ? text.slice(0, max - 1) + "…" : text, at: newest!.created_at ?? undefined } } : {}),
  }
}

export const isDone = (t: LeadTask) => t.is_completed === true || t.status === "completed" || t.status === "done" || !!t.completed_at

/** Build the list query as ELON sends it. Empty filters are left out, not sent blank. */
export function listQuery(f: { bloqId?: number; search: string; status: string; sort: string; order: string; page: number }): Record<string, string> {
  const q: Record<string, string> = { page: String(f.page), per_page: "50", sort: f.sort, order: f.order }
  if (f.bloqId !== undefined) q.bloq_id = String(f.bloqId)
  if (f.search.trim()) q.search = f.search.trim()
  if (f.status) q.status = f.status
  return q
}

/** fl-api answers the list in several shapes. `users/{id}/leads` sends Laravel's paginator at the top level. */
export function readList(j: any): { rows: LeadRow[]; total: number; lastPage: number } {
  const d = j?.data
  const rows: LeadRow[] = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : []
  const meta = j?.meta ?? (Array.isArray(d) ? j : d)
  return { rows, total: Number(meta?.total ?? rows.length), lastPage: Number(meta?.last_page ?? 1) }
}
