import { FL_API, irisFetch, type PlatformResult } from "./platform"
import {
  autoTopupBody,
  autoTopupFrom,
  inviteFrom,
  topupPacksFrom,
  type AutoTopup,
  type Invite,
  type TopupPack,
} from "./usage-shape"

/**
 * Top-ups, invites and auto top-up (epic #194525) — fl-api, with the same Bearer token the plan
 * checkout uses. Every failure is a SENTENCE the app can show as it is, never a bare status: the
 * bug requestCheckout replaced was a button that did nothing and never said why (#190190).
 */

/** "fl-api 404" is a fact for a log; the person needs to know what to do. */
function refusal(what: string, status: number, body: any): string {
  if (status === 401) return "Your sign-in has expired. Sign in again, then try again."
  if (status === 404) return `${what} isn't available on this account yet.`
  const message = typeof body?.message === "string" && body.message.trim() ? `: ${body.message.trim()}` : ""
  return `${what} was refused (${status})${message}`
}

const unreachable = (what: string, e: unknown) =>
  `Couldn't reach ${what}: ${e instanceof Error ? e.message : String(e)}`

async function json(res: Response): Promise<any> {
  return res.json().catch(() => null)
}

export async function fetchTopupPacks(): Promise<PlatformResult<TopupPack[]>> {
  try {
    const res = await irisFetch("/api/v1/usage/topups/packs", FL_API)
    const body = await json(res)
    if (!res.ok) return { measured: false, reason: refusal("Top-ups", res.status, body), data: [] }
    return { measured: true, data: topupPacksFrom(body) }
  } catch (e) {
    return { measured: false, reason: unreachable("top-ups", e), data: [] }
  }
}

export type TopupResult = { ok: true; url: string } | { ok: false; reason: string }

/** A Stripe Checkout session for one top-up pack. The app opens the URL itself. */
export async function createTopup(pack: string): Promise<TopupResult> {
  if (!pack?.trim()) return { ok: false, reason: "Pick a top-up first." }
  try {
    const res = await irisFetch("/api/v1/usage/topups/checkout", FL_API, {
      method: "POST",
      body: JSON.stringify({ pack }),
    })
    const body = await json(res)
    const url = body?.url ?? body?.data?.url
    if (res.ok && typeof url === "string" && url) return { ok: true, url }
    if (res.ok) return { ok: false, reason: "Top-up checkout didn't open. Try again." }
    return { ok: false, reason: refusal("Top-up", res.status, body) }
  } catch (e) {
    return { ok: false, reason: unreachable("top-up checkout", e) }
  }
}

export async function fetchInvite(): Promise<PlatformResult<Invite | null>> {
  try {
    const res = await irisFetch("/api/v1/usage/invite", FL_API)
    const body = await json(res)
    if (!res.ok) return { measured: false, reason: refusal("Invites", res.status, body), data: null }
    const invite = inviteFrom(body)
    if (!invite) return { measured: false, reason: "No invite link came back. Try again later.", data: null }
    return { measured: true, data: invite }
  } catch (e) {
    return { measured: false, reason: unreachable("invites", e), data: null }
  }
}

export async function fetchAutoTopup(): Promise<PlatformResult<AutoTopup | null>> {
  try {
    const res = await irisFetch("/api/v1/usage/auto-topup", FL_API)
    const body = await json(res)
    if (!res.ok) return { measured: false, reason: refusal("Auto top-up", res.status, body), data: null }
    const value = autoTopupFrom(body)
    if (!value) return { measured: false, reason: "Auto top-up didn't say whether it is on.", data: null }
    return { measured: true, data: value }
  } catch (e) {
    return { measured: false, reason: unreachable("auto top-up", e), data: null }
  }
}

export async function saveAutoTopup(v: {
  enabled: boolean
  pack?: string | null
  monthlyCapUsd?: number | null
}): Promise<PlatformResult<AutoTopup | null>> {
  try {
    const res = await irisFetch("/api/v1/usage/auto-topup", FL_API, {
      method: "PUT",
      body: JSON.stringify(autoTopupBody(v)),
    })
    const body = await json(res)
    if (!res.ok) return { measured: false, reason: refusal("Auto top-up", res.status, body), data: null }
    // Some servers answer 204 / an empty body to a PUT: what we sent is then what is saved.
    const value = autoTopupFrom(body) ?? { enabled: v.enabled, pack: v.pack ?? null, monthlyCapUsd: v.monthlyCapUsd ?? null }
    return { measured: true, data: value }
  } catch (e) {
    return { measured: false, reason: unreachable("auto top-up", e), data: null }
  }
}
