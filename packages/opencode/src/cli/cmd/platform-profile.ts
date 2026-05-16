import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs"
import { join } from "path"

// ============================================================================
// Sync helpers
// ============================================================================

const SYNC_DIR = ".iris/profiles"

function resolveSyncDir(): string {
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "fl-docker-dev"))) return join(dir, SYNC_DIR)
    const parent = join(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return join(process.cwd(), SYNC_DIR)
}

function profileFilename(p: any): string {
  const slug = p.id ?? p.slug ?? "unknown"
  return `${p.pk}-${slug}.json`
}

function findLocalProfileFile(dir: string, pkOrSlug: string): string | undefined {
  if (!existsSync(dir)) return undefined
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".json"))
  // Match by pk prefix or slug in filename
  return files.map(f => join(dir, f)).find(f => {
    const base = f.split("/").pop() ?? ""
    return base.startsWith(`${pkOrSlug}-`) || base.includes(`-${pkOrSlug}.json`)
  })
}

// Helper: GET /api/v1/profile/{slugOrPk}
async function fetchProfile(slugOrPk: string): Promise<any | null> {
  const res = await irisFetch(`/api/v1/profile/${slugOrPk}`)
  if (!res.ok) return null
  const data = (await res.json()) as any
  return data?.data ?? (data?.pk ? data : null)
}

function parseLinks(raw: any): any[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === "string" && raw) { try { const d = JSON.parse(raw); if (Array.isArray(d)) return d } catch {} }
  return []
}

function getNested(obj: any, path: string): any {
  const keys = path.split(".")
  let cur = obj
  for (const k of keys) {
    if (cur == null) return undefined
    if (Array.isArray(cur) && /^\d+$/.test(k)) cur = cur[parseInt(k, 10)]
    else cur = cur[k]
  }
  return cur
}

function parseValue(v: string): any {
  try { const d = JSON.parse(v); if (typeof d === "object" || typeof d === "boolean") return d } catch {}
  if (/^-?\d+$/.test(v)) return parseInt(v, 10)
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v)
  if (v === "true") return true
  if (v === "false") return false
  if (v === "null") return null
  return v
}

// ============================================================================
// profile show <slug>
// ============================================================================

const ProfileShowCommand = cmd({
  command: "show <slug>",
  describe: "show full profile details",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "profile slug or PK", type: "string", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Profile: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const profile = await fetchProfile(args.slug)
    if (!profile) { prompts.log.error(`Profile '${args.slug}' not found`); prompts.outro("Done"); return }

    if (args.json) { console.log(JSON.stringify(profile, null, 2)); prompts.outro("Done"); return }

    printDivider()
    printKV("Name", profile.name)
    printKV("Slug", profile.id)
    printKV("PK", profile.pk)
    printKV("Bio", profile.bio)
    printKV("Email", profile.email)
    printKV("Phone", profile.phone)
    printKV("Instagram", profile.instagram)
    printKV("Twitter", profile.twitter)
    printKV("Website", profile.website_url)

    const links = parseLinks(profile.links)
    console.log()
    console.log(`  ${dim(`Links (${links.length}):`)}`)
    if (links.length === 0) console.log(`    ${dim("(none)")}`)
    else links.forEach((l: any, i: number) => {
      console.log(`    [${i}] ${bold(String(l.title ?? "untitled"))}`)
      console.log(`        ${dim(String(l.url ?? ""))}`)
    })

    // Memberships
    try {
      const r = await irisFetch(`/api/v1/profile/${profile.pk}/fan-funding`)
      if (r.ok) {
        const d = (await r.json()) as any
        const pkgs: any[] = d?.packages ?? d?.data?.packages ?? []
        console.log()
        console.log(`  ${dim(`Memberships (${pkgs.length}):`)}`)
        for (const p of pkgs) {
          const amt = ((p.subscription_amount ?? 0) / 100).toFixed(2)
          console.log(`    [${p.id}] ${bold(String(p.title))}  ${dim(`$${amt}/${p.subscription_frequency ?? "month"}`)}`)
        }
      }
    } catch {}
    printDivider()
    prompts.outro("Done")
  },
})

// ============================================================================
// profile get <slug> [path]
// ============================================================================

const ProfileGetCommand = cmd({
  command: "get <slug> [path]",
  describe: "get a field via dot-notation",
  builder: (yargs) =>
    yargs
      .positional("slug", { type: "string", demandOption: true })
      .positional("path", { type: "string" }),
  async handler(args) {
    const token = await requireAuth(); if (!token) return
    const profile = await fetchProfile(args.slug)
    if (!profile) { console.error(`Profile '${args.slug}' not found`); return }
    if (typeof profile.links === "string") profile.links = parseLinks(profile.links)
    if (!args.path) { console.log(JSON.stringify(profile, null, 2)); return }
    const v = getNested(profile, args.path)
    if (v === undefined || v === null) { console.log(`(not found: ${args.path})`); return }
    console.log(typeof v === "object" ? JSON.stringify(v, null, 2) : String(v))
  },
})

// ============================================================================
// profile set <slug> <field> <value>
// ============================================================================

const ProfileSetCommand = cmd({
  command: "set <slug> <field> <value>",
  describe: "update a profile field",
  builder: (yargs) =>
    yargs
      .positional("slug", { type: "string", demandOption: true })
      .positional("field", { type: "string", demandOption: true })
      .positional("value", { type: "string", demandOption: true })
      .option("force", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Set ${args.field}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const profile = await fetchProfile(args.slug)
    if (!profile) { prompts.log.error("Not found"); prompts.outro("Done"); return }
    const newVal = parseValue(args.value)
    printKV("Profile", profile.name)
    printKV("Field", args.field)
    printKV("Current", JSON.stringify(profile[args.field] ?? null))
    printKV("New", JSON.stringify(newVal))

    if (!args.force) {
      const ok = await prompts.confirm({ message: "Apply?" })
      if (!ok || prompts.isCancel(ok)) { prompts.outro("Cancelled"); return }
    }
    const res = await irisFetch(`/api/v1/profile/${profile.pk}`, {
      method: "PUT",
      body: JSON.stringify({ [args.field]: newVal }),
    })
    const okay = await handleApiError(res, "Update profile")
    if (!okay) { prompts.outro("Done"); return }
    prompts.outro(`${success("✓")} Updated`)
  },
})

