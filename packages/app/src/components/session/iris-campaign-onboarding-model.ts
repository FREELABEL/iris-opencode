/**
 * "CREATE YOUR CAMPAIGN BOARD" (#192627, epic #192614) — the steps, as pure functions, so the rules
 * are tested without a DOM or a network.
 *
 *   boards  GET  /iris/campaigns/boards   the boards this account owns or edits
 *   pick    skipped when there is exactly one
 *   confirm "four datasets on <board> and a private review page"
 *   run     POST /iris/campaigns/setup {bloq_id}   (fl-api #192625, idempotent)
 *   pin     only a page that exists: setup reports page_created=false while the page hook has not
 *           made it, and then nothing is pinned
 *
 * Every word shown comes from here or from the engine's plain-language message — never a board id
 * or an HTTP status.
 */

export type CampaignBoard = { id: number; name: string; role: "owner" | "editor" }
export type CampaignBoards = { measured: boolean; reason?: string; boards: CampaignBoard[] }
export type CampaignSetupKind = "signed_out" | "not_allowed" | "not_deployed" | "conflict" | "busy" | "unreachable" | "failed"
export type CampaignSetup = {
  ok: boolean
  error?: { kind: CampaignSetupKind; message: string }
  page_slug?: string
  url?: string
  page_created?: boolean
  page_new?: boolean
  already_set_up?: boolean
  datasets?: Array<{ slug: string; state: string }>
}

export type Step =
  | { at: "idle" }
  | { at: "loading" }
  | { at: "pick"; boards: CampaignBoard[] }
  | { at: "confirm"; board: CampaignBoard; boards: CampaignBoard[] }
  | { at: "running"; board: CampaignBoard }
  | { at: "pinned"; board: CampaignBoard; already: boolean }
  | { at: "message"; tone: "info" | "error"; title: string; body: string; board?: CampaignBoard; retry: boolean }

/** What setup tells the panel to do next: pin the page, or say why not. */
export type Next = { do: "pin"; slug: string; label: string; already: boolean } | { do: "say"; step: Extract<Step, { at: "message" }> }

export const DATASETS_SENTENCE = "campaigns, creatives, feedback and templates"

/** After the board list: an error, nothing to set up on, a picker — or straight to confirm when there is one board. */
export function afterBoards(r: CampaignBoards): Step {
  if (!r.measured)
    return { at: "message", tone: "error", title: "Your boards couldn't be read", body: r.reason ?? "Try again in a moment.", retry: true }
  if (r.boards.length === 0)
    return {
      at: "message",
      tone: "info",
      title: "No board to set up on",
      body: "A campaign board is made on a board you own or can edit. Make a board in Atlas first, or ask its owner to make you an editor.",
      retry: false,
    }
  if (r.boards.length === 1) return { at: "confirm", board: r.boards[0], boards: r.boards }
  return { at: "pick", boards: r.boards }
}

/** What will be made, in plain words. */
export function confirmText(board: CampaignBoard): string {
  return `This makes four datasets on ${board.name} (${DATASETS_SENTENCE}) and a private review page only the board's members can open. It's safe to run again; nothing already there is changed.`
}

export const pinLabel = (board: CampaignBoard) => `${board.name} campaigns`

/** After setup: pin only a page that exists. */
export function afterSetup(board: CampaignBoard, r: CampaignSetup): Next {
  if (!r.ok) {
    const kind = r.error?.kind ?? "failed"
    const title =
      kind === "not_deployed"
        ? "Campaign boards aren't available yet"
        : kind === "not_allowed"
          ? `You can't set up campaigns on ${board.name}`
          : kind === "signed_out"
            ? "Sign in to IRIS first"
            : kind === "conflict"
              ? `${board.name} needs a hand from support`
              : `Couldn't set up ${board.name}`
    const retry = kind === "busy" || kind === "unreachable" || kind === "failed"
    return { do: "say", step: { at: "message", tone: kind === "not_deployed" ? "info" : "error", title, body: r.error?.message ?? "Nothing was made.", board, retry } }
  }
  if (!r.page_created || !r.page_slug)
    return {
      do: "say",
      step: {
        at: "message",
        tone: "info",
        title: `${board.name} is set up, but its review page isn't made yet`,
        body: `The four datasets are on ${board.name}. The review page${r.page_slug ? ` (/p/${r.page_slug})` : ""} hasn't been created yet, so nothing was pinned. Try again once it's ready.`,
        board,
        retry: true,
      },
    }
  return { do: "pin", slug: r.page_slug, label: pinLabel(board), already: r.already_set_up === true }
}

/** The page exists but the pin was refused (the engine's own-pages check). */
export function pinRefused(board: CampaignBoard, slug: string, reason: string): Step {
  return {
    at: "message",
    tone: "error",
    title: `${board.name}'s review page couldn't be pinned`,
    body: `The page is at /p/${slug}, but pinning it was refused: ${reason}.`,
    board,
    retry: true,
  }
}
