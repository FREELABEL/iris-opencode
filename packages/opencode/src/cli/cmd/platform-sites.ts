import { readFileSync } from "node:fs"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, warn, FL_API, writeJson, emitJsonError } from "./iris-api"
import { getBySlug, createPageFromJson } from "./platform-pages"
import { profileFromBrand, rebrandJsonContent } from "./rebrand"
import { firstArray } from "../../util/array"
import {
  buildReport,
  describeList,
  flagList,
  hasList,
  mergeGate,
  readGate,
  sameGate,
  type PageInput,
  type SiteReport,
} from "./platform-sites-access-model"

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
  const sites: any[] = firstArray(((await listRes.json()) as any).data)
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
        await writeJson(sites)
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
        await writeJson(site)
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
        await writeJson(settings)
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
        await writeJson(settings)
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

    if (args.json) { await writeJson(site); prompts.outro("Done"); return }
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
      if (args.json) { await writeJson(navItems); prompts.outro("Done"); return }
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
    if (args.json) await writeJson(navItems)
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
      const pages: any[] = firstArray(sourceSite.pages)
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
// Inbox — contact-form enquiries for a site (#178203)
// ============================================================================

function contactOf(s: any): string {
  return s.email || s.user_email || s.phone || s.user_phone || "—"
}

// store() JSON-encodes extra form fields into `content`; render it readably.
function bodyOf(s: any): string {
  const raw = String(s.content ?? "")
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.entries(parsed)
        .filter(([, v]) => v !== null && v !== "" && typeof v !== "object")
        .map(([k, v]) => `${k}: ${v}`)
        .join(" · ")
    }
  } catch { /* plain text body */ }
  return raw
}

