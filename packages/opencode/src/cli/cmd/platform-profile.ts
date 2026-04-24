import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"

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
    const profile = data?.data ?? data

    // Link to lead if --lead-id provided
    const leadId = args["lead-id"] as number | undefined
    if (leadId && profile.pk) {
      try {
        const linkRes = await irisFetch(`/api/v1/leads/${leadId}`, {
          method: "PUT",
          body: JSON.stringify({ profile_id: profile.pk }),
        })
        if (linkRes.ok) {
          spinner.stop(success(`${name} created + linked to lead #${leadId}`))
        } else {
          spinner.stop(success(`${name} created (lead link failed — update lead manually)`))
        }
      } catch {
        spinner.stop(success(`${name} created (lead link failed)`))
      }
    } else {
      spinner.stop(success(`${name} created`))
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

export const PlatformProfileCommand = cmd({
  command: "profile",
  describe: "manage profiles (show, get, set, create, links, memberships, reassign-articles)",
  builder: (yargs) =>
    yargs
      .command(ProfileShowCommand)
      .command(ProfileGetCommand)
      .command(ProfileSetCommand)
      .command(ProfileLinksCommand)
      .command(ProfileMembershipsCommand)
      .command(ProfileCreateCommand)
      .command(ProfileReassignArticlesCommand)
      .demandCommand(),
  async handler() {},
})
