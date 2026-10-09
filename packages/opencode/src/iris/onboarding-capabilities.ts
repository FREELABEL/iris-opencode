import { execFile } from "child_process"
import { irisCliPath } from "./playbook-install"

/**
 * WHAT IRIS CAN DO, for a goal the person stated (EPIC #188210, 2026-10-08).
 *
 * The order of truth, as Alex set it:
 *   1. the goal — what they said, verbatim;
 *   2. what IRIS can actually do — first-class CLI commands, playbooks and integration actions;
 *   3. the inbox — a cross-check that confirms or sharpens a recommendation, never its source.
 *
 * So recommendations come from here, not from the mail. Two sources:
 *
 *   CATALOG  — curated, for the four starter goals. Every `tool` below was checked against the
 *              installed CLI on 2026-10-08 (`iris gmail`, `iris leads pulse`, `iris reachr`,
 *              `iris atlas:meetings`, the bills-to-books playbook). It is the floor: what shows
 *              when intent is wrong, slow, or the CLI is not installed yet.
 *   INTENT   — `iris intent <goal> --json`, the platform router. It is what answers a goal typed
 *              in the person's own words, and it adds to the catalog when it is confident. It is
 *              being improved separately; this file only consumes its --json output, so every
 *              improvement there shows up here unchanged.
 *
 * Measured the same day, intent picked the wrong tool for 3 of 5 onboarding goals (e.g. "reply to
 * the people waiting on me in my email" → `imessage mentions approve`, 0.47). Hence the floor, and
 * hence MIN_CONFIDENCE: below it, intent's pick is shown as nothing rather than as a wrong thing.
 */

export type GoalId = "reply" | "admin" | "catchup" | "leads" | "custom"

export interface Capability {
  id: string
  title: string
  detail: string
  /** The real thing that does it — shown to the person, and named to the session so it uses it. */
  tool: string
  /** Inbox evidence: which threads this applies to. Kinds come from onboarding.classify(). */
  evidence: { kinds: Array<"person" | "action" | "fyi">; pattern?: string }
  source: "catalog" | "intent"
  /** The one that answers the goal most directly. Ticked by default. */
  primary?: boolean
}

export interface IntentPick {
  choice?: string
  confidence?: number
  commands: string[]
}

export const MIN_CONFIDENCE = 0.5
/** Higher bar to ADD to a starter goal's catalog: an extra must be clearly right, not merely plausible
 *  (measured: "reply to people waiting on me" → iMessage at 0.53, next to an email goal). */
export const ADD_CONFIDENCE = 0.7

// Not plain "payment": "Payment failed" is an alert that needs the person, not a receipt for the books.
const RECEIPTS = "receipt|invoice|bill(?!ing)|payment (received|confirm)|paid|charge|transaction|statement|refund"
const SECURITY = "sign[- ]?in|signed in|login|device|password|security|verify|verification|suspicious"
const LEADS = "quote|pricing|price|rates?|interested|inquir|enquir|book(ing)?|availability|proposal|partner|collab|hire|project|estimate|demo"
const MEETINGS = "meeting|call|notes|recap|transcript|zoom|meet"

export const CATALOG: Record<Exclude<GoalId, "custom">, Capability[]> = {
  reply: [
    {
      id: "draft-replies",
      title: "Draft replies to people waiting on you",
      detail: "In your voice, ready for you to review and send",
      tool: "gmail · send_email (drafts)",
      evidence: { kinds: ["person"] },
      source: "catalog",
      primary: true,
    },
    {
      id: "lead-pulse",
      title: "Check what's happened with each person",
      detail: "Their recent activity across email, iMessage and meetings before you reply",
      tool: "iris leads pulse",
      evidence: { kinds: ["person"] },
      source: "catalog",
    },
  ],
  admin: [
    {
      id: "bills-to-books",
      title: "Turn receipts and bills into your books",
      detail: "Match each charge to a receipt and record it",
      tool: "iris playbook run bills-to-books",
      evidence: { kinds: ["action", "fyi"], pattern: RECEIPTS },
      source: "catalog",
      primary: true,
    },
    {
      id: "security-alerts",
      title: "Check account and security alerts",
      detail: "Tell you which sign-ins and warnings need you, and what to do",
      tool: "gmail · read",
      evidence: { kinds: ["action"], pattern: SECURITY },
      source: "catalog",
      primary: true,
    },
  ],
  catchup: [
    {
      id: "summarise",
      title: "Summarise what you missed",
      detail: "Most important first, with what needs you",
      tool: "iris gmail unread",
      evidence: { kinds: ["person", "action", "fyi"] },
      source: "catalog",
      primary: true,
    },
    {
      id: "meeting-notes",
      title: "Pull notes and action items from your meetings",
      detail: "From meeting recaps in your inbox",
      tool: "iris atlas:meetings scan",
      evidence: { kinds: ["person", "fyi"], pattern: MEETINGS },
      source: "catalog",
    },
  ],
  leads: [
    {
      id: "follow-up-leads",
      title: "Follow up on people asking to buy, book or work together",
      detail: "Draft the follow-up that moves each one forward",
      tool: "iris leads pulse",
      evidence: { kinds: ["person"], pattern: LEADS },
      source: "catalog",
      primary: true,
    },
    {
      id: "find-leads",
      title: "Find more leads like them",
      detail: "From public pages, Instagram and your inbox",
      tool: "iris reachr scrape",
      evidence: { kinds: ["person"], pattern: LEADS },
      source: "catalog",
    },
  ],
}

