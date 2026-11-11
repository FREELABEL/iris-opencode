import { FL_API, irisFetch, resolveUserId } from "./platform"
import { PAGE_SLUG } from "./page-signin"

/**
 * "CREATE YOUR CAMPAIGN BOARD" FROM DESKTOP (#192627, epic #192614).
 *
 * Desktop › Marketing's empty state runs the same setup as `iris campaigns setup` (#192625): fl-api
 * POST /api/v1/campaigns/setup {bloq_id} makes the four campaign datasets on the board and the
 * board's private review page (/p/<board-slug>-campaigns, through CampaignReviewPage::ensure), and
 * is safe to re-run. The engine only translates: which boards to offer, and the answer in words a
 * customer reads — never a bloq id or an HTTP status.
 *
 * WHO MAY SET UP: fl-api decides (CampaignAccess::canManage — the owner, or an editor of the whole
 * board). The board list here offers owners and editors from the account's own board list (the
 * same /user/{id}/bloqs the Atlas picker reads, with the permission column); an editor whose access
 * is limited to one list is still offered, and fl-api's refusal is then shown as "not allowed".
 */

/** `lists`: how many lists the board has (#193233 — shown in the picker so boards are told apart). */
export type CampaignBoard = { id: number; name: string; role: "owner" | "editor"; lists?: number }

export type CampaignBoards = { measured: boolean; reason?: string; boards: CampaignBoard[] }

export type CampaignSetupError = "signed_out" | "not_allowed" | "not_deployed" | "conflict" | "busy" | "unreachable" | "failed"

export type CampaignSetup = {
  ok: boolean
  /** Why not, in the customer's words. Present when ok is false. */
  error?: { kind: CampaignSetupError; message: string }
  /** The review page's address on the board, e.g. acme-campaigns. */
  page_slug?: string
  url?: string
  /** The review page exists now (made by this run or an earlier one). False = only its address is reserved. */
  page_created?: boolean
  /** This run made the page. */
  page_new?: boolean
  /** Nothing new was made: the board already had its campaign datasets and page. */
  already_set_up?: boolean
  datasets?: Array<{ slug: string; state: DatasetState }>
}

type DatasetState = "created" | "restored" | "present"

/** The seams a test replaces: the account's boards, and fl-api's setup call. */
export const campaignSetupDeps = {
  boards: async (): Promise<Response | null> => {
    const userId = await resolveUserId()
    if (!userId) return null
    return irisFetch(`/api/v1/user/${userId}/bloqs?per_page=500`)
  },
  setup: (bloqId: number): Promise<Response> =>
    irisFetch("/api/v1/campaigns/setup", FL_API, { method: "POST", body: JSON.stringify({ bloq_id: bloqId }) }),
}

export async function listCampaignBoards(): Promise<CampaignBoards> {
  const res = await campaignSetupDeps.boards().catch(() => undefined)
  if (res === null) return { measured: false, reason: "Sign in to IRIS first.", boards: [] }
  if (!res) return { measured: false, reason: "IRIS isn't answering right now.", boards: [] }
  if (res.status === 401) return { measured: false, reason: "Sign in to IRIS first.", boards: [] }
  if (!res.ok) return { measured: false, reason: "Your boards couldn't be read right now.", boards: [] }
  const json = (await res.json().catch(() => null)) as { data?: unknown } | null
  const raw = Array.isArray(json?.data) ? (json.data as Array<Record<string, unknown>>) : []
  const boards = raw.flatMap((b): CampaignBoard[] => {
    const id = Number(b.id)
    if (!Number.isInteger(id) || id <= 0) return []
    const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : "Untitled board"
    const lists = Array.isArray(b.lists) ? { lists: b.lists.length } : {}
    if (b.is_owner === true) return [{ id, name, role: "owner", ...lists }]
    if (b.user_permission === "editor") return [{ id, name, role: "editor", ...lists }]
    return []
  })
  return { measured: true, boards }
}

export async function runCampaignSetup(bloqId: number): Promise<CampaignSetup> {
  if (!Number.isInteger(bloqId) || bloqId <= 0) return fail("failed", "Pick a board first.")
  const res = await campaignSetupDeps.setup(bloqId).catch(() => undefined)
  if (!res) return fail("unreachable", "IRIS isn't answering right now. Nothing was made — try again in a moment.")
  if (!res.ok) return refusal(res.status)
  const json = (await res.json().catch(() => null)) as { data?: Record<string, any> } | null
  const data = json?.data
  if (!data || typeof data !== "object") return fail("failed", "IRIS answered, but not with a campaign board. Nothing was pinned.")
  const datasets = Object.entries((data.datasets ?? {}) as Record<string, unknown>).flatMap(([slug, state]) =>
    state === "created" || state === "restored" || state === "present" ? [{ slug, state: state as DatasetState }] : [],
  )
  const page = (data.page ?? {}) as Record<string, unknown>
  const slug = typeof page.page_slug === "string" ? page.page_slug.toLowerCase() : ""
  const made = page.made === true && PAGE_SLUG.test(slug)
  return {
    ok: true,
    ...(slug ? { page_slug: slug } : {}),
    ...(typeof page.url === "string" ? { url: page.url } : {}),
    page_created: made,
    page_new: made && page.created === true,
    already_set_up: data.created === false,
    datasets,
  }
}

function refusal(status: number): CampaignSetup {
  if (status === 401) return fail("signed_out", "Sign in to IRIS first.")
  if (status === 403)
    return fail("not_allowed", "Only a board's owner, or someone who can edit the whole board, can set up campaigns on it. Nothing was made.")
  if (status === 404 || status === 405)
    return fail("not_deployed", "This part of IRIS isn't switched on yet. Nothing was made — try again after the next update.")
  if (status === 409)
    return fail(
      "conflict",
      "This board already has campaign data its owner didn't create, so nothing was changed. Ask IRIS support to clear it, then try again.",
    )
  if (status === 429) return fail("busy", "Too many tries in a row. Wait a minute, then try again.")
  if (status >= 500) return fail("unreachable", "IRIS couldn't finish setting up right now. Nothing was pinned — try again in a moment.")
  return fail("failed", "IRIS couldn't set up campaigns on this board. Nothing was pinned.")
}

function fail(kind: CampaignSetupError, message: string): CampaignSetup {
  return { ok: false, error: { kind, message } }
}