// ============================================================================
// profile links <slug>
// ============================================================================

const ProfileLinksCommand = cmd({
  command: "links <slug>",
  describe: "manage profile links",
  builder: (yargs) =>
    yargs
      .positional("slug", { type: "string", demandOption: true })
      .option("add", { type: "boolean", default: false })
      .option("remove", { type: "number", describe: "index to remove" })
      .option("set", { type: "string", describe: "JSON array to replace all" })
      .option("title", { type: "string" })
      .option("url", { type: "string" })
      .option("subtitle", { type: "string" })
      .option("force", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Links: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const profile = await fetchProfile(args.slug)
    if (!profile) { prompts.log.error("Not found"); prompts.outro("Done"); return }
    let links = parseLinks(profile.links)

    const noFlags = !args.add && args.remove === undefined && !args.set
    if (noFlags) {
      printDivider()
      if (links.length === 0) console.log(`  ${dim("(no links)")}`)
      else links.forEach((l: any, i: number) => {
        console.log(`  [${i}] ${bold(String(l.title))}`)
        console.log(`      ${dim(String(l.url))}`)
      })
      printDivider()
      prompts.outro("Done")
      return
    }

    if (args.add) {
      if (!args.title || !args.url) { prompts.log.error("--title and --url required"); prompts.outro("Done"); return }
      const link: any = { title: args.title, url: args.url }
      if (args.subtitle) link.subtitle = args.subtitle
      links.push(link)
    }
    if (args.remove !== undefined) {
      if (!links[args.remove]) { prompts.log.error(`Index ${args.remove} not found`); prompts.outro("Done"); return }
      links.splice(args.remove, 1)
    }
    if (args.set) {
      try { const p = JSON.parse(args.set); if (!Array.isArray(p)) throw new Error("not array"); links = p }
      catch { prompts.log.error("--set must be JSON array"); prompts.outro("Done"); return }
    }

    if (!args.force) {
      const ok = await prompts.confirm({ message: `Save ${links.length} link(s)?` })
      if (!ok || prompts.isCancel(ok)) { prompts.outro("Cancelled"); return }
    }
    const res = await irisFetch(`/api/v1/profile/${profile.pk}`, { method: "PUT", body: JSON.stringify({ links }) })
    const okay = await handleApiError(res, "Update links")
    if (!okay) { prompts.outro("Done"); return }
    prompts.outro(`${success("✓")} Updated`)
  },
})

// ============================================================================
// profile memberships <slug>
// ============================================================================

