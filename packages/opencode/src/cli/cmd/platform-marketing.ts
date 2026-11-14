import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { FL_API, IRIS_API, irisFetch, requireAuth, requireUserId, dim, bold, success, writeJson, emitJsonError } from "./iris-api"
import { resolveBloqId } from "./platform-bloqs"
import {
  applyPinOp,
  boardMeta,
  boardsFrom,
  cleanLabel,
  cleanName,
  EMPTY_PINS,
  filterBoards,
  isKind,
  KINDS,
  landingContent,
  needsSignIn,
  PAGE_ORIGIN,
  pageUrl,
  parsePins,
  PIN_SLUG,
  refusalWords,
  retrySlug,
  slugify,
  slugTaken,
  type MarketingBoard,
  type MarketingKind,
  type PinOp,
  type Pins,
} from "./marketing-core"

// ============================================================================
// iris marketing — what Desktop › Marketing shows and makes, from the terminal (#193357)
//
//   iris marketing                       your pinned pages, and how to make something
//   iris marketing boards [--filter]     the boards you can make things on: #id, lists, shared
//   iris marketing new <campaign|landing|brand> --board <id|name> [--name "…"]
//   iris marketing pins [pin|unpin|rename|move]
//   iris marketing open <slug>           a signed-in link to a members-only page (single use, ~90 s)
//
// THE SAME AS DESKTOP, ON PURPOSE. Boards, slugs, retries, limits and refusal words follow
// marketing-core.ts, which mirrors Desktop's engine. Pins live on the ACCOUNT (fl-api
// /api/v1/me/settings/marketing.pins, #193357), so a pin made here is a tab in Desktop and the
// reverse. Until that server change is deployed, pins say so instead of pretending.
//
// Campaign review is `iris campaigns setup`; reviewing creatives stays `iris campaigns`.
// ============================================================================

const JSON_OPTION = { describe: "machine-readable output", type: "boolean", default: false } as const
const PINS_PATH = "/api/v1/me/settings/marketing.pins"

/** The seams a test replaces. */
export const marketingDeps = {
  fetch: (path: string, init: RequestInit = {}, base: string = FL_API) => irisFetch(path, init, base),
  userId: () => requireUserId(),
  suffix: () => Math.random().toString(36).slice(2, 6),
}

function start(title: string, json: boolean) {
  if (!json) {
    UI.empty()
    prompts.intro(`◈  ${title}`)
  }
}
function end(json: boolean, line = "Done") {
  if (!json) prompts.outro(line)
}
function fail(json: boolean, message: string, extra: Record<string, unknown> = {}) {
  if (json) emitJsonError(message, extra)
  else prompts.log.warn(message)
  process.exitCode = 1
}

// ── boards ────────────────────────────────────────────────────────────────

export async function readBoards(): Promise<{ ok: true; boards: MarketingBoard[] } | { ok: false; reason: string }> {
  const userId = await marketingDeps.userId()
  if (!userId) return { ok: false, reason: "Sign in to IRIS first: iris auth login" }
  const res = await marketingDeps.fetch(`/api/v1/user/${userId}/bloqs?per_page=500`).catch(() => undefined)
  if (!res) return { ok: false, reason: "IRIS isn't answering right now." }
  if (res.status === 401) return { ok: false, reason: "Sign in to IRIS first: iris auth login" }
  if (!res.ok) return { ok: false, reason: "Your boards couldn't be read right now." }
  const j = (await res.json().catch(() => null)) as { data?: unknown } | null
  return { ok: true, boards: boardsFrom(j?.data) }
}

