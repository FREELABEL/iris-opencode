/**
 * First-run onboarding, engine half (D4 #188245, EPIC #188210).
 *
 * Screen 2, "Here's what I see": read the person's recent mail through the integration they just
 * connected, ground IRIS on it, and ask ONE question whose answers come from what was found. The
 * inbox is the description of their business — nobody is asked to type one.
 *
 *   state()   signed in? mail connected? already activated?   (decides whether to show onboarding)
 *   mail()    recent inbox threads, via iris-api execute-direct — the first real data pull, which is
 *             also what stamps users.activated_at server-side (T1 #188211)
 *   ground()  workflow-generation/business-summary on a compact digest of those threads
 *
 * Every function returns a PlatformResult: `measured: false` with a reason is a real answer the UI
 * can show ("couldn't read your mail: …"), never an exception that leaves a spinner turning.
 */
import { mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { IRIS_API, irisFetch, resolveUserId, tokenSource, type PlatformResult } from "./platform"

/** Mail providers in the order we prefer them. Outlook arrives with D2 #188248. */
const MAIL_TYPES = ["gmail", "outlook"] as const

export interface OnboardingState {
  signedIn: boolean
  mail: { connected: boolean; type?: string; account?: string }
  /** Every active connection's type (gmail, slack, stripe…). First run moves on after ANY one. */
  connected?: string[]
}

export interface MailThread {
  id: string
  threadId?: string
  subject: string
  from: string
  date?: string
  snippet: string
  unread?: boolean
  /** Not from a person: newsletters, notifications, reports, alerts. */
  automated?: boolean
  /**
   * person — someone is waiting on a reply.
   * action — automated, but asks the reader to DO something (security alert, receipt required,
   *          failed payment, verify). Measured on the first real inbox: 2 of 10 were these, and
   *          filing them with newsletters hid the only things that needed attention.
   * fyi    — reports, newsletters, promotions, social.
   */
  kind?: "person" | "action" | "fyi"
  /** Recipient, used to infer the account when the provider does not report one. */
  to?: string
}

const ACTION_REQUIRED =
  /\b(action (is )?required|requires? (a |your )?\w*|verify|verification|confirm your|unrecognized|new (sign[- ]?in|device|login)|security alert|suspicious|password|failed|declined|overdue|past due|expir(es|ing|ed)|suspend|unpaid|payment (due|failed)|receipt required|reset)\b/i

export function classify(t: { from: string; subject: string; snippet: string; automated?: boolean }): "person" | "action" | "fyi" {
  if (!t.automated) return "person"
  return ACTION_REQUIRED.test(`${t.subject} ${t.snippet.slice(0, 200)}`) ? "action" : "fyi"
}

/** Gmail's own sorting, when the provider passes labels through. */
const AUTOMATED_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"]
/**
 * The sender says it out loud: nobody reads replies to these. Deliberately NOT info@, billing@,
 * support@, hello@: a supplier chasing an overdue invoice from billing@ is exactly what is
 * waiting on a small business.
 */
const AUTOMATED_FROM = /(no-?reply|do-?not-?reply|notifications?|newsletter|mailer|updates?|digest|alerts?|news|marketing|receipts?)@|@(e|em|email|mail|mailer|news|marketing)\./i

export function isAutomated(from: string, labels: string[] = [], subject = ""): boolean {
  if (labels.some((l) => AUTOMATED_LABELS.includes(l))) return true
  if (AUTOMATED_FROM.test(from)) return true
  return /\b(report|newsletter|digest|receipt|your order|weekly|webinar)\b/i.test(subject) && !/\bre:/i.test(subject)
}

export interface Grounding {
  industry?: string
  businessType?: string
  /** One sentence, for the headline. The full summary is long-form and stays server-side. */
  line?: string
  /** The answers to "What do you want off your plate first?" — taken from what was found. */
  choices: string[]
}

/**
 * How to read each provider's inbox. Gmail is a native service (read_emails); Outlook is
 * Composio-managed and declares list_messages (config/integrations/outlook.yml, read-only).
 */
const READ_INBOX: Record<string, { action: string; params: (n: number) => Record<string, unknown> }> = {
  gmail: { action: "read_emails", params: (n) => ({ max_results: n, query: "in:inbox" }) },
  outlook: {
    action: "list_messages",
    params: (n) => ({
      folder: "Inbox",
      top: n,
      orderby: ["receivedDateTime desc"],
      select: ["id", "conversationId", "subject", "from", "receivedDateTime", "bodyPreview"],
    }),
  },
}

/**
 * One thread shape from either provider. Gmail returns {emails:[{subject, from, snippet}]};
 * Outlook returns Microsoft Graph messages ({value:[{subject, from:{emailAddress}, bodyPreview}]})
 * wherever Composio nests them. Present-but-empty stays empty — the caller says so.
 */
export function toThreads(body: any): MailThread[] {
  const pick = (...c: any[]) => c.find((x) => Array.isArray(x)) ?? []
  const raw: any[] = pick(
    body?.emails, body?.data?.emails, body?.value, body?.data?.value, body?.data?.data?.value,
    body?.messages, body?.data?.messages, body?.data?.data?.messages, body?.data?.response_data?.messages,
    body?.data,
  )
  return raw.map((e) => {
    // Native gmail: {from, subject, snippet, date}. Outlook (Graph): {from:{emailAddress}, bodyPreview,
    // receivedDateTime}. Composio GMAIL_FETCH_EMAILS: {sender, subject, preview:{body}, messageText,
    // messageTimestamp, labelIds} — read as native, it came back as subject-only rows (2026-10-08).
    const addr = e?.from?.emailAddress
    const from =
      typeof e?.from === "string"
        ? e.from
        : addr
          ? addr.name && addr.address ? `${addr.name} <${addr.address}>` : String(addr.name ?? addr.address ?? "")
          : String(e?.sender ?? "")
    const labels: string[] = Array.isArray(e?.labelIds) ? e.labelIds : Array.isArray(e?.labels) ? e.labels : []
    const subject = String(e?.subject ?? e?.preview?.subject ?? "(no subject)")
    const snippet = String(e?.snippet ?? e?.bodyPreview ?? e?.preview?.body ?? e?.messageText ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400)
    const automated = isAutomated(from, labels, subject)
    return {
      id: String(e?.id ?? e?.messageId ?? ""),
      threadId: e?.thread_id ?? e?.threadId ?? e?.conversationId ?? undefined,
      subject,
      from,
      date: e?.date ?? e?.receivedDateTime ?? e?.messageTimestamp ?? undefined,
      snippet,
      unread: labels.length ? labels.includes("UNREAD") : e?.isRead === false ? true : undefined,
      automated,
      kind: classify({ from, subject, snippet, automated }),
      to: typeof e?.to === "string" ? e.to : undefined,
    }
  })
}

/**
 * The first mail connection the READER can use, from iris-api's integrations index.
 *
 * Not fl-api's list. Mail is read through iris-api (execute-direct), which only sees iris-api's
 * own integration rows. fl-api's native Google OAuth writes to fl-api's table instead, so its
 * list said "Gmail connected" for an account whose mail then failed to read with "No active
 * 'gmail' connection found" (2026-10-08, the first end-to-end desktop test). "Connected" here
 * has to mean "readable", or the screen skips Connect and lands on an error.
 */
export function pickMailConnection(rows: unknown): { type: (typeof MAIL_TYPES)[number]; account?: string } | undefined {
  const list = Array.isArray(rows) ? rows : []
  for (const type of MAIL_TYPES) {
    const hit = list.find((r: any) => r?.type === type && (r?.isConnected === true || r?.status === "active"))
    if (hit) return { type, account: (hit as any).account_email ?? (hit as any).account ?? undefined }
  }
  return undefined
}

/** Types of every active connection, deduplicated. */
export function activeTypes(rows: unknown): string[] {
  const list = Array.isArray(rows) ? rows : []
  return [...new Set(list.filter((r: any) => typeof r?.type === "string" && (r?.isConnected === true || r?.status === "active")).map((r: any) => r.type as string))]
}

export async function state(): Promise<PlatformResult<OnboardingState>> {
  const userId = await resolveUserId()
  if (!userId) {
    return { measured: true, data: { signedIn: false, mail: { connected: false } } }
  }
  try {
    const res = await irisFetch(`/api/v1/integrations-temp?user_id=${userId}`, IRIS_API)
    const body = (await res.json().catch(() => null)) as any
    if (!res.ok || body?.success === false) {
      return {
        measured: false,
        reason: String(body?.error ?? body?.message ?? `iris-api ${res.status}`),
        data: { signedIn: true, mail: { connected: false } },
      }
    }
    const rows = body?.data ?? body?.integrations
    const connected = activeTypes(rows)
    const hit = pickMailConnection(rows)
    if (hit) return { measured: true, data: { signedIn: true, mail: { connected: true, ...hit }, connected } }
    return { measured: true, data: { signedIn: true, mail: { connected: false }, connected } }
  } catch (e) {
    return {
      measured: false,
      reason: e instanceof Error ? e.message : String(e),
      data: { signedIn: true, mail: { connected: false } },
    }
  }
}

/** "Jane Doe <jane@x.com>" → "Jane Doe"; a bare address stays an address. */
function displayName(from: string): string {
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from)
  return (m ? m[1] : from).trim()
}

