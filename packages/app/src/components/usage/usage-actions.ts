import type { FetchJson } from "@/components/dialog-upgrade"

/**
 * The popover's calls to the sidecar (epic #194525). Like requestCheckout, every failure comes back
 * as a sentence the UI shows as it is — a network error included.
 */

export interface TopupPack {
  key: string
  tokens: number
  priceUsd: number
  label: string | null
}

export interface Invite {
  url: string
  code: string | null
  rewardTokens: number | null
  invited: number | null
  rewarded: number | null
}

export interface AutoTopup {
  enabled: boolean
  pack: string | null
  monthlyCapUsd: number | null
}

const why = (what: string, e: unknown) => `${what}: ${e instanceof Error ? e.message : String(e)}`

export async function loadPacks(fetchJson: FetchJson): Promise<{ packs: TopupPack[] } | { error: string }> {
  try {
    const r = await fetchJson<{ measured: boolean; reason?: string; packs?: TopupPack[] }>("/iris/topup/packs")
    if (r?.measured && Array.isArray(r.packs)) return { packs: r.packs }
    return { error: r?.reason || "Top-ups aren't available right now." }
  } catch (e) {
    return { error: why("Couldn't load top-ups", e) }
  }
}

export async function requestTopup(fetchJson: FetchJson, pack: string): Promise<{ url: string } | { error: string }> {
  try {
    const r = await fetchJson<{ ok: boolean; url?: string; reason?: string }>("/iris/topup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pack }),
    })
    if (r?.ok && r.url) return { url: r.url }
    return { error: r?.reason || "Top-up checkout didn't open. Try again." }
  } catch (e) {
    return { error: why("Top-up checkout didn't open", e) }
  }
}

export async function loadInvite(fetchJson: FetchJson): Promise<{ invite: Invite } | { error: string }> {
  try {
    const r = await fetchJson<{ measured: boolean; reason?: string; invite?: Invite | null }>("/iris/invite")
    if (r?.measured && r.invite?.url) return { invite: r.invite }
    return { error: r?.reason || "No invite link right now." }
  } catch (e) {
    return { error: why("Couldn't load your invite link", e) }
  }
}

type AutoAnswer = { measured: boolean; reason?: string; autoTopup?: AutoTopup | null }

export async function loadAutoTopup(fetchJson: FetchJson): Promise<{ value: AutoTopup } | { error: string }> {
  try {
    const r = await fetchJson<AutoAnswer>("/iris/auto-topup")
    if (r?.measured && r.autoTopup) return { value: r.autoTopup }
    return { error: r?.reason || "Auto top-up isn't available right now." }
  } catch (e) {
    return { error: why("Couldn't read auto top-up", e) }
  }
}

export async function saveAutoTopup(
  fetchJson: FetchJson,
  value: { enabled: boolean; pack?: string | null },
): Promise<{ value: AutoTopup } | { error: string }> {
  try {
    const r = await fetchJson<AutoAnswer>("/iris/auto-topup", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    })
    if (r?.measured && r.autoTopup) return { value: r.autoTopup }
    return { error: r?.reason || "Auto top-up wasn't saved. Try again." }
  } catch (e) {
    return { error: why("Auto top-up wasn't saved", e) }
  }
}