function whenOf(iso?: string | null): string {
  if (!iso) return ""
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

const InboxCmd = cmd({
  command: "inbox <site>",
  describe: "read contact-form enquiries for a site (--thread for the full comms thread)",
  builder: (y) =>
    y
      .positional("site", { describe: "site id or slug", type: "string", demandOption: true })
      .option("thread", { describe: "show the comms thread (inbound + replies) instead of raw submissions", type: "boolean", default: false })
      .option("limit", { describe: "max rows", type: "number", default: 25 })
      .option("search", { describe: "filter by name, email or body", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const asJson = args.json as boolean
    if (!asJson) prompts.intro("◈  Site Inbox")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = asJson ? null : prompts.spinner()
    sp?.start("Resolving site…")

    const site = await resolveSite(String(args.site))
    if (!site) {
      sp?.stop("Not found", 1)
      prompts.log.error(`No site matched "${args.site}".`)
      prompts.outro("Done")
      return
    }

    const params = new URLSearchParams({ per_page: String(args.limit) })
    if (args.search) params.set("search", String(args.search))

    const path = args.thread
      ? `/api/v1/sites/${site.id}/comms?per_page=${args.limit}`
      : `/api/v1/sites/${site.id}/submissions?${params}`

    sp?.start(args.thread ? "Loading thread…" : "Loading enquiries…")
    const res = await pagesFetch(path)

    if (!res.ok) {
      sp?.stop("Failed", 1)
      // 403 here means the signed-in user does not own this site — say so plainly rather
      // than printing an empty inbox, which reads as "no enquiries".
      if (res.status === 403) prompts.log.error("You do not have access to this site's inbox.")
      else await handleApiError(res, "Site inbox")
      prompts.outro("Done")
      return
    }

    const body = (await res.json()) as any
    const rows: any[] = firstArray(body.data)
    const total = body.meta?.total ?? rows.length

    if (asJson) {
      await writeJson({ site: { id: site.id, name: site.name, slug: site.slug }, total, rows })
      return
    }

    sp?.stop(`${total} ${args.thread ? "message(s)" : "enquiry(ies)"} — ${bold(String(site.name ?? site.slug))}`)
    printDivider()

    if (!rows.length) {
      // An empty THREAD is not the same as an empty inbox: only submissions received after
      // the comms mirror shipped are threaded, so a site with years of enquiries shows zero
      // messages. Say that plainly instead of printing "nothing yet", which reads as
      // "nobody has ever contacted you".
      if (args.thread) {
        let priorCount = 0
        try {
          const subs = await pagesFetch(`/api/v1/sites/${site.id}/submissions?per_page=1`)
          if (subs.ok) priorCount = ((await subs.json()) as any).meta?.total ?? 0
        } catch { /* best effort — the notice below still stands */ }

        if (priorCount > 0) {
          console.log(dim(`  No threaded messages yet — but this site has ${bold(String(priorCount))}${dim(" submission(s).")}`))
          console.log(dim("  Only enquiries received after the comms mirror shipped are threaded;"))
          console.log(dim("  earlier ones are not backfilled yet."))
          console.log()
          console.log(dim(`  See them with: iris sites inbox ${args.site}`))
        } else {
          console.log(dim("  No messages yet."))
        }
      } else {
        console.log(dim("  Nothing yet."))
        console.log()
        console.log(dim(`  Public intake: POST /v1/public/form/submissions with page_id from this site.`))
      }
      prompts.outro("Done")
      return
    }

    for (const r of rows) {
      if (args.thread) {
        const inbound = r.direction === "inbound"
        const arrow = inbound ? "\x1b[36m←\x1b[0m" : "\x1b[32m→\x1b[0m"
        const who = inbound ? (r.from_identifier ?? "—") : (Array.isArray(r.to_identifiers) ? r.to_identifiers[0] : "—")
        console.log(`  ${arrow} ${bold(String(who))}  ${dim(`${r.channel} · ${whenOf(r.sent_at)}`)}`)
        if (r.subject) console.log(`      ${dim(String(r.subject))}`)
        console.log(`      ${String(r.body ?? "").split("\n").join("\n      ").slice(0, 400)}`)
        console.log()
      } else {
        console.log(`  ${dim(`#${r.id}`)}  ${bold(String(r.user_name || "—"))}  ${highlight(contactOf(r))}  ${dim(whenOf(r.created_at))}`)
        const preview = bodyOf(r)
        if (preview) console.log(`      ${dim(preview.slice(0, 220))}`)
        if (r.page?.title) console.log(`      ${dim(`via ${r.page.title}`)}`)
        console.log()
      }
    }

    console.log(dim(`  iris sites inbox ${args.site} --thread   ·   iris sites reply ${args.site} <submission-id> "<message>"`))
    prompts.outro("Done")
  },
})

const ReplyCmd = cmd({
  command: "reply <site> <submission-id> <message>",
  describe: "reply to a contact-form enquiry (sends + logs on the comms thread)",
  builder: (y) =>
    y
      .positional("site", { describe: "site id or slug", type: "string", demandOption: true })
      .positional("submission-id", { describe: "submission id from `sites inbox`", type: "number", demandOption: true })
      .positional("message", { describe: "the reply body (quote it)", type: "string", demandOption: true })
      .option("subject", { describe: "email subject line", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const asJson = args.json as boolean
    if (!asJson) prompts.intro("◈  Reply")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = asJson ? null : prompts.spinner()
    sp?.start("Resolving site…")

    const site = await resolveSite(String(args.site))
    if (!site) {
      sp?.stop("Not found", 1)
      prompts.log.error(`No site matched "${args.site}".`)
      prompts.outro("Done")
      return
    }

    sp?.start("Sending…")
    const res = await pagesFetch(`/api/v1/sites/${site.id}/comms/reply`, {
      method: "POST",
      body: JSON.stringify({
        submission_id: Number(args["submission-id"]),
        message: String(args.message),
        ...(args.subject ? { subject: String(args.subject) } : {}),
      }),
    })

    const body = (await res.json().catch(() => ({}))) as any

    if (!res.ok) {
      sp?.stop("Failed", 1)
      if (res.status === 403) prompts.log.error("You do not have access to this site's inbox.")
      else if (res.status === 404) prompts.log.error("That submission does not belong to this site.")
      else if (res.status === 422) prompts.log.error(String(body.message ?? "Cannot send — no reachable channel."))
      else await handleApiError(res, "Reply")
      prompts.outro("Done")
      return
    }

    if (asJson) {
      await writeJson(body)
      return
    }

    const sent = body.data ?? {}
    sp?.stop(`${success("✓")} Sent via ${bold(String(sent.channel ?? "email"))}`)
    printDivider()
    printKV("Site", String(site.name ?? site.slug))
    printKV("Submission", String(args["submission-id"]))
    if (sent.comm_id) printKV("Logged as", `comm #${sent.comm_id}`)
    printDivider()
    prompts.outro(dim(`iris sites inbox ${args.site} --thread`))
  },
})

// ============================================================================
// Doctor / Access — one sign-in policy per site (#192662)
// ============================================================================
//
// Why: each Genesis page used to carry its own sign-in list and its own owner board, and nothing
// showed the drift — a client's staff were locked out of their own pages. The site now owns the
// policy (settings.gate); member pages inherit it and may only narrow it. `doctor` shows what
// every page actually enforces; `access` sets the site's list. Pure rules live in
// platform-sites-access-model.ts.

async function readSiteSettings(siteId: number | string): Promise<{ ok: boolean; settings: Record<string, any> }> {
  const res = await pagesFetch(`/api/v1/sites/${siteId}/settings`)
  if (!res.ok) return { ok: false, settings: {} }
  const body = (await res.json()) as any
  const data = body?.data ?? body
  return { ok: true, settings: data && typeof data === "object" && !Array.isArray(data) ? data : {} }
}

function parseJsonContent(v: unknown): Record<string, any> | null {
  if (!v) return null
  if (typeof v === "string") {
    try { return JSON.parse(v) } catch { return null }
  }
  return typeof v === "object" ? (v as Record<string, any>) : null
}

async function loadMemberPages(site: any): Promise<PageInput[]> {
  const listed: any[] = firstArray(site.pages)
  const out: PageInput[] = []
  // Sequential on purpose: by-slug with include_json is the slow path on fl-api, and a site has
  // a handful of pages — parallel bursts are what 502 it (#150147).
  for (const p of listed) {
    if (!p?.slug) { out.push({ id: p?.id ?? "?", slug: String(p?.id ?? "?"), error: "no slug" }); continue }
    const full = await getBySlug(p.slug, true, { quiet404: true }).catch(() => null)
    if (!full) { out.push({ id: p.id, slug: p.slug, title: p.title, error: "not found or no access" }); continue }
    out.push({
      id: full.id ?? p.id,
      slug: full.slug ?? p.slug,
      title: full.title ?? p.title,
      owner_type: full.owner_type ?? null,
      owner_id: full.owner_id ?? null,
      requires_auth: full.requires_auth ?? null,
      json_content: parseJsonContent(full.json_content),
    })
  }
  return out
}

function pad(s: string, n: number): string {
  // pad on visible width (strip ANSI) so coloured cells line up
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "").length
  return visible >= n ? s : s + " ".repeat(n - visible)
}

function printDoctor(r: SiteReport, email?: string): void {
  printDivider(72)
  printKV("Site", `#${r.site.id}  ${r.site.slug ?? ""}  ${r.site.name ? dim(r.site.name) : ""}`)
  printKV("Site owner", r.site.owner ?? dim("none"))
  printKV("Expected page owner", r.expectedOwner ?? dim("none"))
  printKV("Site sign-in", r.siteRequireOtp ? "required (OTP)" : dim("not required by the site"))
  printKV(
    "Site allow-list",
    r.siteGateStoredAsString ? warn("STORED AS A STRING — fix with `iris sites access`") : hasList(r.siteGate) ? describeList(r.siteGate) : dim("(none set — pages use their own)"),
  )
  printDivider(72)

  const head = [pad("PAGE", 30), pad("OWNER", 14), pad("OTP", 5), pad("GATE", 8), "EFFECTIVE LIST"]
  if (email) head.splice(4, 0, pad("EMAIL", 9))
  console.log(`  ${bold(head.join(" "))}`)
  for (const p of r.pages) {
    const mark = p.flags.length ? warn("!") : success("✓")
    if (p.error) {
      console.log(`${mark} ${pad(`#${p.id} ${p.slug}`, 30)} ${warn(p.error)}`)
      continue
    }
    const gate = p.gateStoredAsString ? warn("STRING") : hasList(p.pageList) ? (p.differsFromSite ? warn("own≠site") : "own") : dim("inherit")
    const owner = p.ownerMismatch ? warn(p.owner ?? "none") : (p.owner ?? dim("none"))
    const cells = [
      pad(`#${p.id} ${p.slug}`.slice(0, 30), 30),
      pad(owner, 14),
      pad(p.requireOtp ? "yes" : dim("no"), 5),
      pad(gate, 8),
      hasList(p.effective) ? describeList(p.effective) : p.requireOtp ? warn("(no list — anyone with a code)") : dim("(public — no sign-in)"),
    ]
    if (p.email) cells.splice(4, 0, pad(p.email.allowed ? success("allowed") : warn("refused"), 9))
    console.log(`${mark} ${cells.join(" ")}`)
  }
  printDivider(72)

  const notes = [...r.flags.map((f) => `site: ${f}`)]
  for (const p of r.pages) for (const f of p.flags) notes.push(`#${p.id} ${p.slug}: ${f}`)
  for (const p of r.pages) {
    if (p.differsFromSite && (p.diff.onlySite.length || p.diff.onlyPage.length)) {
      const parts = []
      if (p.diff.onlySite.length) parts.push(`site only: ${p.diff.onlySite.join(", ")}`)
      if (p.diff.onlyPage.length) parts.push(`page only: ${p.diff.onlyPage.join(", ")}`)
      notes.push(`#${p.id} ${p.slug}: ${parts.join(" · ")}`)
    }
    if (p.gateStoredAsString && p.gateRecovered) notes.push(`#${p.id} ${p.slug}: string seems to mean ${describeList(p.gateRecovered)}`)
    if (p.email) notes.push(`#${p.id} ${p.slug}: ${p.email.address} ${p.email.allowed ? "allowed" : "refused"} — ${p.email.reason}`)
  }
  for (const n of notes) console.log(`  ${dim("·")} ${n}`)
  if (notes.length) printDivider(72)
}

const DoctorCmd = cmd({
  command: "doctor <site>",
  describe: "check a site's sign-in policy: owner board, OTP, each page's gate and effective allow-list (exits 1 on any problem)",
  builder: (y) =>
    y
      .positional("site", { type: "string", demandOption: true, describe: "site id or slug" })
      .option("email", { type: "string", describe: "check whether this address may sign in on each page, and why" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const asJson = !!args.json
    UI.empty()
    if (!asJson) prompts.intro(`◈  Site doctor: ${args.site}`)
    if (!(await requireAuth())) { process.exitCode = 1; if (!asJson) prompts.outro("Done"); return }
    const sp = asJson ? null : prompts.spinner()
    sp?.start("Loading site…")
    try {
      const site = await resolveSite(String(args.site))
      if (!site) {
        sp?.stop("Not found", 1)
        process.exitCode = 1
        if (asJson) emitJsonError(`No site matched "${args.site}"`)
        else { prompts.log.error(`No site matched "${args.site}".`); prompts.outro("Done") }
        return
      }
      const settingsRead = await readSiteSettings(site.id)
      // Fall back to the settings embedded on the site record if the settings endpoint refuses.
      const settings = settingsRead.ok ? settingsRead.settings : (site.settings ?? {})
      sp?.message(`Reading ${firstArray(site.pages).length} page(s)…`)
      const pages = await loadMemberPages(site)
      const report = buildReport({ site, settings, pages, email: args.email ? String(args.email) : undefined })
      if (!report.ok) process.exitCode = 1

      if (asJson) { await writeJson(report); return }
      const nFlag = report.flags.length + report.pages.filter((p) => p.flags.length).length
      sp?.stop(report.ok ? success(`${pages.length} page(s) — no problems`) : warn(`${nFlag} problem(s) across ${pages.length} page(s)`))
      printDoctor(report, args.email ? String(args.email) : undefined)
      prompts.outro(report.ok ? "Done" : dim(`iris sites access ${site.id} --allow-domain <d> --require-otp   ·   then re-run doctor`))
    } catch (err) {
      sp?.stop("Error", 1)
      process.exitCode = 1
      const msg = err instanceof Error ? err.message : String(err)
      if (asJson) emitJsonError(msg)
      else { prompts.log.error(msg); prompts.outro("Done") }
    }
  },
})

const AccessCmd = cmd({
  command: "access <site>",
  describe: "view or set a site's sign-in policy (settings.gate) that member pages inherit",
  builder: (y) =>
    y
      .positional("site", { type: "string", demandOption: true, describe: "site id or slug" })
      .option("allow-domain", { type: "string", array: true, describe: "admit every address at this domain (repeatable)" })
      .option("allow-email", { type: "string", array: true, describe: "admit this exact address (repeatable)" })
      .option("remove-domain", { type: "string", array: true, describe: "take a domain off the list (repeatable)" })
      .option("remove-email", { type: "string", array: true, describe: "take an address off the list (repeatable)" })
      .option("require-otp", { type: "boolean", describe: "require an emailed sign-in code (--no-require-otp to turn off)" })
      .option("dry-run", { type: "boolean", default: false, describe: "show the change without saving it" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const asJson = !!args.json
    UI.empty()
    if (!asJson) prompts.intro(`◈  Site access: ${args.site}`)
    const fail = (msg: string, extra?: Record<string, unknown>) => {
      process.exitCode = 1
      if (asJson) emitJsonError(msg, extra)
      else { prompts.log.error(msg); prompts.outro("Nothing saved") }
    }
    if (!(await requireAuth())) { process.exitCode = 1; if (!asJson) prompts.outro("Done"); return }

    const site = await resolveSite(String(args.site))
    if (!site) return fail(`No site matched "${args.site}".`)
    const current = await readSiteSettings(site.id)
    if (!current.ok) return fail(`Could not read settings for site #${site.id} — do you own it?`)
    const gateNow = current.settings.gate

    const edit = {
      allowDomains: flagList(args["allow-domain"]),
      allowEmails: flagList(args["allow-email"]),
      removeDomains: flagList(args["remove-domain"]),
      removeEmails: flagList(args["remove-email"]),
      requireOtp: args["require-otp"] as boolean | undefined,
    }
    const isEdit =
      edit.allowDomains.length + edit.allowEmails.length + edit.removeDomains.length + edit.removeEmails.length > 0 ||
      edit.requireOtp !== undefined

    if (!isEdit) {
      const read = readGate(gateNow)
      if (asJson) { await writeJson({ site: { id: site.id, slug: site.slug }, gate: read.gate, storedAsString: read.storedAsString, raw: read.storedAsString ? read.raw : undefined }); return }
      printDivider()
      printKV("Site", `#${site.id}  ${site.slug}`)
      if (read.storedAsString) printKV("Gate", warn(`STORED AS A STRING: ${String(read.raw)}`))
      printKV("Allow-list", hasList(read.gate) ? describeList(read.gate) : dim("(none)"))
      printKV("Sign-in code", read.gate?.requireOtp ? "required" : dim("not required"))
      printDivider()
      prompts.outro(dim(`iris sites access ${site.id} --allow-domain example.com --require-otp   ·   iris sites doctor ${site.id}`))
      return
    }

    const merged = mergeGate(gateNow, edit)
    if (!merged.ok) return fail(merged.errors.join("\n"), { errors: merged.errors })
    if (merged.changes.length === 0) {
      if (asJson) { await writeJson({ success: true, changed: false, gate: merged.after }); return }
      prompts.log.info("Already set — nothing to change.")
      prompts.outro("Done")
      return
    }

    if (!asJson) {
      printDivider()
      printKV("Site", `#${site.id}  ${site.slug}`)
      for (const c of merged.changes) console.log(`  ${c.startsWith("+") ? success(c) : c.startsWith("-") ? warn(c) : dim(c)}`)
      printKV("New list", describeList(merged.after))
      printKV("Sign-in code", merged.after.requireOtp ? "required" : dim("not required"))
      printDivider()
    }

    if (args["dry-run"]) {
      if (asJson) await writeJson({ success: true, dryRun: true, before: merged.before, after: merged.after, changes: merged.changes })
      else prompts.outro(dim("Dry run — nothing saved"))
      return
    }

    // Send ONLY the gate key: the endpoint replaces the keys it is given and keeps the rest,
    // so every other setting (notification emails…) is left exactly as it was.
    const res = await pagesFetch(`/api/v1/sites/${site.id}/settings`, {
      method: "PATCH",
      body: JSON.stringify({ gate: merged.after }),
    })
    if (!(await handleApiError(res, "Update site access"))) { process.exitCode = 1; if (!asJson) prompts.outro("Nothing saved"); return }

    // Read back — a 200 is not proof the key landed (an endpoint can silently drop unknown keys).
    const back = await readSiteSettings(site.id)
    const landed = back.ok && sameGate(back.settings.gate, merged.after)
    const othersKept = back.ok && Object.keys(current.settings).filter((k) => k !== "gate").every((k) => k in back.settings)
    if (!landed || !othersKept) {
      process.exitCode = 1
      const msg = !landed
        ? "The server answered OK but the gate did not read back as sent — the site settings endpoint may not store `gate` yet."
        : "The gate saved but another settings key went missing on read-back — check `iris sites config`."
      if (asJson) { emitJsonError(msg, { sent: merged.after, readBack: back.settings.gate ?? null }); return }
      prompts.log.error(msg)
      prompts.outro("Check failed")
      return
    }
    if (asJson) { await writeJson({ success: true, changed: true, before: merged.before, after: back.settings.gate, changes: merged.changes }); return }
    prompts.outro(success(`Saved and read back — run: iris sites doctor ${site.id}`))
  },
})

// ============================================================================
// Root
// ============================================================================

export const PlatformSitesCommand = cmd({
  command: "sites",
  describe: "manage Genesis sites — list, show, create, attach, nav, settings, sign-in policy (doctor, access)",
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
      .command(InboxCmd)
      .command(ReplyCmd)
      .command(DoctorCmd)
      .command(AccessCmd)
      .demandCommand(),
  async handler() {},
})