function sameAddress(from: string, account?: string): boolean {
  if (!account) return false
  return from.toLowerCase().includes(account.toLowerCase())
}

export async function mail(limit = 40): Promise<PlatformResult<{ threads: MailThread[]; account?: string }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { threads: [] } }

  const s = await state()
  if (!s.data.mail.connected) return { measured: false, reason: "no mail account is connected yet", data: { threads: [] } }
  const type = s.data.mail.type!

  try {
    const read = READ_INBOX[type] ?? READ_INBOX.gmail
    const res = await irisFetch(`/api/v1/users/${userId}/integrations/execute-direct`, IRIS_API, {
      method: "POST",
      body: JSON.stringify({ integration: type, action: read.action, params: read.params(limit) }),
    })
    const body = (await res.json().catch(() => null)) as any
    if (!res.ok || body?.success === false) {
      return { measured: false, reason: String(body?.error ?? body?.message ?? `HTTP ${res.status}`), data: { threads: [] } }
    }
    const threads = toThreads(body)
    return { measured: true, data: { threads, account: s.data.mail.account ?? inferAccount(threads) } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { threads: [] } }
  }
}

/** Threads someone else started, newest first — the ones most likely waiting on this person. */
export function waiting(threads: MailThread[], account?: string, n = 3): MailThread[] {
  const mine = (t: MailThread) => sameAddress(t.from, account)
  const people = threads.filter((t) => (t.kind ?? (t.automated ? "fyi" : "person")) === "person" && !mine(t))
  const actions = threads.filter((t) => t.kind === "action" && !mine(t))
  return [...people, ...actions].slice(0, n)
}

