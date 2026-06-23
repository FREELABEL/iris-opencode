import { readFileSync } from "node:fs"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, FL_API } from "./iris-api"
import { getBySlug, createPageFromJson } from "./platform-pages"
import { profileFromBrand, rebrandJsonContent } from "./rebrand"

function pagesFetch(path: string, opts?: RequestInit) {
  return irisFetch(path, opts, FL_API)
}

// Resolve a site by numeric id or slug. Returns the full site record (with pages).
async function resolveSite(idOrSlug: string): Promise<any | null> {
  if (/^\d+$/.test(idOrSlug)) {
    const res = await pagesFetch(`/api/v1/sites/${idOrSlug}`)
    if (!res.ok) return null
    return ((await res.json()) as any).data ?? null
  }
  const listRes = await pagesFetch("/api/v1/sites?per_page=100")
  if (!listRes.ok) return null
  const sites: any[] = ((await listRes.json()) as any).data ?? []
  const match = sites.find((s) => s.slug === idOrSlug)
  if (!match) return null
  const res = await pagesFetch(`/api/v1/sites/${match.id}`)
  if (!res.ok) return match
  return ((await res.json()) as any).data ?? match
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
// Create — make a new site
// ============================================================================

const CreateCmd = cmd({
  command: "create <name>",
  describe: "create a site (grouping container with a shared nav)",
  builder: (y) =>
    y.positional("name", { type: "string", demandOption: true })
      .option("slug", { type: "string", describe: "url slug (defaults to slugified name)" })
      .option("owner-type", { type: "string", default: "user", describe: "user | bloq | system" })
      .option("owner-id", { type: "number", describe: "owner id (for user/bloq-owned sites)" })
      .option("status", { type: "string", default: "draft", describe: "draft | published | archived" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Create Site: ${args.name}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Creating…")

    const slug =
      (args.slug as string) ||
      String(args.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    const payload: Record<string, unknown> = {
      name: args.name,
      slug,
      owner_type: args["owner-type"],
      status: args.status,
    }
    if (args["owner-id"] !== undefined) payload.owner_id = args["owner-id"]

    const res = await pagesFetch("/api/v1/sites", { method: "POST", body: JSON.stringify(payload) })
    if (!(await handleApiError(res, "Create site"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
    const site = ((await res.json()) as any).data ?? {}
    sp.stop(success(`Created site #${site.id}`))

    if (args.json) { console.log(JSON.stringify(site, null, 2)); prompts.outro("Done"); return }
    printDivider()
    printKV("ID", site.id)
    printKV("Name", site.name)
    printKV("Slug", site.slug)
    printDivider()
    prompts.outro(dim(`iris sites attach ${site.id} <pageId>`))
  },
})

// ============================================================================
// Attach / Detach — page ↔ site membership
// ============================================================================

const AttachCmd = cmd({
  command: "attach <site> <page>",
  describe: "attach a page to a site (sets site_id, sort order, home page)",
  builder: (y) =>
    y.positional("site", { type: "number", demandOption: true })
      .positional("page", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Attach page #${args.page} → site #${args.site}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Attaching…")
    const res = await pagesFetch(`/api/v1/sites/${args.site}/pages/${args.page}`, { method: "POST" })
    if (!(await handleApiError(res, "Attach page"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
    const site = ((await res.json()) as any).data ?? {}
    sp.stop(success(`Attached — ${site.pages?.length ?? "?"} page(s) on site`))
    prompts.outro(dim(`iris sites nav ${args.site}`))
  },
})

const DetachCmd = cmd({
  command: "detach <site> <page>",
  describe: "detach a page from a site",
  builder: (y) =>
    y.positional("site", { type: "number", demandOption: true })
      .positional("page", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Detach page #${args.page} ✕ site #${args.site}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Detaching…")
    const res = await pagesFetch(`/api/v1/sites/${args.site}/pages/${args.page}`, { method: "DELETE" })
    if (!(await handleApiError(res, "Detach page"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
    sp.stop(success("Detached"))
    prompts.outro("Done")
  },
})

// ============================================================================
// Nav — view / edit the site's shared dashboard sidebar nav (nav_items)
// ============================================================================

const NavCmd = cmd({
  command: "nav <id>",
  describe: "view or edit a site's shared dashboard sidebar nav (nav_items)",
  builder: (y) =>
    y.positional("id", { type: "number", demandOption: true })
      .option("set", { type: "string", describe: "path to a JSON file: array of {label,url|href,icon,group?}" })
      .option("add", { type: "string", describe: "JSON for a single nav item to append" })
      .option("remove", { type: "string", describe: "remove a nav item by label or index" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Site #${args.id} Nav`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()

    sp.start("Loading…")
    const getRes = await pagesFetch(`/api/v1/sites/${args.id}`)
    if (!(await handleApiError(getRes, "Get site"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
    const site = ((await getRes.json()) as any).data ?? {}
    let navItems: any[] = Array.isArray(site.nav_items) ? site.nav_items : []

    const isEdit = args.set || args.add || args.remove !== undefined
    if (!isEdit) {
      sp.stop(`${navItems.length} item(s)`)
      if (args.json) { console.log(JSON.stringify(navItems, null, 2)); prompts.outro("Done"); return }
      printDivider()
      if (!navItems.length) console.log(dim("  (none)"))
      navItems.forEach((it, i) =>
        console.log(
          `  ${dim(String(i))}  ${bold(it.label ?? "?")}  ${dim(it.url || it.href || "")}` +
          `${it.icon ? "  " + dim(it.icon) : ""}${it.group ? dim(`  [${it.group}]`) : ""}`,
        ),
      )
      printDivider()
      prompts.outro(dim(`iris sites nav ${args.id} --set nav.json`))
      return
    }

    sp.start("Updating…")
    try {
      if (args.set) {
        const parsed = JSON.parse(readFileSync(String(args.set), "utf8"))
        if (!Array.isArray(parsed)) throw new Error("--set file must contain a JSON array")
        navItems = parsed
      }
      if (args.add) {
        navItems.push(JSON.parse(String(args.add)))
      }
      if (args.remove !== undefined) {
        const rem = String(args.remove)
        const idx = /^\d+$/.test(rem) ? Number(rem) : navItems.findIndex((it) => it.label === rem)
        if (idx < 0 || idx >= navItems.length) throw new Error(`No nav item matching "${rem}"`)
        navItems.splice(idx, 1)
      }
    } catch (err) {
      sp.stop(`Invalid input: ${err instanceof Error ? err.message : String(err)}`, 1)
      prompts.outro("Done")
      return
    }

    const putRes = await pagesFetch(`/api/v1/sites/${args.id}`, {
      method: "PUT",
      body: JSON.stringify({ nav_items: navItems }),
    })
    if (!(await handleApiError(putRes, "Update nav"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
    sp.stop(success(`Saved ${navItems.length} item(s) — member pages purged`))
    if (args.json) console.log(JSON.stringify(navItems, null, 2))
    prompts.outro("Done")
  },
})

// ============================================================================
// Clone — duplicate a whole site's pages, rebranded from a brand profile
// ============================================================================

const CloneCmd = cmd({
  command: "clone <source>",
  describe: "clone a site's pages, rebranded from a brand profile (PII safety gate)",
  builder: (y) =>
    y.positional("source", { type: "string", demandOption: true, describe: "source site id or slug" })
      .option("as", { type: "string", demandOption: true, describe: "new site slug (also the page-slug prefix)" })
      .option("brand", { type: "string", demandOption: true, describe: "brand slug whose profile to apply" })
      .option("name", { type: "string", describe: "new site name (defaults to brand name)" })
      .option("owner-type", { type: "string" })
      .option("owner-id", { type: "number" })
      .option("publish", { type: "boolean", default: false })
      .option("force", { type: "boolean", default: false, describe: "proceed even if PII leaks are detected" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Clone site ${args.source} → ${args.as}  ${dim(`(brand: ${args.brand})`)}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Loading source site + brand…")
    try {
      const sourceSite = await resolveSite(String(args.source))
      if (!sourceSite) { sp.stop("Source site not found", 1); prompts.outro("Done"); return }
      const pages: any[] = sourceSite.pages ?? []
      if (!pages.length) { sp.stop("Source site has no pages", 1); prompts.outro("Done"); return }

      let target
      try { target = await profileFromBrand(String(args.brand)) }
      catch (e) { sp.stop("Brand not found", 1); prompts.log.error(e instanceof Error ? e.message : String(e)); prompts.outro("Done"); return }

      // Dry rebrand every page first, collect leaks across the whole site.
      sp.message(`Rebranding ${pages.length} page(s)…`)
      const srcPrefix = String(sourceSite.slug ?? "")
      const items: Array<{ src: any; json: any; leaks: any[]; newSlug: string }> = []
      for (const pg of pages) {
        const full = await getBySlug(pg.slug, true)
        if (!full?.json_content) continue
        const { json, leaks } = rebrandJsonContent(full.json_content, target)
        const newSlug =
          srcPrefix && pg.slug.startsWith(srcPrefix)
            ? `${args.as}${pg.slug.slice(srcPrefix.length)}`
            : `${args.as}-${pg.slug}`
        items.push({ src: full, json, leaks, newSlug })
      }
      const allLeaks = items.flatMap((it) => it.leaks.map((l) => ({ ...l, page: it.src.slug })))
      sp.stop(allLeaks.length ? `${allLeaks.length} possible leak(s)` : success(`${items.length} page(s) rebranded — clean`))

      // --- Safety gate (whole-site) ---
      if (allLeaks.length && !args.force) {
        printDivider()
        for (const l of allLeaks) console.log(`  ${UI.Style.TEXT_WARNING}⚠${UI.Style.TEXT_NORMAL}  ${bold(l.needle)}  ${dim(`${l.page} · ${l.path}`)}`)
        printDivider()
        prompts.log.warn(`Source client data survived. Populate brand "${args.brand}" profile (iris brands profile set) then retry — or pass --force.`)
        prompts.outro("Blocked — nothing created"); return
      }
      if (allLeaks.length) prompts.log.warn("--force set: cloning despite leaks")

      // Create the new site.
      const sp2 = prompts.spinner()
      sp2.start("Creating site…")
      const ownerType = (args["owner-type"] as string) ?? sourceSite.owner_type ?? "user"
      const ownerId = (args["owner-id"] as number) ?? sourceSite.owner_id
      const sitePayload: Record<string, unknown> = {
        name: (args.name as string) ?? target.name ?? args.as,
        slug: args.as,
        owner_type: ownerType,
        status: "draft",
      }
      if (ownerId != null) sitePayload.owner_id = ownerId
      const siteRes = await pagesFetch("/api/v1/sites", { method: "POST", body: JSON.stringify(sitePayload) })
      if (!(await handleApiError(siteRes, "Create site"))) { sp2.stop("Failed", 1); prompts.outro("Done"); return }
      const newSite = ((await siteRes.json()) as any).data ?? {}

      // Clone + attach each page.
      const created: Array<{ slug: string; id: number }> = []
      for (const it of items) {
        sp2.message(`Cloning ${it.newSlug}…`)
        const p = await createPageFromJson({
          slug: it.newSlug,
          title: it.src.title,
          seo_title: it.json.seo_title,
          seo_description: it.json.seo_description,
          og_image: it.src.og_image,
          owner_type: ownerType,
          owner_id: ownerId,
          json_content: it.json,
          publish: !!args.publish,
        })
        if (p?.id) {
          await pagesFetch(`/api/v1/sites/${newSite.id}/pages/${p.id}`, { method: "POST" }).catch(() => {})
          created.push({ slug: it.newSlug, id: p.id })
        }
      }
      sp2.stop(success(`Cloned ${created.length} page(s) → site #${newSite.id}`))

      printDivider()
      printKV("Site", `#${newSite.id}  ${newSite.slug}`)
      printKV("Brand", args.brand)
      printKV("Pages", created.map((c) => c.slug).join(", ") || dim("none"))
      printKV("Leaks", allLeaks.length === 0 ? success("none") : `${allLeaks.length} (forced)`)
      printDivider()
      prompts.outro(args.publish ? success("Published") : dim(`iris pages publish <slug>  (per page)`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Root
// ============================================================================

export const PlatformSitesCommand = cmd({
  command: "sites",
  describe: "manage Genesis sites — list, show, create, attach, nav, settings",
  builder: (y) =>
    y
      .command(ListCmd)
      .command(ShowCmd)
      .command(CreateCmd)
      .command(CloneCmd)
      .command(AttachCmd)
      .command(DetachCmd)
      .command(NavCmd)
      .command(ConfigCmd)
      .demandCommand(),
  async handler() {},
})
