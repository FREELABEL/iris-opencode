/**
 * Pulse (#189286) — the sidecar half of the desktop Pulse panel. Design: heyiris.io/p/pulse-panel-directions
 * (pick 01, "the route"). Two routes, never an account route (users have contacts, not accounts):
 *
 *   topic    `iris pulse check "keyword"` — the same PulseScript the CLI walks (./pulse/topic.ts,
 *            ported verbatim), one stop per source, in visit order.
 *   contact  `iris leads pulse <id>` — the lead's record, deal, tasks, checks and email log from
 *            fl-api, then the channels this app cannot read yet, SHUT with the command that does.
 *
 * OPENING NEVER WRITES. Every call here is a GET. The CLI's `pulse check` files its result in the
 * signal corpus by default and `leads pulse` used to rewrite a stored score; neither happens here.
 * `/readiness` without `?record=1` is a pure read since #189218; `/score` reports `saved: false`.
 *
 * Every stop carries a provenance word the panel shows as a mark:
 *   measured      read, and the number is the whole answer
 *   partial       read, but capped or only partly readable — the number is a floor
 *   not-kept      the source does not record it (a check that has not run since …)
 *   not-measured  could not look — shown SHUT with a reason, never as 0
 */
import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { irisFetch, resolveUserId } from "./platform"
import type { SourceSweep, SweepOptions, TopicSource, Hit } from "./pulse/sweep"

type Result<T> = { measured: boolean; reason?: string; data: T }

export type Provenance = "measured" | "partial" | "not-kept" | "not-measured"

export type PulseStop = {
  id: string
  label: string
  /** Where it was read from — the CLI command or the endpoint. */
  from?: string
  shut: boolean
  /** Why it is shut, or a caveat on how it was read. */
  reason: string | null
  provenance: Provenance
  /** The tally on the right of the stop. Null when shut — never 0 for "could not look". */
  count: number | null
  /** A capped count: show as N+. */
  floor: boolean
  /** Change against the window before, when the source can reconstruct it. */
  delta: number | null
  /** One plain sentence: what it picked up, what is owed, or why it could not get in. */
  text: string
  /** Owed things, flagged on the stop (an unpaid gate, an overdue task). */
  owed: number
  /** What a person would do about a shut stop, if anything. */
  fix?: { label: string; command?: string }
  items: Array<{ when?: string; where: string; text?: string }>
}

const BRIDGE_URL = process.env.IRIS_BRIDGE_URL ?? "http://127.0.0.1:3200"

/** The local bridge's key, from the file the CLI and the bridge share. Absent → the Mail stop says so. */
function bridgeKey(): string | undefined {
  try {
    const p = join(homedir(), ".iris", "bridge-token")
    return existsSync(p) ? readFileSync(p, "utf-8").trim() || undefined : undefined
  } catch {
    return undefined
  }
}

// ── topic ────────────────────────────────────────────────────────────────────

export const TOPIC_LABELS: Record<TopicSource, string> = {
  git: "Commits",
  diary: "Diary",
  files: "Files",
  claude_code: "Claude Code sessions",
  opencode: "opencode sessions",
  imessage: "iMessage",
  email: "Apple Mail",
  gmail: "Gmail",
  bloq: "Atlas",
}

const TOPIC_NOUN: Record<TopicSource, [string, string]> = {
  git: ["commit", "commits"],
  diary: ["diary entry", "diary entries"],
  files: ["file", "files"],
  claude_code: ["session", "sessions"],
  opencode: ["session", "sessions"],
  imessage: ["message", "messages"],
  email: ["email", "emails"],
  gmail: ["email", "emails"],
  bloq: ["item", "items"],
}