const BoardsCommand = cmd({
  command: "boards",
  describe: "the boards you can make things on — #id, how many lists, and which are shared with you",
  builder: (y) =>
    y
      .option("filter", { alias: "f", describe: "words in the name, or an id", type: "string" })
      .option("json", JSON_OPTION)
      .example("$0 marketing boards", "every board you own or edit")
      .example('$0 marketing boards -f "investor outreach"', "narrow it"),
  async handler(args) {
    const json = Boolean(args.json)
    start("Your boards", json)
    if (!(await requireAuth())) return end(json)
    const r = await readBoards()
    if (!r.ok) return fail(json, r.reason), end(json)
    const shown = filterBoards(r.boards, String(args.filter ?? ""))
    if (json) return writeJson({ success: true, total: r.boards.length, boards: shown })
    if (!shown.length) {
      prompts.log.info(args.filter ? `No board matches "${args.filter}".` : "You don't own or edit any boards yet.")
      return end(json)
    }
    const w = Math.max(...shown.map((b) => b.name.length))
    for (const b of shown) console.log(`  ${bold(b.name.padEnd(w))}  ${dim(boardMeta(b))}${b.role === "editor" ? `  ${dim("shared")}` : ""}`)
    console.log("")
    end(json, `${shown.length} of ${r.boards.length} boards  ·  next: iris marketing new landing --board ${shown[0].id} --name "…"`)
  },
})

// ── pins: the account's own, on the server ───────────────────────────────

type PinsRead = { ok: true; pins: Pins; version: number } | { ok: false; reason: string; notDeployed?: boolean }

export async function readPins(): Promise<PinsRead> {
  const res = await marketingDeps.fetch(PINS_PATH).catch(() => undefined)
  if (!res) return { ok: false, reason: "IRIS isn't answering right now." }
  if (res.status === 401) return { ok: false, reason: "Sign in to IRIS first: iris auth login" }
  if (res.status === 404 || res.status === 405)
    return {
      ok: false,
      notDeployed: true,
      reason: "Pins on your account aren't switched on yet. Until the next IRIS update, Desktop keeps them on each computer.",
    }
  if (!res.ok) return { ok: false, reason: "Your pins couldn't be read right now." }
  const j = (await res.json().catch(() => null)) as { data?: { value?: unknown; version?: unknown } } | null
  const version = Number(j?.data?.version)
  return { ok: true, pins: parsePins(j?.data?.value ?? EMPTY_PINS), version: Number.isInteger(version) && version >= 0 ? version : 0 }
}

/** Apply one change, against the server's current pins; if someone else saved meanwhile (409), apply it again to theirs, once. */
export async function changePins(op: PinOp): Promise<{ ok: true; pins: Pins; changed: boolean } | { ok: false; reason: string }> {
  let cur = await readPins()
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!cur.ok) return cur
    const next = applyPinOp(cur.pins, op)
    if (!next.ok) return next
    if (!next.changed) return next
    const res = await marketingDeps
      .fetch(PINS_PATH, { method: "PUT", body: JSON.stringify({ value: next.pins, version: cur.version }) })
      .catch(() => undefined)
    if (!res) return { ok: false, reason: "IRIS isn't answering right now. Nothing changed." }
    if (res.ok) {
      const j = (await res.json().catch(() => null)) as { data?: { value?: unknown } } | null
      return { ok: true, pins: parsePins(j?.data?.value ?? next.pins), changed: true }
    }
    if (res.status === 409) {
      const j = (await res.json().catch(() => null)) as { current?: { value?: unknown; version?: unknown } } | null
      cur = { ok: true, pins: parsePins(j?.current?.value ?? EMPTY_PINS), version: Number(j?.current?.version) || 0 }
      continue
    }
    if (res.status === 422) {
      const j = (await res.json().catch(() => null)) as { error?: unknown } | null
      return { ok: false, reason: typeof j?.error === "string" ? j.error : "IRIS refused that change." }
    }
    return { ok: false, reason: res.status === 401 ? "Sign in to IRIS first: iris auth login" : "Your pins couldn't be saved right now. Nothing changed." }
  }
  return { ok: false, reason: "Your pins kept changing while saving (another computer?). Nothing changed — try again." }
}

type PageRow = { slug?: string; title?: string; status?: string; visibility?: string; requires_auth?: boolean }

