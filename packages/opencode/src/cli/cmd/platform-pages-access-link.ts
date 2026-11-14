import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printKV, dim, bold, writeJson } from "./iris-api"
import { getBySlug } from "./platform-pages"

// ============================================================================
// iris pages access-link — a personal sign-in link for a gated page (#192508)
//
// Lets ONE named person who already has a role on the page's board open it without the emailed
// code. The server spends the link on first open and swaps it for that person's ordinary session,
// so it cannot be reused from a forwarded message or browser history. A link replaces the code,
// never the role — the server refuses an address with no role.
// ============================================================================

export const MAX_HOURS = 168

/** "24h", "3d", "90m" (rounded up to an hour), or a bare number of hours. Null when unreadable. */
export function parseExpiryHours(v: string | undefined): number | null {
  if (v === undefined || v === "") return 24
  const m = String(v).trim().toLowerCase().match(/^(\d+)\s*(m|h|d|w)?$/)
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2] ?? "h"
  const hours = unit === "m" ? Math.ceil(n / 60) : unit === "h" ? n : unit === "d" ? n * 24 : n * 24 * 7
  if (!Number.isFinite(hours) || hours < 1 || hours > MAX_HOURS) return null
  return hours
}

const AccessLinkCmd = cmd({
  command: "access-link <slug>",
  describe: "a personal sign-in link: one named person opens this gated page without the emailed code",
  builder: (y) =>
    y
      .positional("slug", { describe: "gated page slug", type: "string", demandOption: true })
      .option("email", { describe: "the person — must already have a role on the page's board", type: "string", demandOption: true })
      .option("expires", { describe: "how long it can be opened: 1h–7d (default 24h)", type: "string" })
      .option("label", { describe: "a note for access-link:list", type: "string" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const isJson = args.json === true
    if (!isJson) { UI.empty(); prompts.intro(`◈  Sign-in link: ${args.slug}`) }
    if (!(await requireAuth())) { if (!isJson) prompts.outro("Done"); return }

    const hours = parseExpiryHours(args.expires as string | undefined)
    if (hours === null) {
      prompts.log.error(`--expires must be between 1h and ${MAX_HOURS / 24}d (e.g. 24h, 3d)`)
      process.exitCode = 1
      if (!isJson) prompts.outro("Nothing issued")
      return
    }

    const res = await irisFetch(`/api/v1/atlas/access-links`, {
      method: "POST",
      body: JSON.stringify({ email: args.email, page_slug: args.slug, expires_hours: hours, label: args.label }),
    })
    if (!(await handleApiError(res, "Issue sign-in link"))) { process.exitCode = 1; if (!isJson) prompts.outro("Nothing issued"); return }
    const data = ((await res.json().catch(() => ({}))) as any)?.data ?? {}
    if (isJson) { await writeJson(data); return }

    printKV("For", `${data.email} (${data.role})`)
    printKV("Opens", "once — then it is their normal sign-in for 30 days")
    printKV("Expires", String(data.expires_at ?? `${hours}h`))
    console.log()
    console.log(`  ${bold(String(data.url ?? ""))}`)
    console.log()
    prompts.log.warn(
      `Shown once. Send it only to ${data.email}: whoever opens it first is signed in as them.\n` +
        `Revoke: iris pages access-link:revoke ${data.id}`,
    )
    prompts.outro("Done")
  },
})

const AccessLinkListCmd = cmd({
  command: "access-link:list <slug>",
  aliases: ["access-links"],
  describe: "sign-in links issued for the page's board — who, state (open/used/expired/revoked), never the link itself",
  builder: (y) => y.positional("slug", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    const isJson = args.json === true
    if (!isJson) { UI.empty(); prompts.intro(`◈  Sign-in links: ${args.slug}`) }
    if (!(await requireAuth())) { if (!isJson) prompts.outro("Done"); return }
    const page = await getBySlug(String(args.slug), false, { quiet404: true }).catch(() => null)
    if (!page || page.owner_type !== "bloq") {
      prompts.log.error("Page not found, or not owned by a board.")
      process.exitCode = 1
      if (!isJson) prompts.outro("Done")
      return
    }
    const res = await irisFetch(`/api/v1/atlas/access-links?bloq_id=${encodeURIComponent(String(page.owner_id))}`)
    if (!(await handleApiError(res, "List sign-in links"))) { process.exitCode = 1; if (!isJson) prompts.outro("Done"); return }
    const rows: any[] = ((await res.json().catch(() => ({}))) as any)?.data ?? []
    if (isJson) { await writeJson(rows); return }
    if (!rows.length) { prompts.outro("No links issued"); return }
    for (const r of rows) {
      console.log(`  ${String(r.id).padEnd(6)} ${String(r.state).padEnd(8)} ${String(r.email).padEnd(40)} ${dim(String(r.expires_at ?? ""))} ${dim(r.label ?? "")}`)
    }
    prompts.outro("Done")
  },
})

const AccessLinkRevokeCmd = cmd({
  command: "access-link:revoke <id>",
  describe: "stop a sign-in link from working (a session it already created is not ended)",
  builder: (y) => y.positional("id", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Revoke sign-in link #${args.id}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/atlas/access-links/${encodeURIComponent(String(args.id))}`, { method: "DELETE" })
    if (!(await handleApiError(res, "Revoke sign-in link"))) { process.exitCode = 1; prompts.outro("Nothing changed"); return }
    prompts.outro("Revoked — the link no longer opens anything")
  },
})

export { AccessLinkCmd, AccessLinkListCmd, AccessLinkRevokeCmd }