const plural = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`

/**
 * A reason as a sentence a person reads: an embedded JSON error body becomes its message, and it
 * starts with a capital so it can follow another sentence.
 */
export function cleanReason(r: string): string {
  const m = r.match(/^(.*?):?\s*\{.*?"(?:error|message)"\s*:\s*"([^"]+)".*\}\s*$/s)
  const out = (m ? `${m[1].trim()} — ${m[2]}` : r).trim()
  // "iMessage", "iCloud": a word that is meant to start lower-case keeps it.
  if (/^[a-z][A-Z]/.test(out)) return out
  return out.charAt(0).toUpperCase() + out.slice(1)
}

/** A sweep as a stop. Pure — the panel's shape is tested without a disk. */
export function topicStop(s: SourceSweep, fromOf: (id: TopicSource) => string): PulseStop {
  const label = TOPIC_LABELS[s.source] ?? s.source
  if (!s.searched) {
    const reason = cleanReason(s.unavailableReason ?? "could not look")
    return {
      id: s.source,
      label,
      from: fromOf(s.source),
      shut: true,
      reason,
      provenance: "not-measured",
      count: null,
      floor: false,
      delta: null,
      text: reason,
      owed: 0,
      fix: fixFor(s.source, reason),
      items: [],
    }
  }
  const floor = !!s.capped
  const delta = typeof s.hitsPrior === "number" && !floor ? s.hits - s.hitsPrior : null
  let text = `${floor ? "At least " : ""}${plural(s.hits, TOPIC_NOUN[s.source])} mention${s.hits === 1 ? "s" : ""} it.`
  if (s.board) text = `Board “${s.board.name}” — ${plural(s.hits, TOPIC_NOUN.bloq)}${s.board.silentLists.length ? `, ${s.board.silentLists.length} list${s.board.silentLists.length === 1 ? "" : "s"} gone quiet` : ""}.`
  if (delta !== null && delta !== 0) text += ` ${Math.abs(delta)} ${delta > 0 ? "more" : "fewer"} than the window before.`
  if (s.unavailableReason) text += ` ${cleanReason(s.unavailableReason)}`
  return {
    id: s.source,
    label,
    from: fromOf(s.source),
    shut: false,
    reason: s.unavailableReason ?? null,
    provenance: floor || s.unavailableReason ? "partial" : "measured",
    count: s.hits,
    floor,
    delta,
    text,
    owed: 0,
    items: (s.items ?? []).slice(0, 8).map((h: Hit) => ({ when: h.when, where: h.where, text: h.text })),
  }
}

function fixFor(source: TopicSource, reason: string): PulseStop["fix"] | undefined {
  if (/mac|darwin|chat\.db|Messages/i.test(reason) && (source === "imessage" || source === "email")) return { label: "Run this route on the Mac" }
  if (source === "gmail") return { label: "Run it in a terminal", command: "iris pulse check" }
  if (/sign|token|auth/i.test(reason)) return { label: "Sign in", command: "iris auth login" }
  return undefined
}

export type TopicSummary = {
  /** Sum over stops that were read. */
  hits: number
  /** True when any read stop was capped — the total is then a floor. */
  floor: boolean
  /** Stops that found something / stops that could be read / all stops. */
  withHits: number
  reachable: number
  total: number
  shut: number
  /** The window before, only when EVERY read, uncapped stop could reconstruct it. Else null. */
  prior: number | null
  /** Newest artefact across stops, epoch ms. */
  lastTouched: number | null
}

export function topicSummary(sweeps: SourceSweep[]): TopicSummary {
  const read = sweeps.filter((s) => s.searched)
  const priorKnown = read.length > 0 && read.every((s) => !s.capped && typeof s.hitsPrior === "number")
  const last = Math.max(...read.map((s) => s.lastHitEpoch ?? 0), 0)
  return {
    hits: read.reduce((n, s) => n + s.hits, 0),
    floor: read.some((s) => s.capped),
    withHits: read.filter((s) => s.hits > 0).length,
    reachable: read.length,
    total: sweeps.length,
    shut: sweeps.length - read.length,
    prior: priorKnown ? read.reduce((n, s) => n + (s.hitsPrior ?? 0), 0) : null,
    lastTouched: last > 0 ? (last < 1e12 ? last * 1000 : last) : null,
  }
}

export type TopicPulse = {
  keyword: string
  days: number
  repo: string
  ms: number
  summary: TopicSummary
  stops: PulseStop[]
}

export async function fetchPulseTopic(input: { keyword: string; days?: number; repo?: string }): Promise<Result<TopicPulse | null>> {
  const keyword = input.keyword.trim()
  if (!keyword) return { measured: false, reason: "name a topic to pulse", data: null }
  const days = Math.min(Math.max(Math.round(input.days ?? 30), 1), 365)
  const repo = input.repo ?? join(homedir(), "work")
  const { sweepAll, TOPIC_SOURCES, currentSessionIds } = await import("./pulse/sweep")
  const userId = await resolveUserId().catch(() => null)
  const opts: SweepOptions = {
    keyword,
    repo,
    windowDays: days,
    limit: 8,
    sources: [...TOPIC_SOURCES],
    bridgeUrl: BRIDGE_URL,
    bridgeKey: bridgeKey(),
    apiFetch: (p: string) => irisFetch(p),
    userId: userId ?? undefined,
    excludeSessions: currentSessionIds(),
  }
  const t0 = Date.now()
  try {
    const sweeps = await sweepAll(opts)
    const fromOf = (id: TopicSource) => `iris pulse check "${keyword}" --sources ${id}`
    return {
      measured: true,
      data: { keyword, days, repo, ms: Date.now() - t0, summary: topicSummary(sweeps), stops: sweeps.map((s) => topicStop(s, fromOf)) },
    }
  } catch (e) {
    return { measured: false, reason: `the route did not finish: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300), data: null }
  }
}