/** May this account pin this page? Its own pages only — the exact slug in the account's page list, as Desktop asks. */
export async function checkOwnPage(slug: string): Promise<{ ok: true; title: string; signIn: boolean; status: string } | { ok: false; reason: string }> {
  const s = slug.trim().toLowerCase()
  if (!PIN_SLUG.test(s)) return { ok: false, reason: `"${slug}" isn't a page address (like my-page).` }
  const userId = await marketingDeps.userId()
  if (!userId) return { ok: false, reason: "Sign in to IRIS first: iris auth login" }
  const res = await marketingDeps.fetch(`/api/v1/pages?user_id=${userId}&per_page=50&search=${encodeURIComponent(s)}`, {}, IRIS_API).catch(() => undefined)
  if (!res || !res.ok) return { ok: false, reason: "Your pages couldn't be read right now, so nothing was pinned." }
  const j = (await res.json().catch(() => null)) as any
  const rows: PageRow[] = Array.isArray(j?.data?.data) ? j.data.data : Array.isArray(j?.data) ? j.data : []
  const p = rows.find((r) => String(r.slug ?? "").toLowerCase() === s)
  if (!p) return { ok: false, reason: `${s} isn't one of your pages — pin a page you own or one on a board you're a member of.` }
  return { ok: true, title: String(p.title || s), signIn: needsSignIn(p), status: String(p.status ?? "draft") }
}

function printPins(p: Pins) {
  if (!p.pins.length) {
    console.log(`  ${dim("Nothing pinned yet.")}  iris marketing pins pin <slug>`)
    return
  }
  const w = Math.max(...p.pins.map((x) => x.label.length))
  p.pins.forEach((x, i) => {
    const mark = p.selected === x.slug ? success("●") : dim("·")
    console.log(`  ${mark} ${dim(String(i + 1).padStart(2))}  ${bold(x.label.padEnd(w))}  ${dim(`/p/${x.slug}`)}${x.signIn ? `  ${dim("sign-in")}` : ""}`)
  })
}

async function pinsOut(json: boolean, _title: string, r: Awaited<ReturnType<typeof changePins>>, okLine: (p: Pins) => string) {
  if (!r.ok) return fail(json, r.reason), end(json, "Nothing changed")
  if (json) return writeJson({ success: true, changed: r.changed, ...r.pins })
  printPins(r.pins)
  console.log("")
  end(json, r.changed ? okLine(r.pins) : "Already that way — nothing changed")
}

const PinsListCommand = cmd({
  command: ["list", "$0"],
  aliases: ["ls"],
  describe: "your pinned pages — the tabs in Desktop › Marketing, on every computer",
  builder: (y) => y.option("json", JSON_OPTION),
  async handler(args) {
    const json = Boolean(args.json)
    start("Pinned pages", json)
    if (!(await requireAuth())) return end(json)
    const r = await readPins()
    if (!r.ok) return fail(json, r.reason, r.notDeployed ? { not_deployed: true } : {}), end(json)
    if (json) return writeJson({ success: true, version: r.version, ...r.pins })
    printPins(r.pins)
    console.log("")
    end(json, `${r.pins.pins.length} pinned  ·  the same tabs Desktop › Marketing shows`)
  },
})

const PinCommand = cmd({
  command: "pin <slug>",
  describe: "pin one of your Genesis pages — it becomes a Marketing tab in Desktop",
  builder: (y) =>
    y
      .positional("slug", { describe: "the page's address, e.g. spring-launch", type: "string", demandOption: true })
      .option("label", { describe: "the tab's name (default: the page's title)", type: "string" })
      .option("json", JSON_OPTION),
  async handler(args) {
    const json = Boolean(args.json)
    start("Pin a page", json)
    if (!(await requireAuth())) return end(json)
    const own = await checkOwnPage(String(args.slug))
    if (!own.ok) return fail(json, own.reason), end(json, "Nothing pinned")
    const slug = String(args.slug).trim().toLowerCase()
    const r = await changePins({ op: "pin", pin: { slug, label: cleanLabel(args.label, own.title), ...(own.signIn ? { signIn: true } : {}) } })
    await pinsOut(json, "Pin", r, () => `Pinned /p/${slug}`)
  },
})

const UnpinCommand = cmd({
  command: "unpin <slug>",
  describe: "take a page off your Marketing tabs (the page itself is untouched)",
  builder: (y) => y.positional("slug", { type: "string", demandOption: true }).option("json", JSON_OPTION),
  async handler(args) {
    const json = Boolean(args.json)
    start("Unpin", json)
    if (!(await requireAuth())) return end(json)
    await pinsOut(json, "Unpin", await changePins({ op: "unpin", slug: String(args.slug) }), () => `Unpinned /p/${args.slug}`)
  },
})

