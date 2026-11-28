import type { FetchJson } from "@/components/dialog-upgrade"
import { forgetInviteCode, normaliseInviteCode, pendingInviteCode, settleInvite } from "@/utils/invite-code"
import { trackUpgrade } from "@/utils/upgrade-funnel"
import type { UsagePlan } from "./usage-model"

/**
 * Claiming a friend's invite once signed in (#194575): typed in the usage popover, or a remembered
 * iris://invite link opened after sign-in. The sidecar's /iris/invite/claim says what happened as
 * an outcome and a sentence; this decides what the app remembers about it.
 */

export type InviteOutcome =
  | "attributed"
  | "self_invite"
  | "already_attributed"
  | "too_old"
  | "invalid_code"
  | "signed_out"
  | "error"
  | "unreachable"

export interface InviteClaim {
  ok: boolean
  outcome: InviteOutcome | string
  message: string
}

/** This account's final answer: asking again can only say the same, so the row goes for good. */
const FINAL = new Set<string>(["attributed", "already_attributed", "too_old"])
/** Not the code's fault — a remembered code is kept and tried again on a later launch. */
const TRANSIENT = new Set<string>(["unreachable", "error", "signed_out"])

const UNREACHABLE = "Couldn't reach IRIS to check that code. Try again in a moment."
const UNCHECKED = "That code couldn't be checked right now. Try again later."

export async function claimInviteCode(fetchJson: FetchJson, code: string): Promise<InviteClaim> {
  try {
    const r = await fetchJson<Partial<InviteClaim> | null>("/iris/invite/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
    if (r && typeof r.outcome === "string" && typeof r.message === "string" && r.message)
      return { ok: r.ok === true, outcome: r.outcome, message: r.message }
    return { ok: false, outcome: "error", message: UNCHECKED }
  } catch {
    return { ok: false, outcome: "unreachable", message: UNREACHABLE }
  }
}

/** After any claim: measure a success, remember a final answer, drop a code that has had one. */
export function afterInviteClaim(fetchJson: FetchJson, r: InviteClaim, source: "ring" | "link") {
  if (r.outcome === "attributed") trackUpgrade(fetchJson, "usage.invite_claimed", source)
  if (FINAL.has(r.outcome)) settleInvite()
  if (!TRANSIENT.has(r.outcome)) forgetInviteCode()
}

/**
 * Whether the popover offers "Have an invite code?". Invite codes only work in an account's first
 * 14 days, and the plan carries no account age — so it shows while the account is still at the
 * first level ("explorer"), and never again once a claim had a final answer on this machine.
 */
export function inviteRowVisible(plan: UsagePlan | undefined, settled: boolean): boolean {
  if (settled || !plan?.measured || plan.uncapped) return false
  return plan.progress?.level?.key === "explorer"
}

const tried = new Set<string>()

/**
 * A code remembered from an iris://invite link while already signed in (or kept by a Google
 * sign-in, which cannot carry it): claimed once per code per run. A transient failure stays quiet
 * and keeps the code for the next launch; any real answer comes back to be shown as a toast.
 */
export async function autoClaimPendingInvite(fetchJson: FetchJson, signedIn: boolean): Promise<InviteClaim | null> {
  if (!signedIn) return null
  const raw = pendingInviteCode()
  if (!raw) return null
  const code = normaliseInviteCode(raw)
  if (!code) {
    forgetInviteCode()
    return null
  }
  if (tried.has(code)) return null
  tried.add(code)
  const r = await claimInviteCode(fetchJson, code)
  afterInviteClaim(fetchJson, r, "link")
  return TRANSIENT.has(r.outcome) ? null : r
}

/** Tests only: forget which codes this run already tried. */
export function resetAutoClaimForTest() {
  tried.clear()
}