/** The address most of these messages were sent TO — the account, when the provider is silent. */
export function inferAccount(threads: MailThread[]): string | undefined {
  const count = new Map<string, number>()
  for (const t of threads) {
    for (const a of (t.to ?? "").match(/[^\s<>,"]+@[^\s<>,"]+/g) ?? []) count.set(a.toLowerCase(), (count.get(a.toLowerCase()) ?? 0) + 1)
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

/** Subject, sender and snippet only, under the endpoint's 5,000-character prompt limit. */
export function digest(threads: MailThread[], max = 4500): string {
  let out = ""
  for (const t of threads) {
    const line = `- From ${displayName(t.from)}: "${t.subject}" — ${t.snippet.replace(/\s+/g, " ").slice(0, 220)}\n`
    if (out.length + line.length > max) break
    out += line
  }
  return out
}

function firstSentence(text?: string): string | undefined {
  if (!text) return undefined
  const s = text.replace(/\s+/g, " ").trim()
  const m = /^(.{20,240}?[.!?])(\s|$)/.exec(s)
  return (m ? m[1] : s.slice(0, 240)).trim()
}

export async function ground(threads: MailThread[]): Promise<PlatformResult<Grounding>> {
  if (threads.length === 0) return { measured: false, reason: "no mail to read yet", data: { choices: [] } }
  try {
    const res = await irisFetch(`/api/v1/workflow-generation/business-summary`, IRIS_API, {
      method: "POST",
      body: JSON.stringify({
        prompt:
          "These are the most recent emails in one person's inbox. From them alone, describe the business " +
          "this person runs and what is waiting on them. Do not invent facts that are not in the emails.",
        document_context: digest(threads),
      }),
    })
    const body = (await res.json().catch(() => null)) as any
    if (!res.ok || !body?.success) {
      return { measured: false, reason: String(body?.message ?? body?.error ?? `HTTP ${res.status}`), data: { choices: [] } }
    }
    const d = body.data ?? {}
    const choices: string[] = [
      ...(Array.isArray(d.recommended_next_steps) ? d.recommended_next_steps : []),
      ...(Array.isArray(d?.current_state?.pain_points) ? d.current_state.pain_points : []),
    ]
      .map((c: unknown) => String(c).split(/\s+[→-]\s+|:\s/)[0].trim()) // the action, not its justification
      .filter((c: string) => c.length > 3)
      .slice(0, 3)
    return {
      measured: true,
      data: {
        industry: d.industry ?? undefined,
        businessType: d.business_type ?? undefined,
        line: firstSentence(d.summary),
        choices,
      },
    }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { choices: [] } }
  }
}

/** "Bright Smile Dental — Austin" → "bright-smile-dental-austin". Never empty, never a path. */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "")
  return s || "workspace"
}