const RenameCommand = cmd({
  command: "rename <slug> <label>",
  describe: "rename a Marketing tab",
  builder: (y) =>
    y.positional("slug", { type: "string", demandOption: true }).positional("label", { type: "string", demandOption: true }).option("json", JSON_OPTION),
  async handler(args) {
    const json = Boolean(args.json)
    start("Rename a tab", json)
    if (!(await requireAuth())) return end(json)
    await pinsOut(json, "Rename", await changePins({ op: "rename", slug: String(args.slug), label: String(args.label) }), () => "Renamed")
  },
})

const MoveCommand = cmd({
  command: "move <slug> <direction>",
  describe: "move a Marketing tab left or right",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true })
      .positional("direction", { choices: ["left", "right", "first", "last"] as const, demandOption: true })
      .option("json", JSON_OPTION),
  async handler(args) {
    const json = Boolean(args.json)
    start("Move a tab", json)
    if (!(await requireAuth())) return end(json)
    const by = { left: -1, right: 1, first: -1000, last: 1000 }[String(args.direction) as "left"] ?? 0
    await pinsOut(json, "Move", await changePins({ op: "move", slug: String(args.slug), by }), () => "Moved")
  },
})

const PinsCommand = cmd({
  command: "pins",
  describe: "your pinned pages — list, pin, unpin, rename, move (shared with Desktop, on your account)",
  builder: (y) => y.command(PinsListCommand).command(PinCommand).command(UnpinCommand).command(RenameCommand).command(MoveCommand),
  async handler() {},
})

// ── new ───────────────────────────────────────────────────────────────────

type Made = { ok: true; slug?: string; id?: number; name: string; url?: string; already?: boolean } | { ok: false; reason: string }

async function makeCampaign(board: number): Promise<Made> {
  const res = await marketingDeps.fetch("/api/v1/campaigns/setup", { method: "POST", body: JSON.stringify({ bloq_id: board }) }).catch(() => undefined)
  if (!res) return { ok: false, reason: "IRIS isn't answering right now. Nothing was made." }
  if (!res.ok) {
    const why =
      res.status === 401
        ? "Sign in to IRIS first: iris auth login"
        : res.status === 403
          ? "Only a board's owner, or someone who can edit the whole board, can set up campaigns on it. Nothing was made."
          : res.status === 409
            ? "This board already has campaign data its owner didn't create, so nothing was changed. Ask IRIS support to clear it."
            : "IRIS couldn't set up campaigns on this board. Nothing was made."
    return { ok: false, reason: why }
  }
  const d = ((await res.json().catch(() => null)) as any)?.data ?? {}
  const page = d.page ?? {}
  const slug = typeof page.page_slug === "string" && page.made === true ? page.page_slug.toLowerCase() : undefined
  return { ok: true, name: "Campaign review", ...(slug ? { slug } : {}), ...(page.url ? { url: page.url } : {}), already: d.created === false }
}

async function makeNamed(kind: "landing" | "brand", board: number, name: string): Promise<Made> {
  const base = slugify(name)
  if (!base) return { ok: false, reason: `Use at least one letter or number in the ${kind === "brand" ? "brand" : "page"}'s name.` }
  const userId = await marketingDeps.userId()
  if (!userId) return { ok: false, reason: "Sign in to IRIS first: iris auth login" }
  const attempt = (slug: string) =>
    kind === "landing"
      ? marketingDeps.fetch(
          "/api/v1/pages",
          {
            method: "POST",
            body: JSON.stringify({ slug, title: name, seo_title: name, owner_type: "bloq", owner_id: board, status: "draft", json_content: landingContent(slug, name) }),
          },
          IRIS_API,
        )
      : marketingDeps.fetch("/api/v1/brands", {
          method: "POST",
          body: JSON.stringify({ user_id: userId, name, slug, entity_type: "brand", bloq_id: board }),
        })
  let res = await attempt(base).catch(() => undefined)
  if (res && slugTaken(res.status, await res.clone().text().catch(() => ""))) res = await attempt(retrySlug(base, marketingDeps.suffix())).catch(() => undefined)
  if (!res) return { ok: false, reason: "IRIS isn't answering right now. Nothing was made — try again in a moment." }
  if (!res.ok) return { ok: false, reason: refusalWords(res.status, kind) }
  const j = (await res.json().catch(() => null)) as any
  const d = j?.data ?? j
  if (kind === "landing") {
    if (typeof d?.slug !== "string") return { ok: false, reason: "IRIS answered, but not with a page. Check `iris pages list` before trying again." }
    return { ok: true, slug: d.slug, id: Number(d.id) || undefined, name: String(d.title ?? name), url: pageUrl(d.slug) }
  }
  if (!Number.isFinite(Number(d?.id))) return { ok: false, reason: "IRIS answered, but not with a brand. Check `iris brand list` before trying again." }
  return { ok: true, id: Number(d.id), slug: String(d.slug ?? base), name: String(d.name ?? name) }
}