/** The CLI prints a banner around its JSON; take the object. */
export function parseIntentJson(stdout: string): IntentPick | null {
  const start = stdout.indexOf("{")
  if (start < 0) return null
  try {
    const body = JSON.parse(stdout.slice(start, stdout.lastIndexOf("}") + 1))
    const d = body?.data ?? body
    const commands = (Array.isArray(d?.commands) ? d.commands : [])
      .map((c: unknown) => (typeof c === "string" ? c : (c as any)?.run ?? (c as any)?.name))
      .filter((c: unknown): c is string => typeof c === "string" && c.length > 0)
    const choice = typeof d?.choice === "string" && d.choice ? d.choice : undefined
    const confidence = typeof d?.confidence === "number" ? d.confidence : undefined
    if (!choice && !commands.length) return null
    return { choice, confidence, commands }
  } catch {
    return null
  }
}

/** Intent's pick as a capability — only when it is confident enough to be worth showing. */
export function intentCapability(goal: string, pick: IntentPick | null): Capability | null {
  if (!pick?.choice || (pick.confidence ?? 0) < MIN_CONFIDENCE) return null
  const tool = pick.choice.startsWith("iris ") ? pick.choice : `iris ${pick.choice}`
  return {
    id: `intent:${pick.choice}`,
    title: goal.length > 70 ? `${goal.slice(0, 67)}…` : goal,
    detail: "What IRIS picked for this",
    tool,
    evidence: { kinds: ["person", "action"] },
    source: "intent",
    primary: true,
  }
}

/** Shown for an own-words goal intent cannot place: honest, and still something IRIS will do. */
export function planWithYou(goal: string): Capability {
  return {
    id: "plan-with-you",
    title: goal.length > 70 ? `${goal.slice(0, 67)}…` : goal,
    detail: "IRIS works out the steps with you, using your inbox where it helps",
    tool: "iris session",
    evidence: { kinds: ["person", "action"] },
    source: "catalog",
    primary: true,
  }
}

type Exec = (file: string, args: string[], opts: { timeoutMs: number }) => Promise<{ code: number; stdout: string }>

const realExec: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) =>
      resolve({ code: err ? 1 : 0, stdout: String(stdout ?? "") }),
    )
  })

/** `iris intent <goal> --json`. argv only, never a shell: the goal is text a person typed. */
export async function askIntent(
  goal: string,
  deps: { cli?: string | null; exec?: Exec; timeoutMs?: number } = {},
): Promise<IntentPick | null> {
  const cli = deps.cli === undefined ? irisCliPath() : deps.cli
  const text = goal.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 300)
  if (!cli || !text) return null
  const r = await (deps.exec ?? realExec)(cli, ["intent", text, "--json", "--skip-agents", "--limit", "8"], {
    timeoutMs: deps.timeoutMs ?? 12_000,
  })
  // A non-zero exit can still carry a valid --json body (no confident pick); read it either way.
  return parseIntentJson(r.stdout)
}

/** The card always offers three (Alex, 2026-10-09): what answers the goal, then the nearest others. */
export const OFFER = 3
const NEAREST: Record<GoalId, Array<Exclude<GoalId, "custom">>> = {
  reply: ["catchup", "leads", "admin"],
  admin: ["catchup", "reply", "leads"],
  catchup: ["reply", "admin", "leads"],
  leads: ["reply", "catchup", "admin"],
  custom: ["reply", "catchup", "admin", "leads"],
}
export function topUp(id: GoalId, list: Capability[]): Capability[] {
  const out = [...list]
  for (const g of NEAREST[id]) {
    for (const c of CATALOG[g]) {
      if (out.length >= OFFER) return out
      if (!out.some((o) => o.id === c.id)) out.push({ ...c, primary: false })
    }
  }
  return out
}

/**
 * What to offer for this goal. Starter goals: the catalog, plus intent's pick when it is confident
 * and adds something the catalog lacks. Own words: intent's pick only — when intent cannot place it,
 * nothing is primary and the app pre-fills their own words as the answer. Always topped up to three.
 */
export async function capabilities(
  id: GoalId,
  goal: string,
  deps: Parameters<typeof askIntent>[1] = {},
): Promise<{ capabilities: Capability[]; intent: IntentPick | null }> {
  const pick = await askIntent(goal, deps).catch(() => null)
  const fromIntent = intentCapability(goal, pick)
  if (id === "custom") return { capabilities: topUp(id, fromIntent ? [fromIntent] : []).slice(0, OFFER), intent: pick }

  const base = CATALOG[id]
  const adds =
    fromIntent && (pick?.confidence ?? 0) >= ADD_CONFIDENCE && !base.some((c) => fromIntent.tool.startsWith(c.tool.split(" · ")[0]))
      ? [{ ...fromIntent, primary: false, title: `Also: ${pick!.choice}`, detail: "Suggested by IRIS for this goal" }]
      : []
  return { capabilities: topUp(id, [...base, ...adds]).slice(0, OFFER), intent: pick }
}
