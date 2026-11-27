/**
 * `iris pages app "<name>"` — your own app over your own IRIS data, in one step (#194355, epic
 * #194350). The engine behind "Make it an app": an agent, IRIS Desktop or a person runs ONE
 * command and gets a published page bound to their data, with buttons, its own name and icon, and
 * a shortcut in their Start menu / Dock / launcher.
 *
 * Everything it writes is what the build-your-own-app playbook and how-to describe by hand; this
 * only removes the hand-editing. Kristen's console (#189085) was the same request answered with a
 * local server — this is the answer that should have come back.
 */
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, dim, writeJson } from "./iris-api"
import { createPageFromJson } from "./platform-pages"
import { PagesInstallCmd } from "./platform-pages-edge"
import { AGENTS_HTML, APP_CSS, LIST_HTML } from "./edge/app-templates"

const APPS_BOARD = "My Apps"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

/** "Open Leads" → "open-leads-k3x9": readable, and two apps with one name never collide. */
export function appSlug(name: string, rand = Math.random().toString(36).slice(2, 6)): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app"
  return `${base}-${rand}`
}

/** The label under the icon: ≤ 12 characters, cut at a word. */
export function shortLabel(name: string): string {
  const n = name.trim()
  if (n.length <= 12) return n
  const words = n.split(/\s+/)
  let out = ""
  for (const w of words) {
    if ((out ? out + " " + w : w).length > 12) break
    out = out ? out + " " + w : w
  }
  return out || n.slice(0, 12)
}

/**
 * The page an app is made of. `show` is "agents" (pause/resume built in), a dataset slug, or a
 * collection address ("leads:all"). Pure, so it is tested without the network.
 */
export function buildAppContent(name: string, show: string, what?: string): Record<string, unknown> {
  const isAgents = show === "agents"
  const describe =
    what?.trim() ||
    (isAgents
      ? "Every agent you run on IRIS in one window: what each one is doing, which ones need you, and a button to pause or resume any of them."
      : `Your ${name.toLowerCase()} in one window, always up to date.`)
  const fill = (h: string) => h.split("{{NAME}}").join(esc(name)).split("{{WHAT}}").join(esc(describe))
  return {
    version: "2.0",
    type: "article",
    render_mode: "html",
    html: fill(isAgents ? AGENTS_HTML : LIST_HTML),
    css: APP_CSS,
    bindings: isAgents ? { agents: "agents:all", beats: "heartbeat:all" } : { items: show },
    ...(isAgents ? { actions: { status: { run: "agent-settings:personality", roles: ["admin"], fields: ["status"] } } } : {}),
    app: { name, short_name: shortLabel(name), theme_color: "#0f7a5c", background_color: "#131312" },
    theme: { branding: { name } },
  }
}

/** The board apps live on: "My Apps", made the first time. Never a client's board. */
async function appsBoard(userId: number): Promise<number | null> {
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs?simplified=1&per_page=500`)
  if (res.ok) {
    const rows = (((await res.json()) as any)?.data ?? []) as { id: number; name?: string }[]
    const mine = rows.find((b) => String(b.name ?? "").trim().toLowerCase() === APPS_BOARD.toLowerCase())
    if (mine) return mine.id
  }
  const made = await irisFetch(`/api/v1/user/${userId}/bloqs`, {
    method: "POST",
    body: JSON.stringify({ name: APPS_BOARD, description: "Apps you made for yourself." }),
  })
  if (!made.ok) return null
  const d = (await made.json()) as any
  return Number(d?.data?.bloq?.id ?? d?.data?.id ?? d?.id) || null
}

export const PagesAppCmd = cmd({
  command: "app <name>",
  describe:
    "make me an app — a dashboard or tool over your own IRIS data (your agents, leads, a dataset) with buttons, its own icon, in your Start menu or Dock. One step.",
  builder: (y) =>
    y
      .positional("name", { type: "string", demandOption: true, describe: 'what to call it, e.g. "My Command Center"' })
      .option("show", { type: "string", default: "agents", describe: 'what it shows: "agents" (with pause/resume), a dataset slug, or a collection like "leads:all"' })
      .option("about", { type: "string", describe: "one line on what it is for (shown before sign-in)" })
      .option("no-install", { type: "boolean", default: false, describe: "publish it, but do not add it to the Start menu / Dock" })
      .option("json", { type: "boolean", default: false })
      .example('iris pages app "My Command Center"', "your agents, with pause and resume, in your Start menu or Dock")
      .example('iris pages app "Open Leads" --show leads:all', "any of your data as an app"),
  async handler(args) {
    const json = Boolean(args.json)
    if (!(await requireAuth())) return
    const userId = await requireUserId()
    if (!userId) return
    const name = String(args.name).trim().slice(0, 80)
    const show = String(args.show || "agents").trim()
    if (!name) return fail("Give the app a name.", "name")
    if (show !== "agents" && !/^[A-Za-z0-9_.:-]{1,120}$/.test(show)) return fail(`"${show}" is not a dataset or collection.`, "show")

    const sp = json ? null : prompts.spinner()
    sp?.start(`Making ${name}…`)
    const board = await appsBoard(userId)
    if (!board) {
      sp?.stop("Not made")
      return fail(`Could not find or make your "${APPS_BOARD}" board.`, "board")
    }
    const slug = appSlug(name)
    const page = await createPageFromJson({
      slug,
      title: name,
      owner_type: "bloq",
      owner_id: board,
      json_content: buildAppContent(name, show, args.about as string | undefined),
      publish: true,
    })
    if (!page?.id) {
      sp?.stop("Not made")
      return fail("IRIS did not save the app. Try again in a moment.", "create")
    }
    const url = `https://heyiris.io/p/${slug}`
    sp?.stop(`${name} is ready`)

    // --json is for a caller (IRIS Desktop, an agent): one JSON answer, and it runs the install
    // step itself — the install prints its own result, which would corrupt this one.
    if (json) return writeJson({ ok: true, name, slug, url, board, install: `iris pages install ${slug}` })
    if (!args["no-install"]) {
      // The same command a person would run; it prints where the shortcut went.
      await PagesInstallCmd.handler({ slug, local: false, remove: false, json: false, _: [], $0: "iris" } as any)
    }
    UI.println(`  ${url}`)
    UI.println(dim(`  only you see your data on it · change it: iris pages pull ${slug} · run it on this computer: iris pages serve ${slug}`))

    function fail(msg: string, reason: string) {
      if (json) writeJson({ ok: false, reason, detail: msg })
      else UI.error(msg)
      process.exitCode = 1
    }
  },
})
