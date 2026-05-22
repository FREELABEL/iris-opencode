import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"

const FL_API = "fl-api"

function pagesFetch(path: string, opts?: RequestInit) {
  return irisFetch(path, opts, FL_API)
}

// ============================================================================
// List — show all sites
// ============================================================================

const ListCmd = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list all sites",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Sites")
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Loading…")
    try {
      const res = await pagesFetch("/api/v1/sites?per_page=50")
      if (!(await handleApiError(res, "List sites"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const sites = body.data ?? []
      sp.stop(`${sites.length} site(s)`)

      if (args.json) {
        console.log(JSON.stringify(sites, null, 2))
        prompts.outro("Done")
        return
      }

      printDivider()
      for (const s of sites) {
        console.log(`  ${bold(s.name)}  ${dim(`#${s.id}`)}  ${dim(s.slug)}  ${dim(s.status)}  ${dim(`${s.pages_count ?? "?"} pages`)}`)
      }
      printDivider()
      prompts.outro(dim("iris sites show <id>"))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Show — site details
// ============================================================================

const ShowCmd = cmd({
  command: "show <id>",
  describe: "show site details + settings",
  builder: (y) =>
    y.positional("id", { type: "number", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Site #${args.id}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Loading…")
    try {
      const res = await pagesFetch(`/api/v1/sites/${args.id}`)
      if (!(await handleApiError(res, "Show site"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const site = body.data ?? body
      sp.stop(String(site.name))

      if (args.json) {
        console.log(JSON.stringify(site, null, 2))
        prompts.outro("Done")
        return
      }

      printDivider()
      printKV("ID", site.id)
      printKV("Name", site.name)
      printKV("Slug", site.slug)
      printKV("Status", site.status)
      printKV("Owner", `${site.owner_type}:${site.owner_id ?? "null"}`)
      printKV("Pages", site.pages?.length ?? site.pages_count ?? 0)

      const settings = site.settings ?? {}
      const emails = settings.notification_emails ?? []
      printKV("Notification Emails", emails.length ? emails.join(", ") : dim("none"))

      if (site.pages?.length) {
        console.log()
        console.log(`  ${bold("Pages")}`)
        for (const p of site.pages) {
          console.log(`    ${dim(`#${p.id}`)} ${p.title ?? p.slug}  ${dim(p.status)}`)
        }
      }
      printDivider()
      prompts.outro(dim(`iris sites config ${args.id}`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Config — view or update site settings
// ============================================================================

const ConfigCmd = cmd({
  command: "config <id>",
  describe: "view or update site settings (notification emails, etc.)",
  builder: (y) =>
    y.positional("id", { type: "number", demandOption: true })
      .option("notification-emails", { type: "string", describe: "comma-separated email list" })
      .option("clear-notification-emails", { type: "boolean", default: false, describe: "remove all notification emails" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Site #${args.id} Settings`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()

    const isUpdate = args["notification-emails"] || args["clear-notification-emails"]

    if (isUpdate) {
      sp.start("Updating…")
      const emails = args["clear-notification-emails"]
        ? []
        : (args["notification-emails"] ?? "").split(",").map((e: string) => e.trim()).filter(Boolean)

      const res = await pagesFetch(`/api/v1/sites/${args.id}/settings`, {
        method: "PATCH",
        body: JSON.stringify({ notification_emails: emails }),
      })
      if (!(await handleApiError(res, "Update settings"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const settings = body.data ?? body
      sp.stop(success("Updated"))

      if (args.json) {
        console.log(JSON.stringify(settings, null, 2))
      } else {
        printDivider()
        const ne = settings.notification_emails ?? []
        printKV("Notification Emails", ne.length ? ne.join(", ") : dim("none"))
        printDivider()
      }
    } else {
      sp.start("Loading…")
      const res = await pagesFetch(`/api/v1/sites/${args.id}/settings`)
      if (!(await handleApiError(res, "Get settings"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const settings = body.data ?? body
      sp.stop("Settings")

      if (args.json) {
        console.log(JSON.stringify(settings, null, 2))
      } else {
        printDivider()
        const ne = settings.notification_emails ?? []
        printKV("Notification Emails", ne.length ? ne.join(", ") : dim("none"))
        // Show all other settings
        for (const [key, val] of Object.entries(settings)) {
          if (key === "notification_emails") continue
          printKV(key, JSON.stringify(val))
        }
        printDivider()
      }
    }

    prompts.outro("Done")
  },
})

// ============================================================================
// Root
// ============================================================================

export const PlatformSitesCommand = cmd({
  command: "sites",
  describe: "manage Genesis sites — list, show, settings",
  builder: (y) =>
    y
      .command(ListCmd)
      .command(ShowCmd)
      .command(ConfigCmd)
      .demandCommand(),
  async handler() {},
})