// ── contact ──────────────────────────────────────────────────────────────────

export type ContactRow = { id: number; name: string; company: string | null; status: string | null; email: string | null }

export async function fetchPulseContacts(q: string): Promise<Result<ContactRow[]>> {
  const p = new URLSearchParams({ per_page: "20" })
  if (q.trim()) p.set("search", q.trim())
  try {
    const res = await irisFetch(`/api/v1/leads?${p}`)
    if (!res.ok) return { measured: false, reason: `contacts: HTTP ${res.status}`, data: [] }
    const body = (await res.json()) as any
    const rows: any[] = Array.isArray(body?.data?.data) ? body.data.data : Array.isArray(body?.data) ? body.data : []
    return {
      measured: true,
      data: rows.map((l) => ({
        id: Number(l.id),
        name: String(l.name ?? l.nickname ?? `Contact ${l.id}`),
        company: l.company ?? l.contact_info?.company ?? null,
        status: l.status ?? null,
        email: l.email ?? l.contact_info?.email ?? null,
      })),
    }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: [] }
  }
}

type Got = { ok: true; body: any } | { ok: false; why: string }
async function get(path: string): Promise<Got> {
  try {
    const res = await irisFetch(path)
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` }
    return { ok: true, body: await res.json() }
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) }
  }
}

const DAY = 86_400_000
const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
const dateOf = (s: unknown): number => {
  const t = Date.parse(String(s ?? "").replace(" ", "T"))
  return Number.isFinite(t) ? t : NaN
}
const shortDate = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })

export type ContactScore = {
  score: number | null
  band: string | null
  previous: number | null
  /** Oldest → newest, for the sparkline. */
  history: Array<{ at: string; score: number }>
  /** Share of the score's declared weight that was actually measured, 0..1. */
  coverage: number | null
}

export type ContactPulse = {
  lead: ContactRow
  days: number
  ms: number
  score: ContactScore
  stops: PulseStop[]
  owed: Array<{ what: string; amount?: string; since?: string }>
  /** Channels read / channels on the route. */
  channels: { read: number; total: number }
}

/** The pieces fetched for one contact — injected so the shaping is testable without a network. */
export type ContactInputs = {
  lead: any
  activities: Got
  deal: Got
  tasks: Got
  checks: Got
  readiness: Got
  gmail: Got
}

const LOCAL_CHANNELS: Array<{ id: string; label: string; what: string }> = [
  { id: "imessage", label: "iMessage", what: "Their 1:1 and group chats" },
  { id: "whatsapp", label: "WhatsApp", what: "Their WhatsApp groups" },
  { id: "mail", label: "Apple Mail", what: "Their mail in Mail.app" },
  { id: "meetings", label: "Meetings", what: "the calendar" },
]

/** Pure: everything the contact route shows, from what was fetched. */
export function contactRoute(input: ContactInputs, opts: { days: number; now: number }): Omit<ContactPulse, "ms"> {
  const { now, days } = opts
  const l = input.lead
  const lead: ContactRow = {
    id: Number(l.id),
    name: String(l.name ?? l.nickname ?? `Contact ${l.id}`),
    company: l.company ?? l.contact_info?.company ?? null,
    status: l.status ?? null,
    email: l.email ?? l.contact_info?.email ?? null,
  }
  const stops: PulseStop[] = []
  const owed: ContactPulse["owed"] = []
  const shutStop = (id: string, label: string, from: string, why: string, fix?: PulseStop["fix"]): PulseStop => ({
    id, label, from, shut: true, reason: why, provenance: "not-measured", count: null, floor: false, delta: null, text: why, owed: 0, fix, items: [],
  })

  // 1 · lead record
  if (input.activities.ok) {
    const acts: any[] = Array.isArray(input.activities.body?.data) ? input.activities.body.data : []
    const newest = acts[0]
    const t = newest ? dateOf(newest.created_at) : NaN
    stops.push({
      id: "record",
      label: "Lead record",
      from: `/api/v1/leads/${lead.id}/activities`,
      shut: false,
      reason: acts.length >= 20 ? "only the 20 most recent are read" : null,
      provenance: acts.length >= 20 ? "partial" : "measured",
      count: acts.length,
      floor: acts.length >= 20,
      delta: null,
      text: acts.length
        ? `${acts.length >= 20 ? "20+" : acts.length} recent activities · last ${String(newest.activity_type ?? "an update").replace(/_/g, " ")}${Number.isFinite(t) ? `, ${shortDate(t)}` : ""}.`
        : "No activity on the record.",
      owed: 0,
      items: acts.slice(0, 8).map((a) => ({ when: a.created_at, where: String(a.activity_type ?? "").replace(/_/g, " "), text: String(a.content ?? "").slice(0, 160) })),
    })
  } else stops.push(shutStop("record", "Lead record", `/api/v1/leads/${lead.id}/activities`, `could not read the record (${input.activities.why})`))

  // 2 · deal
  if (input.deal.ok) {
    const d = input.deal.body?.data ?? {}
    if (!d.has_payment_gate) {
      stops.push({ id: "deal", label: "Deal", from: `/api/v1/leads/${lead.id}/deal-status`, shut: false, reason: null, provenance: "measured", count: null, floor: false, delta: null, text: "No payment gate on this contact.", owed: 0, items: [] })
    } else {
      const amount = Number(d.amount ?? 0)
      const per = d.billing_type === "monthly" ? "/mo" : ""
      const waiting = [!d.contract_signed && "contract unsigned", !d.payment_received && `${money(amount)}${per} unpaid`].filter(Boolean) as string[]
      const done = !!d.deal_complete || (!!d.contract_signed && !!d.payment_received)
      const since = dateOf(d.created_at)
      if (!done) owed.push({ what: waiting.length === 2 ? "Signed contract + first payment" : d.contract_signed ? "First payment" : "Signed contract", amount: `${money(amount)}${per}`, since: Number.isFinite(since) ? `${Math.round((now - since) / DAY)} d` : undefined })
      stops.push({
        id: "deal",
        label: "Deal",
        from: `/api/v1/leads/${lead.id}/deal-status`,
        shut: false,
        reason: null,
        provenance: "measured",
        count: amount,
        floor: false,
        delta: null,
        text: done
          ? `Signed and paid — ${money(Number(d.total_received ?? amount))} received.`
          : `Payment gate waiting on ${waiting.length === 2 ? "both" : "one"}: ${waiting.join(", ")}. ${d.reminders_sent ?? 0} of ${d.reminders_total ?? 0} reminders sent.`,
        owed: done ? 0 : 1,
        items: [],
      })
    }
  } else stops.push(shutStop("deal", "Deal", `/api/v1/leads/${lead.id}/deal-status`, `could not read the deal (${input.deal.why})`))

  // 3 · tasks
  if (input.tasks.ok) {
    const ts: any[] = Array.isArray(input.tasks.body?.data?.tasks) ? input.tasks.body.data.tasks : []
    const doneN = ts.filter((t) => t.is_completed).length
    const overdue = ts
      .filter((t) => !t.is_completed && Number.isFinite(dateOf(t.due_date)) && dateOf(t.due_date) < now)
      .sort((a, b) => dateOf(a.due_date) - dateOf(b.due_date))
    for (const t of overdue.slice(0, 3)) owed.push({ what: `Overdue: ${String(t.title).slice(0, 90)}`, since: `${Math.round((now - dateOf(t.due_date)) / DAY)} d` })
    const open = ts.length - doneN
    stops.push({
      id: "tasks",
      label: "Tasks",
      from: `/api/v1/leads/${lead.id}/tasks`,
      shut: false,
      reason: null,
      provenance: "measured",
      count: doneN,
      floor: false,
      delta: null,
      text: `${doneN} done · ${open} open${overdue.length ? ` · ${overdue.length} overdue since ${shortDate(dateOf(overdue[0].due_date))}` : ""}.`,
      owed: overdue.length,
      items: ts.filter((t) => !t.is_completed).slice(0, 8).map((t) => ({ when: t.due_date ?? undefined, where: String(t.title) })),
    })
  } else stops.push(shutStop("tasks", "Tasks", `/api/v1/leads/${lead.id}/tasks`, `could not read tasks (${input.tasks.why})`))

  // 4 · checks
  if (input.checks.ok) {
    const c = input.checks.body ?? {}
    const total = Number(c.total ?? 0)
    const last = dateOf(c.last_run)
    const stale = Number.isFinite(last) && now - last > 7 * DAY
    stops.push({
      id: "checks",
      label: "Checks",
      from: `/api/v1/leads/${lead.id}/requirements/summary`,
      shut: false,
      reason: null,
      provenance: !total ? "not-kept" : stale || !Number.isFinite(last) ? "not-kept" : "measured",
      count: total ? Number(c.passing ?? 0) : null,
      floor: false,
      delta: null,
      text: !total
        ? "No checks set up for this contact."
        : `${c.passing ?? 0} of ${total} passing${Number.isFinite(last) ? ` — as of the last run, ${shortDate(last)}` : " — never run"}.`,
      owed: Number(c.failing ?? 0),
      items: [],
    })
  } else stops.push(shutStop("checks", "Checks", `/api/v1/leads/${lead.id}/requirements/summary`, `could not read checks (${input.checks.why})`))

  // 5 · email log (server-side, scoped to the lead)
  let channelsRead = 0
  if (!lead.email) stops.push(shutStop("gmail", "Email log", `/api/v1/leads/${lead.id}/gmail-threads`, "The contact has no email address."))
  else if (input.gmail.ok) {
    channelsRead++
    const threads: any[] = Array.isArray(input.gmail.body?.threads) ? input.gmail.body.threads : Array.isArray(input.gmail.body?.data) ? input.gmail.body.data : []
    const cutoff = now - days * DAY
    const inWin = threads.filter((t) => dateOf(t.last_message_at ?? t.first_message_at) >= cutoff)
    const sent = inWin.reduce((n, t) => n + Number(t.sent_count ?? 0), 0)
    stops.push({
      id: "gmail",
      label: "Email log",
      from: `/api/v1/leads/${lead.id}/gmail-threads`,
      shut: false,
      reason: null,
      provenance: "measured",
      count: inWin.length,
      floor: false,
      delta: null,
      text: inWin.length ? `${inWin.length} thread${inWin.length === 1 ? "" : "s"} in ${days} days · ${sent} sent by you.` : `No email in ${days} days.`,
      owed: 0,
      items: inWin.slice(0, 8).map((t) => ({ when: t.last_message_at, where: String(t.latest_from ?? ""), text: String(t.latest_subject ?? t.latest_snippet ?? "").slice(0, 140) })),
    })
  } else stops.push(shutStop("gmail", "Email log", `/api/v1/leads/${lead.id}/gmail-threads`, `could not read the email log (${input.gmail.why})`))

  // 6-9 · channels this app does not read yet — SHUT, with the command that does
  for (const c of LOCAL_CHANNELS) {
    stops.push(
      shutStop(
        c.id,
        c.label,
        `iris leads pulse ${lead.id}`,
        c.id === "meetings"
          ? "The calendar is not read here, so this is not “no meetings” — it was not read."
          : `Not read by the desktop app yet. ${c.what} — read on the Mac by the CLI.`,
        { label: "Run it in a terminal", command: `iris leads pulse ${lead.id}` },
      ),
    )
  }

  // the score — read-only (#189218)
  let score: ContactScore = { score: null, band: null, previous: null, history: [], coverage: null }
  if (input.readiness.ok) {
    const r = input.readiness.body?.data ?? {}
    const hist: any[] = Array.isArray(r.history) ? r.history : []
    score = {
      score: typeof r.score === "number" ? r.score : null,
      band: r.band ?? null,
      previous: typeof r.previous_score === "number" ? r.previous_score : null,
      history: hist
        .map((h) => ({ at: String(h.created_at ?? ""), score: Number(h.score) }))
        .filter((h) => Number.isFinite(h.score))
        .reverse(),
      // fl-api reports the ratio as a percentage (92), not a fraction.
      coverage: typeof r.coverage?.ratio === "number" ? (r.coverage.ratio > 1 ? r.coverage.ratio / 100 : r.coverage.ratio) : null,
    }
  }

  return { lead, days, score, stops, owed, channels: { read: channelsRead, total: 1 + LOCAL_CHANNELS.length } }
}

export async function fetchPulseContact(id: number, days = 30): Promise<Result<ContactPulse | null>> {
  const t0 = Date.now()
  const lead = await get(`/api/v1/leads/${id}`)
  if (!lead.ok) return { measured: false, reason: `could not open contact ${id} (${lead.why})`, data: null }
  const [activities, deal, tasks, checks, readiness, gmail] = await Promise.all([
    get(`/api/v1/leads/${id}/activities?limit=20`),
    get(`/api/v1/leads/${id}/deal-status`),
    get(`/api/v1/leads/${id}/tasks`),
    get(`/api/v1/leads/${id}/requirements/summary`),
    get(`/api/v1/leads/${id}/readiness?include=history`),
    get(`/api/v1/leads/${id}/gmail-threads`),
  ])
  const route = contactRoute({ lead: lead.body?.data ?? lead.body, activities, deal, tasks, checks, readiness, gmail }, { days, now: Date.now() })
  return { measured: true, data: { ...route, ms: Date.now() - t0 } }
}