const ProfileMembershipsCommand = cmd({
  command: "memberships <slug>",
  aliases: ["membership", "packages"],
  describe: "manage fan-funding membership packages",
  builder: (yargs) =>
    yargs
      .positional("slug", { type: "string", demandOption: true })
      .option("add", { type: "boolean", default: false })
      .option("remove", { type: "number", describe: "package ID to delete" })
      .option("title", { type: "string" })
      .option("price", { type: "number", describe: "price in dollars" })
      .option("description", { type: "string" })
      .option("frequency", { type: "string", default: "month" })
      .option("force", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Memberships: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const profile = await fetchProfile(args.slug)
    if (!profile) { prompts.log.error("Not found"); prompts.outro("Done"); return }

    if (args.add) {
      if (!args.title || args.price === undefined) { prompts.log.error("--title and --price required"); prompts.outro("Done"); return }
      const cents = Math.round(args.price * 100)
      const res = await irisFetch(`/api/v1/profile/fan-funding`, {
        method: "POST",
        body: JSON.stringify({
          profile_id: profile.pk,
          title: args.title,
          description: args.description ?? "",
          subscription_amount: cents,
          subscription_frequency: args.frequency,
          status: 0,
        }),
      })
      const ok = await handleApiError(res, "Create package")
      if (!ok) { prompts.outro("Done"); return }
      prompts.outro(`${success("✓")} Created`)
      return
    }
    if (args.remove !== undefined) {
      const res = await irisFetch(`/api/v1/profile/fan-funding/${args.remove}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete package")
      if (!ok) { prompts.outro("Done"); return }
      prompts.outro(`${success("✓")} Deleted`)
      return
    }

    // List
    const res = await irisFetch(`/api/v1/profile/${profile.pk}/fan-funding`)
    const ok = await handleApiError(res, "List packages")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const pkgs: any[] = data?.packages ?? data?.data?.packages ?? []
    printDivider()
    if (pkgs.length === 0) console.log(`  ${dim("(no packages)")}`)
    else for (const p of pkgs) {
      const amt = ((p.subscription_amount ?? 0) / 100).toFixed(2)
      console.log(`  [${p.id}] ${bold(String(p.title))}  ${dim(`$${amt}/${p.subscription_frequency}`)}`)
      if (p.description) console.log(`      ${dim(String(p.description))}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ============================================================================
// profile create --name <name> [--bio] [--category] [--website]
// ============================================================================

const ProfileCreateCommand = cmd({
  command: "create",
  describe: "create a new profile",
  builder: (yargs) =>
    yargs
      .option("name", { describe: "profile name", type: "string", demandOption: true })
      .option("bio", { describe: "profile bio", type: "string" })
      .option("city", { describe: "city", type: "string" })
      .option("state", { describe: "state", type: "string" })
      .option("email", { describe: "email", type: "string" })
      .option("phone", { describe: "phone", type: "string" })
      .option("instagram", { describe: "Instagram handle", type: "string" })
      .option("twitter", { describe: "Twitter/X handle", type: "string" })
      .option("youtube", { describe: "YouTube channel", type: "string" })
      .option("spotify", { describe: "Spotify artist ID/URL", type: "string" })
      .option("tiktok", { describe: "TikTok handle", type: "string" })
      .option("twitch", { describe: "Twitch handle", type: "string" })
      .option("website", { describe: "website URL", type: "string" })
      .option("tags", { describe: "tags (comma-separated)", type: "string" })
      .option("category", { describe: "profile category", type: "string" })
      .option("lead-id", { describe: "link to lead ID after creation", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    await requireAuth()
    const name = args.name as string
    const spinner = prompts.spinner()
    spinner.start("Creating profile…")

    const body: Record<string, any> = { name }
    if (args.bio) body.bio = args.bio
    if (args.city) body.city = args.city
    if (args.state) body.state = args.state
    if (args.email) body.email = args.email
    if (args.phone) body.phone = args.phone
    if (args.instagram) body.instagram = args.instagram
    if (args.twitter) body.twitter = args.twitter
    if (args.youtube) body.youtube = args.youtube
    if (args.spotify) body.spotify = args.spotify
    if (args.tiktok) body.tiktok = args.tiktok
    if (args.twitch) body.twitch = args.twitch
    if (args.website) body.website_url = args.website
    if (args.tags) body.tags = args.tags
    if (args.category) body.category = args.category

    const res = await irisFetch("/api/v1/profile/create", {
      method: "POST",
      body: JSON.stringify(body),
    })
    const ok = await handleApiError(res, "Create profile")
    if (!ok) { spinner.stop("Failed", 1); return }
    const data = (await res.json()) as any
    const inner = data?.data ?? data
    const profile = inner?.profile ?? inner

    // Warn if assigned slug differs from expected (counter suffix added)
    const expectedSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const assignedSlug = profile.id ?? profile.slug
    const slugMismatch = assignedSlug && assignedSlug !== expectedSlug

    // Link to lead if --lead-id provided
    const leadId = args["lead-id"] as number | undefined
    if (leadId && profile.pk) {
      try {
        const linkRes = await irisFetch(`/api/v1/leads/${leadId}`, {
          method: "PUT",
          body: JSON.stringify({ profile_id: profile.pk }),
        })
        const slugNote = slugMismatch ? ` (slug: ${assignedSlug} — '${expectedSlug}' was taken)` : ''
        if (linkRes.ok) {
          spinner.stop(success(`${name} created + linked to lead #${leadId}${slugNote}`))
        } else {
          spinner.stop(success(`${name} created (lead link failed — update lead manually)${slugNote}`))
        }
      } catch {
        spinner.stop(success(`${name} created (lead link failed)`))
      }
    } else {
      const slugNote = slugMismatch ? ` (slug: ${assignedSlug} — '${expectedSlug}' was taken)` : ''
      spinner.stop(success(`${name} created${slugNote}`))
    }

    if (args.json) { console.log(JSON.stringify(profile, null, 2)); return }

    printDivider()
    printKV("PK", profile.pk ?? profile.id ?? "?")
    printKV("Slug", profile.id ?? profile.slug ?? "?")
    printKV("Name", profile.name ?? name)
    printKV("URL", `freelabel.net/@${profile.id ?? profile.slug ?? "?"}`)
    if (profile.city) printKV("Location", [profile.city, profile.state].filter(Boolean).join(", "))
    if (profile.instagram) printKV("Instagram", profile.instagram)
    if (profile.email) printKV("Email", profile.email)
    if (leadId) printKV("Lead", `#${leadId}`)
    printDivider()
  },
})

// ============================================================================
// profile reassign-articles --from <pk> --to <pk> --match <keyword>
// ============================================================================

const ProfileReassignArticlesCommand = cmd({
  command: "reassign-articles",
  describe: "move articles from one profile to another by keyword match",
  builder: (yargs) =>
    yargs
      .option("from", { describe: "source profile slug or PK", type: "string", demandOption: true })
      .option("to", { describe: "target profile slug or PK", type: "string", demandOption: true })
      .option("match", { describe: "keyword to match in article titles (case-insensitive)", type: "string", demandOption: true })
      .option("dry-run", { describe: "preview without making changes", type: "boolean", default: false })
      .option("yes", { alias: "y", describe: "skip confirmation", type: "boolean", default: false }),
  async handler(args) {
    await requireAuth()
    const fromSlug = args.from as string
    const toSlug = args.to as string
    const keyword = (args.match as string).toLowerCase()
    const dryRun = args["dry-run"] as boolean

    // Resolve source profile
    const fromProfile = await fetchProfile(fromSlug)
    if (!fromProfile) { prompts.outro(`Source profile "${fromSlug}" not found`); return }
    console.log(`  Source: ${bold(fromProfile.name)} (pk: ${fromProfile.pk})`)

    // Resolve target profile
    const toProfile = await fetchProfile(toSlug)
    if (!toProfile) { prompts.outro(`Target profile "${toSlug}" not found`); return }
    console.log(`  Target: ${bold(toProfile.name)} (pk: ${toProfile.pk})`)

    // Fetch articles from source profile
    const articlesRes = await irisFetch(`/api/v1/articles?profile_id=${fromProfile.pk}&limit=100`)
    const articlesOk = await handleApiError(articlesRes, "Fetch articles")
    if (!articlesOk) return
    const articlesData = (await articlesRes.json()) as any
    // Handle nested pagination (data.data) or flat array (data)
    const rawArticles = articlesData?.data?.data ?? articlesData?.data ?? articlesData ?? []
    const articles: any[] = Array.isArray(rawArticles) ? rawArticles : Object.values(rawArticles)

    // Filter by keyword
    const matching = articles.filter((a: any) =>
      (a.title || "").toLowerCase().includes(keyword)
    )

    printDivider()
    console.log(`  Found ${matching.length} articles matching "${args.match}" out of ${articles.length} total`)
    printDivider()

    if (matching.length === 0) {
      prompts.outro("No matching articles found")
      return
    }

    for (const article of matching) {
      console.log(`  [${article.id}] ${article.title}`)
    }

    if (dryRun) {
      printDivider()
      prompts.outro(dim("Dry run — no changes made"))
      return
    }

    const skipConfirm = args.yes as boolean
    if (!skipConfirm) {
      printDivider()
      const confirmed = await prompts.confirm({
        message: `Move ${matching.length} articles from "${fromProfile.name}" to "${toProfile.name}"?`,
      })
      if (!confirmed || prompts.isCancel(confirmed)) {
        prompts.outro("Cancelled")
        return
      }
    }

    // Reassign each article
    let moved = 0
    for (const article of matching) {
      const updateRes = await irisFetch(`/api/v1/articles/${article.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile_id: toProfile.pk }),
      })
      if (updateRes.ok) {
        moved++
        console.log(`  ✓ Moved: ${article.title}`)
      } else {
        console.log(`  ✗ Failed: ${article.title} (${updateRes.status})`)
      }
    }

    printDivider()
    prompts.outro(success(`Moved ${moved}/${matching.length} articles`))
  },
})

// ============================================================================
// profile batch-create — bulk create profiles from JSON file
// ============================================================================

const ProfileBatchCreateCommand = cmd({
  command: "batch-create <file>",
  aliases: ["bulk-create", "batch"],
  describe: "bulk create profiles from a JSON file",
  builder: (yargs) =>
    yargs
      .positional("file", { describe: "path to JSON file with profile array", type: "string", demandOption: true })
      .option("dry-run", { describe: "preview without creating", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    await requireAuth()
    const filePath = args.file as string
    const dryRun = args["dry-run"] as boolean

    // Read and parse JSON file
    let profiles: any[]
    try {
      const raw = readFileSync(filePath, "utf-8")
      const parsed = JSON.parse(raw)
      profiles = Array.isArray(parsed) ? parsed : (parsed.profiles || parsed.artists || [parsed])
    } catch (err: any) {
      prompts.log.error(`Failed to read ${filePath}: ${err.message}`)
      return
    }

    if (profiles.length === 0) {
      prompts.log.warn("No profiles found in file")
      return
    }

    prompts.intro(`◈  Batch Create — ${profiles.length} profile(s)`)

    if (dryRun) {
      printDivider()
      for (const p of profiles) {
        const name = p.name || p.profile?.name || "?"
        const ig = p.instagram || p.profile?.instagram || ""
        const leadId = p.lead_id || p.leadId || ""
        console.log(`  📋 ${bold(name)}${ig ? "  @" + ig : ""}${leadId ? dim("  → Lead #" + leadId) : ""}`)
      }
      printDivider()
      prompts.outro(dim(`Dry run — ${profiles.length} profiles would be created`))
      return
    }

    const results: any[] = []
    let created = 0
    let failed = 0

    for (const entry of profiles) {
      // Support both flat format and nested { profile: {}, lead_id } format
      const profileData = entry.profile || entry
      const leadId = entry.lead_id || entry.leadId
      const name = profileData.name

      if (!name) {
        console.log(`  ⚠ Skipped entry — no name`)
        failed++
        continue
      }

      const body: Record<string, any> = {}
      const fields = ["name", "bio", "city", "state", "email", "phone", "instagram", "twitter",
                       "youtube", "spotify", "tiktok", "twitch", "website_url", "tags", "category"]
      for (const f of fields) {
        if (profileData[f]) body[f] = profileData[f]
      }
      // Handle website alias
      if (profileData.website && !body.website_url) body.website_url = profileData.website

      try {
        const res = await irisFetch("/api/v1/profile/create", {
          method: "POST",
          body: JSON.stringify(body),
        })

        if (!res.ok) {
          const errData = await res.text()
          console.log(`  ❌ ${name} — ${res.status}: ${errData.slice(0, 100)}`)
          failed++
          continue
        }

        const data = (await res.json()) as any
        const batchInner = data?.data ?? data
        const profile = batchInner?.profile ?? batchInner

        // Link to lead if lead_id provided
        if (leadId && profile.pk) {
          try {
            await irisFetch(`/api/v1/leads/${leadId}`, {
              method: "PUT",
              body: JSON.stringify({ profile_id: profile.pk }),
            })
          } catch { /* best effort */ }
        }

        const slug = profile.id ?? profile.slug ?? "?"
        const batchExpected = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        const slugWarn = slug !== batchExpected ? dim(` (expected '${batchExpected}')`) : ""
        console.log(`  ✅ ${bold(name)} → @${slug}${slugWarn}${leadId ? dim("  → Lead #" + leadId) : ""}`)
        results.push({ ...profile, lead_id: leadId })
        created++
      } catch (err: any) {
        console.log(`  ❌ ${name} — ${err.message}`)
        failed++
      }
    }

    printDivider()
    if (args.json) {
      console.log(JSON.stringify(results, null, 2))
    }
    prompts.outro(success(`${created} created, ${failed} failed`))
  },
})

// ============================================================================
// profile list (alias: ls)
// ============================================================================

const ProfileListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list profiles",
  builder: (yargs) =>
    yargs
      .option("search", { type: "string", describe: "filter by name/slug/city/handle" })
      .option("city", { type: "string", describe: "filter by city" })
      .option("has-instagram", { type: "boolean", default: false, describe: "only profiles with IG" })
      .option("page", { type: "number", default: 1 })
      .option("limit", { type: "number", default: 20 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Profiles")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const params = new URLSearchParams()
    params.set("limit", String(args.limit))
    params.set("page", String(args.page))
    if (args.search) params.set("search", args.search as string)
    if (args.city) params.set("city", args.city as string)
    if (args["has-instagram"]) params.set("has_instagram", "1")

    const res = await irisFetch(`/api/v1/profiles?${params.toString()}`)
    const ok = await handleApiError(res, "List profiles")
    if (!ok) { prompts.outro("Done"); return }

    const data = (await res.json()) as any
    const hits: any[] = data?.data ?? []
    const meta = data?.meta ?? {}

    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }

    printDivider()
    if (hits.length === 0) {
      console.log(`  ${dim("(no profiles found)")}`)
    } else {
      for (const p of hits) {
        const name = bold(String(p.name ?? "?"))
        const slug = p.id ?? ""
        const city = p.city ? dim(` · ${p.city}`) : ""
        const ig = p.instagram ? dim(` · @${String(p.instagram).replace(/^@/, "")}`) : ""
        console.log(`  ${name}  ${dim(slug)}${city}${ig}`)
      }
      console.log()
      const total = meta.total ?? hits.length
      const pageInfo = meta.last_page > 1 ? ` (page ${meta.current_page}/${meta.last_page})` : ""
      console.log(`  ${dim(`${total} profile(s)${pageInfo}`)}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ============================================================================
// profile media <slug>
// ============================================================================

const ProfileMediaCommand = cmd({
  command: "media <slug>",
  describe: "show profile content (videos, tracks, articles, etc.)",
  builder: (yargs) =>
    yargs
      .positional("slug", { type: "string", demandOption: true })
      .option("type", { type: "string", describe: "filter by type (video, track, article, service, product, event, photo)" })
      .option("limit", { type: "number", default: 25 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Media: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const profile = await fetchProfile(args.slug)
    if (!profile) { prompts.log.error(`Profile '${args.slug}' not found`); prompts.outro("Done"); return }

    // Fetch media counts
    const countsRes = await irisFetch(`/api/v1/profile/${profile.pk}/media/counts`)
    let counts: Record<string, number> = {}
    if (countsRes.ok) {
      const cd = (await countsRes.json()) as any
      counts = cd?.data ?? cd ?? {}
    }

    const mediaType = args.type as string | undefined
    const limit = args.limit as number

    // Fetch media items
    const mediaUrl = mediaType
      ? `/api/v1/user/profile/media/${profile.pk}/${mediaType}?limit=${limit}`
      : `/api/v1/user/profile/media/${profile.pk}?limit=${limit}`
    const mediaRes = await irisFetch(mediaUrl)
    const mediaOk = await handleApiError(mediaRes, "Fetch media")
    if (!mediaOk) { prompts.outro("Done"); return }

    const mediaData = (await mediaRes.json()) as any
    const items: any[] = mediaData?.data ?? mediaData ?? []

    if (args.json) { console.log(JSON.stringify({ counts, items }, null, 2)); prompts.outro("Done"); return }

    printDivider()
    // Show counts header
    const countEntries = Object.entries(counts).filter(([_, v]) => (v as number) > 0)
    if (countEntries.length > 0) {
      console.log(`  ${bold("Content Counts:")}`)
      for (const [type, count] of countEntries) {
        console.log(`    ${type}: ${bold(String(count))}`)
      }
      console.log()
    }

    // Show items
    if (items.length === 0) {
      console.log(`  ${dim("(no media items)")}`)
    } else {
      const grouped: Record<string, any[]> = {}
      for (const item of items) {
        const t = item.type ?? item.media_type ?? "other"
        if (!grouped[t]) grouped[t] = []
        grouped[t].push(item)
      }
      for (const [type, group] of Object.entries(grouped)) {
        console.log(`  ${bold(type)} (${group.length})`)
        for (const item of group) {
          const title = item.title ?? item.name ?? item.filename ?? "untitled"
          const id = item.id ?? ""
          console.log(`    [${id}] ${title}`)
        }
        console.log()
      }
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ============================================================================
// profile analytics <slug> (alias: stats)
// ============================================================================

const ProfileAnalyticsCommand = cmd({
  command: "analytics <slug>",
  aliases: ["stats"],
  describe: "show profile social stats and engagement",
  builder: (yargs) =>
    yargs
      .positional("slug", { type: "string", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Analytics: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const profile = await fetchProfile(args.slug)
    if (!profile) { prompts.log.error(`Profile '${args.slug}' not found`); prompts.outro("Done"); return }

    const res = await irisFetch(`/api/v1/user/profile/${profile.pk}/social-stats`)
    const ok = await handleApiError(res, "Fetch analytics")
    if (!ok) { prompts.outro("Done"); return }

    const data = (await res.json()) as any
    const stats = data?.data ?? data ?? {}

    if (args.json) { console.log(JSON.stringify(stats, null, 2)); prompts.outro("Done"); return }

    printDivider()
    printKV("Profile", profile.name)
    printKV("Slug", profile.id ?? profile.slug)
    console.log()

    const entries = Object.entries(stats)
    if (entries.length === 0) {
      console.log(`  ${dim("(no analytics data)")}`)
    } else {
      for (const [key, value] of entries) {
        if (typeof value === "object" && value !== null) {
          console.log(`  ${bold(key)}:`)
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            printKV(`  ${k}`, String(v ?? "—"))
          }
        } else {
          printKV(key, String(value ?? "—"))
        }
      }
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ============================================================================
// profile search <query>
// ============================================================================

const ProfileSearchCommand = cmd({
  command: "search <query>",
  describe: "search profiles by name, bio, location, or handles",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true })
      .option("limit", { type: "number", default: 20 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const q = args.query as string
    prompts.intro(`◈  Search: "${q}"`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const limit = args.limit as number
    const res = await irisFetch(`/api/v1/search`, {
      method: "POST",
      body: JSON.stringify({ q, types: ["profiles"], limit }),
    })
    const ok = await handleApiError(res, "Search profiles")
    if (!ok) { prompts.outro("Done"); return }

    const data = (await res.json()) as any
    const profileResults = data?.results?.profiles ?? data?.data?.profiles ?? data?.data ?? []
    const hits: any[] = Array.isArray(profileResults) ? profileResults : []

    if (args.json) { console.log(JSON.stringify(hits, null, 2)); prompts.outro("Done"); return }

    printDivider()
    if (hits.length === 0) {
      console.log(`  ${dim("(no results)")}`)
    } else {
      for (const p of hits) {
        const name = bold(String(p.name ?? p.title ?? "?"))
        const slug = p.id ?? p.slug ?? ""
        const city = p.city ? dim(` · ${p.city}`) : ""
        const ig = p.instagram ? dim(` · @${String(p.instagram).replace(/^@/, "")}`) : ""
        console.log(`  ${name}  ${dim(slug)}${city}${ig}`)
      }
      console.log()
      console.log(`  ${dim(`${hits.length} result(s)`)}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ============================================================================
// profile pull <slug>
// ============================================================================

const ProfilePullCommand = cmd({
  command: "pull <slug>",
  describe: "download profile to local .iris/profiles/ JSON",
  builder: (yargs) =>
    yargs
      .positional("slug", { type: "string", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Pull: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const profile = await fetchProfile(args.slug)
    if (!profile) { prompts.log.error(`Profile '${args.slug}' not found`); prompts.outro("Done"); return }

    const dir = resolveSyncDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const filename = profileFilename(profile)
    const filepath = join(dir, filename)
    writeFileSync(filepath, JSON.stringify(profile, null, 2))

    if (args.json) { console.log(JSON.stringify(profile, null, 2)); prompts.outro("Done"); return }

    prompts.outro(`${success("✓")} Saved to ${filepath}`)
  },
})

// ============================================================================
// profile push <slug>
// ============================================================================

const ProfilePushCommand = cmd({
  command: "push <slug>",
  describe: "push local .iris/profiles/ JSON back to API",
  builder: (yargs) =>
    yargs
      .positional("slug", { type: "string", demandOption: true })
      .option("file", { type: "string", describe: "path to JSON file (auto-detected if omitted)" })
      .option("force", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Push: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    // Resolve profile to get PK
    const profile = await fetchProfile(args.slug)
    if (!profile) { prompts.log.error(`Profile '${args.slug}' not found on API`); prompts.outro("Done"); return }

    // Find local file
    const dir = resolveSyncDir()
    let filepath = args.file as string | undefined
    if (!filepath) {
      filepath = findLocalProfileFile(dir, String(profile.pk)) ?? findLocalProfileFile(dir, args.slug)
    }
    if (!filepath || !existsSync(filepath)) {
      prompts.log.error(`No local file found for '${args.slug}'. Run 'profile pull ${args.slug}' first.`)
      prompts.outro("Done")
      return
    }

    let localData: any
    try {
      localData = JSON.parse(readFileSync(filepath, "utf-8"))
    } catch (err: any) {
      prompts.log.error(`Failed to parse ${filepath}: ${err.message}`)
      prompts.outro("Done")
      return
    }

    printKV("Profile", profile.name)
    printKV("File", filepath)

    if (!args.force) {
      const ok = await prompts.confirm({ message: "Push local changes to API?" })
      if (!ok || prompts.isCancel(ok)) { prompts.outro("Cancelled"); return }
    }

    const res = await irisFetch(`/api/v1/profile/${profile.pk}`, {
      method: "PUT",
      body: JSON.stringify(localData),
    })
    const ok = await handleApiError(res, "Push profile")
    if (!ok) { prompts.outro("Done"); return }

    prompts.outro(`${success("✓")} Pushed`)
  },
})

// ============================================================================
// profile social <slug>
// ============================================================================

const ProfileSocialCommand = cmd({
  command: "social <slug>",
  describe: "show connected social accounts and feed",
  builder: (yargs) =>
    yargs
      .positional("slug", { type: "string", demandOption: true })
      .option("feed", { type: "boolean", default: false, describe: "include social feed" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Social: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const profile = await fetchProfile(args.slug)
    if (!profile) { prompts.log.error(`Profile '${args.slug}' not found`); prompts.outro("Done"); return }

    // Fetch connected accounts
    const accountsRes = await irisFetch(`/api/v1/profiles/${profile.pk}/social/accounts`)
    let accounts: any[] = []
    if (accountsRes.ok) {
      const ad = (await accountsRes.json()) as any
      accounts = ad?.data ?? ad ?? []
    }

    // Optionally fetch feed
    let feed: any[] = []
    if (args.feed) {
      const feedRes = await irisFetch(`/api/v1/profile/${profile.pk}/social-feed`)
      if (feedRes.ok) {
        const fd = (await feedRes.json()) as any
        feed = fd?.data ?? fd ?? []
      }
    }

    if (args.json) {
      console.log(JSON.stringify({ accounts, feed: args.feed ? feed : undefined }, null, 2))
      prompts.outro("Done")
      return
    }

    printDivider()
    printKV("Profile", profile.name)
    console.log()

    // Show inline social handles from profile
    const handles: [string, string][] = []
    if (profile.instagram) handles.push(["Instagram", `@${profile.instagram}`])
    if (profile.twitter) handles.push(["Twitter/X", `@${profile.twitter}`])
    if (profile.youtube) handles.push(["YouTube", profile.youtube])
    if (profile.spotify) handles.push(["Spotify", profile.spotify])
    if (profile.tiktok) handles.push(["TikTok", `@${profile.tiktok}`])
    if (profile.twitch) handles.push(["Twitch", profile.twitch])
    if (profile.website_url) handles.push(["Website", profile.website_url])

    if (handles.length > 0) {
      console.log(`  ${bold("Profile Handles:")}`)
      for (const [platform, handle] of handles) {
        printKV(`  ${platform}`, handle)
      }
      console.log()
    }

    // Show connected accounts from API
    if (Array.isArray(accounts) && accounts.length > 0) {
      console.log(`  ${bold("Connected Accounts:")}`)
      for (const acc of accounts) {
        const platform = acc.platform ?? acc.provider ?? "?"
        const handle = acc.username ?? acc.handle ?? acc.account_name ?? "?"
        const status = acc.status === "active" ? success("active") : dim(acc.status ?? "unknown")
        console.log(`    ${bold(platform)}: ${handle}  ${status}`)
      }
    } else if (handles.length === 0) {
      console.log(`  ${dim("(no social accounts)")}`)
    }

    // Show feed if requested
    if (args.feed && feed.length > 0) {
      console.log()
      console.log(`  ${bold(`Social Feed (${feed.length}):`)}`)
      for (const item of feed.slice(0, 10)) {
        const platform = dim(item.platform ?? "")
        const text = (item.text ?? item.content ?? item.title ?? "").slice(0, 80)
        console.log(`    ${platform} ${text}`)
      }
      if (feed.length > 10) console.log(`    ${dim(`... and ${feed.length - 10} more`)}`)
    }

    printDivider()
    prompts.outro("Done")
  },
})

// ============================================================================
// profile opportunities <slug> (alias: opps)
// ============================================================================

const ProfileOpportunitiesCommand = cmd({
  command: "opportunities <slug>",
  aliases: ["opps"],
  describe: "list marketplace opportunities for a profile",
  builder: (yargs) =>
    yargs
      .positional("slug", { type: "string", demandOption: true })
      .option("limit", { type: "number", default: 20 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Opportunities: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const profile = await fetchProfile(args.slug)
    if (!profile) { prompts.log.error(`Profile '${args.slug}' not found`); prompts.outro("Done"); return }

    const res = await irisFetch(`/api/v1/marketplace/opportunities?profile_id=${profile.pk}&per_page=${args.limit}`)
    const ok = await handleApiError(res, "List opportunities")
    if (!ok) { prompts.outro("Done"); return }

    const data = (await res.json()) as any
    const items: any[] = data?.data?.data ?? data?.data ?? []

    if (args.json) { console.log(JSON.stringify(items, null, 2)); prompts.outro("Done"); return }

    printDivider()
    printKV("Profile", `${profile.name} (pk ${profile.pk})`)
    console.log()

    if (items.length === 0) {
      console.log(`  ${dim("(no opportunities)")}`)
    } else {
      for (const o of items) {
        const title = bold(String(o.title ?? "?"))
        const id = dim(`#${o.id}`)
        const deadline = o.application_deadline ? dim(` · deadline: ${o.application_deadline}`) : ""
        const apps = o.applications_count ? dim(` · ${o.applications_count} apps`) : ""
        console.log(`  ${title}  ${id}${deadline}${apps}`)
        if (o.description) console.log(`    ${dim(String(o.description).slice(0, 100))}`)
        console.log()
      }
    }
    printDivider()
    prompts.outro(dim(`iris opportunities create --profile ${args.slug} --title "..."`))
  },
})

// ============================================================================
// profile enrich <slug> — scrape social data and seed to API
// ============================================================================

const ProfileEnrichCommand = cmd({
  command: "enrich <slug>",
  describe: "scrape social data (Instagram, etc.) and enrich profile",
  builder: (yargs) =>
    yargs
      .positional("slug", { type: "string", demandOption: true })
      .option("platform", { type: "string", default: "instagram", describe: "platform to scrape (instagram)" })
      .option("dry-run", { type: "boolean", default: false, describe: "preview without saving" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Enrich: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const profile = await fetchProfile(args.slug)
    if (!profile) { prompts.log.error(`Profile '${args.slug}' not found`); prompts.outro("Done"); return }

    const igHandle = profile.instagram ? String(profile.instagram).replace(/^@/, "") : null
    if (!igHandle) {
      prompts.log.error("Profile has no Instagram handle — nothing to enrich")
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start(`Scraping Instagram @${igHandle}...`)

    // Scrape Instagram via the internal API (same headers as SocialMediaFeedService)
    try {
      const igRes = await fetch(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${igHandle}`, {
        headers: {
          "User-Agent": "Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229258)",
          "X-IG-App-ID": "936619743392459",
          "X-ASBD-ID": "129477",
          "X-IG-WWW-Claim": "0",
          "X-Requested-With": "XMLHttpRequest",
        },
      })

      if (!igRes.ok) {
        spinner.stop(`Instagram API returned ${igRes.status}`, 1)
        prompts.outro("Done")
        return
      }

      const igData = (await igRes.json()) as any
      const igUser = igData?.data?.user
      if (!igUser) {
        spinner.stop("Instagram returned no user data", 1)
        prompts.outro("Done")
        return
      }

      const stats = {
        username: igUser.username,
        followers: igUser.edge_followed_by?.count ?? 0,
        following: igUser.edge_follow?.count ?? 0,
        posts: igUser.edge_owner_to_timeline_media?.count ?? 0,
        full_name: igUser.full_name ?? "",
        bio: igUser.biography ?? "",
        profile_pic: igUser.profile_pic_url_hd ?? igUser.profile_pic_url ?? "",
        is_verified: igUser.is_verified ?? false,
        external_url: igUser.external_url ?? "",
      }

      // Extract recent posts
      const edges = igUser.edge_owner_to_timeline_media?.edges ?? []
      const posts = edges.slice(0, 9).map((e: any) => ({
        id: e.node?.id,
        shortcode: e.node?.shortcode,
        caption: (e.node?.edge_media_to_caption?.edges?.[0]?.node?.text ?? "").slice(0, 200),
        likes: e.node?.edge_liked_by?.count ?? 0,
        comments: e.node?.edge_media_to_comment?.count ?? 0,
        thumbnail: e.node?.thumbnail_src ?? e.node?.display_url,
        timestamp: e.node?.taken_at_timestamp,
        is_video: e.node?.is_video ?? false,
      }))

      spinner.stop(success(`Scraped @${igHandle}: ${stats.followers} followers, ${stats.posts} posts`))

      if (args.json) {
        console.log(JSON.stringify({ stats, posts }, null, 2))
      } else {
        printDivider()
        printKV("Username", `@${stats.username}`)
        printKV("Name", stats.full_name)
        printKV("Followers", stats.followers.toLocaleString())
        printKV("Following", stats.following.toLocaleString())
        printKV("Posts", stats.posts.toLocaleString())
        printKV("Verified", stats.is_verified ? "Yes" : "No")
        if (stats.bio) printKV("Bio", stats.bio.slice(0, 120))
        if (stats.external_url) printKV("URL", stats.external_url)
        if (posts.length > 0) {
          console.log()
          console.log(`  ${bold(`Recent Posts (${posts.length}):`)}`)
          for (const p of posts) {
            const likes = dim(`${p.likes} likes`)
            const cap = (p.caption || "(no caption)").slice(0, 60)
            console.log(`    ${p.is_video ? "[Video]" : "[Photo]"} ${cap}  ${likes}`)
          }
        }
        printDivider()
      }

      if (args["dry-run"]) {
        prompts.outro(dim("Dry run — not saved"))
        return
      }

      // Seed to fl-api
      const seedSpinner = prompts.spinner()
      seedSpinner.start("Seeding to API...")

      const seedRes = await irisFetch(`/api/v1/profile/${profile.pk}/social-feed`, {
        method: "POST",
        body: JSON.stringify({
          instagram: {
            stats: {
              username: stats.username,
              followers: stats.followers,
              following: stats.following,
              posts_count: stats.posts,
              full_name: stats.full_name,
              biography: stats.bio,
              profile_pic_url: stats.profile_pic,
              is_verified: stats.is_verified,
              external_url: stats.external_url,
            },
            posts: posts.map((p: any) => ({
              id: p.id,
              shortcode: p.shortcode,
              caption: p.caption,
              like_count: p.likes,
              comment_count: p.comments,
              thumbnail_url: p.thumbnail,
              timestamp: p.timestamp,
              is_video: p.is_video,
            })),
          },
        }),
      })

      if (seedRes.ok) {
        seedSpinner.stop(success("Social feed seeded"))
      } else {
        seedSpinner.stop("Seed failed (feed)", 1)
      }

      // Also seed social stats
      const statsRes = await irisFetch(`/api/v1/profile/${profile.pk}/social-stats`, {
        method: "POST",
        body: JSON.stringify({
          instagram: {
            followers: stats.followers,
            following: stats.following,
            posts: stats.posts,
            is_verified: stats.is_verified,
          },
        }),
      })
      if (statsRes.ok) {
        console.log(`  ${success("✓")} Social stats seeded`)
      }

      prompts.outro(success("Enriched"))
    } catch (err: any) {
      spinner.stop(`Scrape failed: ${err.message}`, 1)
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// profile merge --source <pk> --target <pk>
// ============================================================================

const ProfileMergeCommand = cmd({
  command: "merge",
  describe: "merge two profiles (moves content from source to target, deactivates source)",
  builder: (yargs) =>
    yargs
      .option("source", { type: "string", demandOption: true, describe: "source profile slug or PK (will be deactivated)" })
      .option("target", { type: "string", demandOption: true, describe: "target profile slug or PK (keeps this one)" })
      .option("force", { type: "boolean", default: false })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Profile Merge")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const source = await fetchProfile(args.source as string)
    if (!source) { prompts.log.error(`Source '${args.source}' not found`); prompts.outro("Done"); return }

    const target = await fetchProfile(args.target as string)
    if (!target) { prompts.log.error(`Target '${args.target}' not found`); prompts.outro("Done"); return }

    printDivider()
    console.log(`  ${bold("Source (will be deactivated):")}`)
    printKV("  Name", source.name)
    printKV("  Slug", source.id)
    printKV("  PK", source.pk)
    printKV("  Instagram", source.instagram ?? "(none)")
    console.log()
    console.log(`  ${bold("Target (will keep):")}`)
    printKV("  Name", target.name)
    printKV("  Slug", target.id)
    printKV("  PK", target.pk)
    printKV("  Instagram", target.instagram ?? "(none)")
    printDivider()

    if (!args.force) {
      const ok = await prompts.confirm({ message: `Merge ${source.name} → ${target.name}? Source will be deactivated.` })
      if (!ok || prompts.isCancel(ok)) { prompts.outro("Cancelled"); return }
    }

    const res = await irisFetch(`/api/v1/profiles/merge`, {
      method: "POST",
      body: JSON.stringify({ source_pk: source.pk, target_pk: target.pk }),
    })
    const ok = await handleApiError(res, "Merge profiles")
    if (!ok) { prompts.outro("Done"); return }

    const data = (await res.json()) as any
    const result = data?.data ?? data

    if (args.json) { console.log(JSON.stringify(result, null, 2)); prompts.outro("Done"); return }

    printDivider()
    console.log(`  ${success("✓")} Merged`)
    const moved = result?.moved ?? {}
    for (const [type, count] of Object.entries(moved)) {
      if ((count as number) > 0) printKV(`  ${type}`, `${count} moved`)
    }
    printKV("  Source", `${source.id} → deactivated`)
    printKV("  Target", `${target.id} → kept`)
    printDivider()
    prompts.outro("Done")
  },
})

export const PlatformProfileCommand = cmd({
  command: "profile",
  describe: "manage profiles (list, show, search, media, analytics, social, enrich, merge, pull/push, create)",
  builder: (yargs) =>
    yargs
      .command(ProfileListCommand)
      .command(ProfileShowCommand)
      .command(ProfileGetCommand)
      .command(ProfileSetCommand)
      .command(ProfileLinksCommand)
      .command(ProfileMembershipsCommand)
      .command(ProfileCreateCommand)
      .command(ProfileBatchCreateCommand)
      .command(ProfileReassignArticlesCommand)
      .command(ProfileMediaCommand)
      .command(ProfileAnalyticsCommand)
      .command(ProfileSearchCommand)
      .command(ProfilePullCommand)
      .command(ProfilePushCommand)
      .command(ProfileSocialCommand)
      .command(ProfileEnrichCommand)
      .command(ProfileOpportunitiesCommand)
      .command(ProfileMergeCommand)
      .demandCommand(),
  async handler() {},
})