/**
 * ~/IRIS/<business>: the folder the first session runs in. Created, not picked — a brand-new user
 * should never meet an empty folder dialog before IRIS has done anything for them. Reused if it
 * already exists, so a second run of onboarding does not make "-2" copies.
 */
export function workspace(name: string, root = path.join(homedir(), "IRIS")): PlatformResult<{ path: string }> {
  try {
    const dir = path.join(root, slugify(name))
    mkdirSync(dir, { recursive: true })
    return { measured: true, data: { path: dir } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { path: "" } }
  }
}

/**
 * The steps after sign-in, onto the same funnel the desktop shell writes (D7 #188247). Sent from
 * here, not from the webview: the webview's origin is not in iris-api's CORS list. Uses the same
 * install id the shell created (~/.iris/install-id), so one install is one row of the funnel.
 * Only names on fl-iris-api's GenesisEvent::DESKTOP_ONBOARDING are accepted there.
 */
const APP_STEPS = new Set([
  "onboarding.mail_read",
  "onboarding.grounded",
  "onboarding.question_answered",
  "onboarding.workspace_created",
  "onboarding.working",
])

export async function track(event: string, label?: string): Promise<void> {
  if (!APP_STEPS.has(event)) return
  let visitor: string | undefined
  try {
    visitor = readFileSync(path.join(homedir(), ".iris", "install-id"), "utf8").trim()
  } catch {
    return // no install id: the shell has not run, so there is no funnel row to join
  }
  try {
    await irisFetch(`/api/v1/genesis/events`, IRIS_API, {
      method: "POST",
      body: JSON.stringify({ event, visitor_id: visitor, label, path: "desktop" }),
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    // Measurement never breaks onboarding.
  }
}