const NewCommand = cmd({
  command: "new <kind>",
  describe: "make a campaign review, a landing page or a brand kit on one of your boards — as Desktop's Marketing + does",
  builder: (y) =>
    y
      .positional("kind", { choices: ["campaign", "landing", "brand"] as const, describe: KINDS.map((k) => `${k.kind}: ${k.hint}`).join(" · "), demandOption: true })
      .option("board", { alias: "bloq", describe: "the board — id or name (see: iris marketing boards)", type: "string" })
      .option("name", { describe: "what it's called (landing page and brand kit)", type: "string" })
      .option("pin", { describe: "pin the page it makes as a Marketing tab", type: "boolean", default: true })
      .option("json", JSON_OPTION)
      .example('$0 marketing new landing --board 905 --name "Spring launch"', "a draft page on board 905, pinned")
      .example('$0 marketing new brand --board "IRIS Drives" --name "Acme Shoes"', "a brand kit on that board")
      .example("$0 marketing new campaign --board 905", "a campaign review page (same as iris campaigns setup)"),
  async handler(args) {
    const json = Boolean(args.json)
    const kind = String(args.kind) as MarketingKind
    if (!isKind(kind)) return fail(json, "Make a campaign, a landing or a brand.")
    const title = KINDS.find((k) => k.kind === kind)!.title
    start(`New ${title.toLowerCase()}`, json)
    if (!(await requireAuth())) return end(json)

    const rawBoard = String(args.board ?? "").trim()
    if (!rawBoard) return fail(json, "Say which board: --board <id or name>. Yours: iris marketing boards"), end(json)
    const userId = await marketingDeps.userId()
    if (!userId) return end(json)
    const board = /^\d+$/.test(rawBoard) ? Number(rawBoard) : await resolveBloqId(rawBoard, userId, json)
    if (!board) return end(json)

    const name = cleanName(args.name)
    if (kind !== "campaign" && !name) return fail(json, `Give it a name: --name "…"`), end(json)

    const made = kind === "campaign" ? await makeCampaign(board) : await makeNamed(kind, board, name)
    if (!made.ok) return fail(json, made.reason), end(json, "Nothing was made")

    // Desktop pins the page it makes; so does this, unless --no-pin. A brand kit isn't a page.
    let pinned: { ok: boolean; reason?: string } | undefined
    if (args.pin && made.slug && kind !== "brand") {
      // Through the same own-page check as `pins pin` — never a slug pinned on trust.
      const own = await checkOwnPage(made.slug)
      const r = own.ok
        ? await changePins({ op: "pin", pin: { slug: made.slug, label: cleanLabel(kind === "landing" ? made.name : own.title, made.slug), signIn: true } })
        : own
      pinned = r.ok ? { ok: true } : { ok: false, reason: r.reason }
    }

    if (json) return writeJson({ success: true, kind, board, ...made, ...(pinned ? { pinned: pinned.ok, ...(pinned.reason ? { pin_reason: pinned.reason } : {}) } : {}) })
    const where = made.slug ? `/p/${made.slug}` : made.id ? `#${made.id}` : ""
    console.log(`  ${success("✓")} ${bold(made.name)}  ${dim(where)}${made.already ? dim("  (already set up — nothing new)") : ""}`)
    if (made.url) console.log(`    ${dim(made.url)}`)
    if (pinned?.ok) console.log(`  ${success("✓")} pinned as a Marketing tab`)
    else if (pinned) console.log(`  ${dim("·")} not pinned: ${pinned.reason}`)
    if (kind === "landing") prompts.log.info(`It's a draft. Edit it in Desktop › Genesis, then: iris pages publish ${made.slug}`)
    if (kind === "brand") prompts.log.info(`Add its logo, colours and type: iris brand show ${made.id}  (or Desktop › Genesis › Brand kits)`)
    if (kind === "campaign") prompts.log.info(`Add ads: iris campaigns create "Spring launch" --bloq ${board}`)
    end(json, "Made")
  },
})

