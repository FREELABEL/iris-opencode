/**
 * A lead or an agent opened from the side panel, read as a record a person acts on (#194363) —
 * not "score 0 · hot no · type unknown · consecutive failures 0 · created 2026-11-26T16:54:54Z".
 * Internal fields (ids, scores, flags) are left out; dates are said the way people say them; a
 * zero that means "nothing wrong" is not shown. Pure, so it is tested without a DOM.
 */
import type { StatusTone } from "@opencode-ai/ui/status-badge"
import { stageTone } from "./iris-leads-list-model"

export type RecordFact = { label: string; value?: string; numeric?: boolean; wide?: boolean }
export type RecordDetail = {
  title: string
  subtitle?: string
  badge?: { label: string; tone: StatusTone }
  facts: RecordFact[]
}
type T = (key: string, params?: Record<string, string>) => string

/** "Today, 9:54", "Yesterday, 14:02", "Nov 3", "Nov 3, 2025". */
export function friendlyDate(iso: string | undefined | null, now = new Date()): string | undefined {
  if (!iso) return undefined
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return undefined
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\u202f/g, " ")
  if (diff === 0) return `Today, ${time}`
  if (diff === 1) return `Yesterday, ${time}`
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  })
}

const money = (n: unknown) => (typeof n === "number" && n > 0 ? `$${n.toLocaleString("en-US")}` : undefined)
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)

export function recordDetail(pane: string, r: any, t: T, now = new Date()): RecordDetail | undefined {
  if (!r) return undefined
  if (pane === "leads") {
    const where = [text(r.city), text(r.country)].filter(Boolean).join(", ")
    const note = r.latestNote?.text
      ? `${r.latestNote.text}${r.latestNote.createdAt ? ` — ${friendlyDate(r.latestNote.createdAt, now)}` : ""}`
      : undefined
    return {
      title: String(r.name ?? ""),
      subtitle: text(r.company),
      badge: text(r.status) ? { label: r.status, tone: stageTone(r.status) } : undefined,
      facts: [
        { label: t("iris.detail.value"), value: money(r.bid), numeric: true },
        { label: t("iris.detail.latestNote"), value: note, wide: true },
        { label: t("iris.detail.company"), value: text(r.company) },
        { label: t("iris.detail.email"), value: text(r.email) },
        { label: t("iris.detail.location"), value: where || undefined },
        { label: t("iris.detail.notes"), value: r.noteCount ? String(r.noteCount) : undefined, numeric: true },
        { label: t("iris.detail.added"), value: friendlyDate(r.createdAt, now) },
      ],
    }
  }
  if (pane === "agents") {
    const healthy = r.status === "healthy" || r.status === "idle"
    const paused = r.active === false
    return {
      title: String(r.name ?? ""),
      subtitle: text(r.model),
      badge: paused
        ? { label: t("iris.detail.paused"), tone: "neutral" }
        : text(r.status)
          ? { label: cap(r.status), tone: healthy ? "success" : r.status === "failing" || r.status === "error" ? "critical" : "warning" }
          : undefined,
      facts: [
        { label: t("iris.detail.description"), value: text(r.description), wide: true },
        {
          label: t("iris.detail.runs"),
          value: r.heartbeat ? t("iris.detail.onSchedule", { schedule: text(r.schedule) ?? "heartbeat" }) : t("iris.detail.onDemand"),
        },
        { label: t("iris.detail.lastRun"), value: friendlyDate(r.lastRun, now) },
        // Zero failures in a row is the normal state, not a fact worth a line.
        { label: t("iris.detail.failures"), value: typeof r.failures === "number" && r.failures > 0 ? String(r.failures) : undefined, numeric: true },
        { label: t("iris.detail.added"), value: friendlyDate(r.createdAt, now) },
      ],
    }
  }
  return undefined
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
