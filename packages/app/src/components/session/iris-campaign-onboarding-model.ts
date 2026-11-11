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

/** What the wizard makes (#193233). A campaign review is the #192627 flow; the other two name a thing first. */
export type MakeKind = "campaign" | "landing" | "brand"

export const KINDS: Array<{ kind: MakeKind; title: string; hint: string }> = [
  { kind: "campaign", title: "Campaign review", hint: "A private page where your team reviews and approves your ads" },
  { kind: "landing", title: "Landing page", hint: "A page for an offer or an event. It stays a draft until you publish it" },
  { kind: "brand", title: "Brand kit", hint: "Your logo, colours and type, for every page and ad you make" },
]

export const kindTitle = (k: MakeKind) => KINDS.find((x) => x.kind === k)!.title

/** The result of making a brand kit or landing page (engine /iris/marketing/*). */
export type MakeResult = {
  ok: boolean
  error?: { kind: "signed_out" | "not_allowed" | "not_deployed" | "invalid" | "busy" | "unreachable" | "failed"; message: string }
  id?: number
  slug?: string
  name?: string
}

export type Step =
  | { at: "idle" }
  | { at: "choose" }
  | { at: "name"; board: CampaignBoard; boards: CampaignBoard[] }
  | { at: "made"; board: CampaignBoard; name: string }
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
export function afterBoards(r: CampaignBoards, kind: MakeKind = "campaign"): Step {
  if (!r.measured)
    return { at: "message", tone: "error", title: "Your boards couldn't be read", body: r.reason ?? "Try again in a moment.", retry: true }
  if (r.boards.length === 0)
    return {
      at: "message",
      tone: "info",
      title: "No board to set up on",
      body: "Everything here is made on a board you own or can edit. Make a board in Atlas first, or ask its owner to make you an editor.",
      retry: false,
    }
  if (r.boards.length === 1)
    return kind === "campaign" ? { at: "confirm", board: r.boards[0], boards: r.boards } : { at: "name", board: r.boards[0], boards: r.boards }
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

/**
 * The board picker's badge (#193233). Every board offered is one you own or edit, so "yours" on
 * every row said nothing. Only a board you edit but don't own is marked.
 */
export const boardTag = (b: CampaignBoard): string | null => (b.role === "editor" ? "shared" : null)

/** What the name step says will be made. */
export function nameText(kind: Exclude<MakeKind, "campaign">, board: CampaignBoard): string {
  return kind === "landing"
    ? `A draft page on ${board.name}, with a headline and a footer to start from. Nobody can see it until you publish it.`
    : `A brand kit on ${board.name}. Add its logo, colours and type next, in Genesis › Brand kits.`
}

/** After making a landing page or brand kit: pin the page, show the kit, or say why not. */
export function afterMake(
  kind: Exclude<MakeKind, "campaign">,
  board: CampaignBoard,
  r: MakeResult,
): Next | { do: "made"; step: Extract<Step, { at: "made" }> } {
  const what = kind === "landing" ? "landing page" : "brand kit"
  if (!r.ok) {
    const k = r.error?.kind ?? "failed"
    const title =
      k === "not_deployed"
        ? `Making a ${what} isn't available yet`
        : k === "signed_out"
          ? "Sign in to IRIS first"
          : k === "not_allowed"
            ? `You can't add a ${what} to ${board.name}`
            : `Couldn't make the ${what}`
    const retry = k === "busy" || k === "unreachable" || k === "failed"
    return { do: "say", step: { at: "message", tone: k === "not_deployed" ? "info" : "error", title, body: r.error?.message ?? "Nothing was made.", board, retry } }
  }
  if (kind === "brand") return { do: "made", step: { at: "made", board, name: r.name ?? "Your brand" } }
  if (!r.slug)
    return { do: "say", step: { at: "message", tone: "error", title: "The page was made, but IRIS didn't say where", body: "Find it in Genesis › Pages.", board, retry: false } }
  return { do: "pin", slug: r.slug, label: r.name ?? "Landing page", already: false }
}