// ── open ──────────────────────────────────────────────────────────────────

const OpenCommand = cmd({
  command: "open <slug>",
  describe: "a signed-in link to one of your members-only pages — single use, about 90 seconds",
  builder: (y) => y.positional("slug", { type: "string", demandOption: true }).option("json", JSON_OPTION),
  async handler(args) {
    const json = Boolean(args.json)
    start("Open signed in", json)
    if (!(await requireAuth())) return end(json)
    const s = String(args.slug).trim().toLowerCase()
    if (!PIN_SLUG.test(s)) return fail(json, `"${args.slug}" isn't a page address (like my-page).`), end(json)
    const res = await marketingDeps
      .fetch("/api/v1/atlas/page-codes", { method: "POST", body: JSON.stringify({ page_slug: s }) }, IRIS_API)
      .catch(() => undefined)
    const body = res ? ((await res.json().catch(() => null)) as any) : null
    const code = typeof body?.code === "string" && /^[A-Za-z0-9_-]{43}$/.test(body.code) ? body.code : ""
    if (!res || !res.ok || !code) {
      const why = !res
        ? "IRIS isn't answering right now."
        : res.status === 401
          ? "Sign in to IRIS first: iris auth login"
          : res.status === 404
            ? "That page isn't published, or isn't yours."
            : "IRIS couldn't make a signed-in link for that page."
      return fail(json, why), end(json)
    }
    // Built from the slug asked for, never from the server's answer — the link only ever opens that page.
    const url = `${PAGE_ORIGIN}/p/${encodeURIComponent(s)}#atlas_code=${code}`
    if (json) return writeJson({ success: true, url, expires_in: typeof body.expires_in === "number" ? body.expires_in : null })
    console.log(`  ${url}`)
    console.log("")
    end(json, "Open it within about 90 seconds; it works once")
  },
})

// ── root ──────────────────────────────────────────────────────────────────

const OverviewCommand = cmd({
  command: "$0",
  describe: "your pinned pages, and how to make something",
  builder: (y) => y.option("json", JSON_OPTION),
  async handler(args) {
    const json = Boolean(args.json)
    start("Marketing", json)
    if (!(await requireAuth())) return end(json)
    const pins = await readPins()
    if (json) return writeJson({ success: true, pins: pins.ok ? pins.pins : null, ...(pins.ok ? {} : { pins_reason: pins.reason }), kinds: KINDS })
    console.log(bold("  Pinned pages"))
    if (pins.ok) printPins(pins.pins)
    else console.log(`  ${dim(pins.reason)}`)
    console.log("")
    console.log(bold("  Make something"))
    for (const k of KINDS) console.log(`  ${k.title.padEnd(16)} ${dim(k.hint)}`)
    console.log("")
    end(json, `iris marketing boards  →  iris marketing new <campaign|landing|brand> --board <id>`)
  },
})

export const PlatformMarketingCommand = cmd({
  command: "marketing",
  describe: "Desktop › Marketing from the terminal — boards, make a campaign review / landing page / brand kit, your pinned pages",
  builder: (yargs) =>
    yargs
      .command(OverviewCommand)
      .command(BoardsCommand)
      .command(NewCommand)
      .command(PinsCommand)
      .command(OpenCommand)
      .epilogue(
        "Pins live on your IRIS account: the same tabs in Desktop › Marketing on every computer.\n" +
          "Reviewing ads stays `iris campaigns` (approve | reject | request-changes).",
      ),
  async handler() {},
})
