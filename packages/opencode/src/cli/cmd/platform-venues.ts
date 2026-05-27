import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, resolveUserId, IRIS_API } from "./iris-api"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join, basename } from "path"

// ============================================================================
// Sync helpers
// ============================================================================

const SYNC_DIR = ".iris/venues"

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

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
}

function entityFilename(e: Record<string, unknown>): string {
  return `${e.id}-${slugify(String(e.name ?? "venue"))}.json`
}

function findLocalFile(dir: string, id: number): string | undefined {
  if (!existsSync(dir)) return undefined
  const prefix = `${id}-`
  const files = require("fs").readdirSync(dir).filter((f: string) => f.startsWith(prefix) && f.endsWith(".json"))
  return files.length > 0 ? join(dir, files[0]) : undefined
}

// ============================================================================
// Display helpers
// ============================================================================

function printVenue(v: Record<string, unknown>): void {
  const name = bold(String(v.name ?? `Venue #${v.id}`))
  const id = dim(`#${v.id}`)
  const type = v.type ? `  ${dim(String(v.type))}` : ""
  const location = [v.city, v.state].filter(Boolean).join(", ")
  console.log(`  ${name}  ${id}${type}`)
  if (location) console.log(`    ${dim(location)}`)
  if (v.public_url) console.log(`    ${dim(String(v.public_url))}`)
}

// ============================================================================
// Subcommands
// ============================================================================

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list venues",
  builder: (yargs) =>
    yargs
      .option("limit", { describe: "max results", type: "number", default: 20 })
      .option("search", { alias: "q", describe: "search query", type: "string" })
      .option("type", { describe: "venue type (studio/venue/restaurant/bar/store/coffee-shop)", type: "string" })
      .option("sort", { describe: "sort order: name, trending, rating, newest", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Venues") }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Loading…")

    try {
      const params = new URLSearchParams({ limit: String(args.limit) })
      if (args.search) params.set("query", args.search)
      if (args.type) params.set("type", args.type)
      if (args.sort) params.set("sort", args.sort)

      const res = await irisFetch(`/api/v1/venues?${params}`)
      const ok = await handleApiError(res, "List venues")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); if (!args.json) prompts.outro("Done"); return }

      const raw = (await res.json()) as any
      const items: any[] = raw?.data?.data ?? raw?.data ?? (Array.isArray(raw) ? raw : [])
      if (spinner) spinner.stop(`${items.length} venue(s)`)

      if (args.json) {
        console.log(JSON.stringify(items, null, 2))
        return
      }

      if (items.length === 0) { prompts.log.warn("No venues found"); prompts.outro("Done"); return }

      printDivider()
      for (const v of items) {
        printVenue(v)
        if (args.sort === "trending" && v.search_count) {
          console.log(`    ${highlight(`[${v.search_count} searches]`)}`)
        }
        console.log()
      }
      printDivider()

      prompts.outro(dim("iris venues get <id>  |  iris venues pull <id>"))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
    }
  },
})

const GetCommand = cmd({
  command: "get <id>",
  describe: "show venue details",
  builder: (yargs) =>
    yargs.positional("id", { describe: "venue ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Venue #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/venues/${args.id}`)
      const ok = await handleApiError(res, "Get venue")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const v = data?.data ?? data
      spinner.stop(String(v.name ?? `#${v.id}`))

      printDivider()
      printKV("ID", v.id)
      printKV("Name", v.name)
      printKV("Type", v.type)
      printKV("URL", v.public_url)
      printKV("Address", v.address)
      printKV("City", v.city)
      printKV("State", v.state)
      printKV("Zip", v.zipcode)
      printKV("Phone", v.phone)
      printKV("Email", v.email)
      printKV("Website", v.website_url)
      printKV("Hourly Rate", v.hourly_rate ? `$${v.hourly_rate}` : undefined)
      printKV("Rating", v.rating)
      printKV("Instagram", v.instagram)
      printKV("Google Place ID", v.google_place_id)
      printKV("Search Count", v.search_count)
      printKV("Last Searched", v.last_searched_at)
      if (v.description) { console.log(); console.log(`  ${dim("Description:")} ${String(v.description).slice(0, 200)}`) }
      console.log()
      printDivider()

      prompts.outro(dim(`iris venues pull ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const CreateCommand = cmd({
  command: "create",
  describe: "create a new venue",
  builder: (yargs) =>
    yargs
      .option("name", { describe: "venue name", type: "string" })
      .option("type", { describe: "type (studio/venue/restaurant/bar/store/coffee-shop)", type: "string", default: "venue" })
      .option("city", { describe: "city", type: "string" })
      .option("state", { describe: "state", type: "string" })
      .option("address", { describe: "street address", type: "string" })
      .option("phone", { describe: "phone number", type: "string" })
      .option("email", { describe: "email", type: "string" })
      .option("website", { describe: "website URL", type: "string" })
      .option("hourly-rate", { describe: "hourly rate", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Venue")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let name = args.name
    if (!name) {
      name = (await prompts.text({ message: "Venue name", validate: (x) => (x && x.length > 0 ? undefined : "Required") })) as string
      if (prompts.isCancel(name)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Creating…")

    try {
      const payload: Record<string, unknown> = { name, type: args.type }
      if (args.city) payload.city = args.city
      if (args.state) payload.state = args.state
      if (args.address) payload.address = args.address
      if (args.phone) payload.phone = args.phone
      if (args.email) payload.email = args.email
      if (args.website) payload.website_url = args.website
      if (args["hourly-rate"]) payload.hourly_rate = args["hourly-rate"]

      const res = await irisFetch("/api/v1/venues", { method: "POST", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Create venue")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const v = data?.data ?? data?.venue ?? data
      spinner.stop(`${success("✓")} Created: ${bold(String(v.name ?? v.id))}`)

      printDivider()
      printKV("ID", v.id)
      printKV("Name", v.name)
      printKV("Type", v.type)
      printKV("URL", v.public_url)
      printDivider()

      prompts.outro(dim(`iris venues get ${v.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const UpdateCommand = cmd({
  command: "update <id>",
  describe: "update a venue",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "venue ID", type: "number", demandOption: true })
      .option("name", { describe: "new name", type: "string" })
      .option("type", { describe: "new type", type: "string" })
      .option("city", { describe: "new city", type: "string" })
      .option("address", { describe: "new address", type: "string" })
      .option("phone", { describe: "new phone", type: "string" })
      .option("hourly-rate", { describe: "new hourly rate", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update Venue #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const payload: Record<string, unknown> = {}
    if (args.name) payload.name = args.name
    if (args.type) payload.type = args.type
    if (args.city) payload.city = args.city
    if (args.address) payload.address = args.address
    if (args.phone) payload.phone = args.phone
    if (args["hourly-rate"]) payload.hourly_rate = args["hourly-rate"]

    if (Object.keys(payload).length === 0) {
      prompts.log.warn("Nothing to update. Use --name, --type, --city, etc.")
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const res = await irisFetch(`/api/v1/venues/${args.id}`, { method: "PUT", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Update venue")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const v = data?.data ?? data?.venue ?? data
      spinner.stop(`${success("✓")} Updated: ${bold(String(v.name ?? v.id))}`)

      printDivider()
      printKV("ID", v.id)
      printKV("Name", v.name)
      printDivider()

      prompts.outro(dim(`iris venues get ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PullCommand = cmd({
  command: "pull <id>",
  describe: "download venue JSON to local file",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "venue ID", type: "number", demandOption: true })
      .option("output", { alias: "o", describe: "output file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Pull Venue #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching…")

    try {
      const res = await irisFetch(`/api/v1/venues/${args.id}`)
      const ok = await handleApiError(res, "Pull venue")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const entity = data?.data ?? data

      const dir = resolveSyncDir()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const filename = args.output ?? entityFilename(entity)
      const filepath = filename.startsWith("/") ? filename : join(dir, filename)

      writeFileSync(filepath, JSON.stringify(entity, null, 2))
      spinner.stop(success("Pulled"))

      printDivider()
      printKV("Name", entity.name)
      printKV("ID", entity.id)
      printKV("Type", entity.type)
      printKV("City", entity.city)
      printKV("Saved to", filepath)
      printDivider()

      prompts.outro(dim(`iris venues push ${args.id}  |  iris venues diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PushCommand = cmd({
  command: "push <id>",
  describe: "upload local venue JSON to API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "venue ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Push Venue #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()

    try {
      const dir = resolveSyncDir()
      let filepath = args.file
      if (!filepath) filepath = findLocalFile(dir, args.id)

      if (!filepath || !existsSync(filepath)) {
        spinner.start("")
        spinner.stop("Failed", 1)
        prompts.log.error(`Local file not found. Run: ${highlight(`iris venues pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      spinner.start(`Pushing ${basename(filepath)}…`)

      const entity = JSON.parse(readFileSync(filepath, "utf-8"))
      const payload: Record<string, unknown> = {
        name: entity.name, type: entity.type, city: entity.city, state: entity.state,
        address: entity.address, zipcode: entity.zipcode, email: entity.email, phone: entity.phone,
        website_url: entity.website_url, description: entity.description, hourly_rate: entity.hourly_rate,
        instagram: entity.instagram, twitter: entity.twitter, slug: entity.slug,
        amenities: entity.amenities, keywords: entity.keywords, tags: entity.tags,
        studio_hours: entity.studio_hours, studio_rules: entity.studio_rules,
      }
      for (const k of Object.keys(payload)) { if (payload[k] === undefined) delete payload[k] }

      const res = await irisFetch(`/api/v1/venues/${args.id}`, { method: "PUT", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Push venue")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(success("Pushed"))

      printDivider()
      printKV("ID", args.id)
      printKV("From", filepath)
      printDivider()

      prompts.outro(dim(`iris venues diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DiffCommand = cmd({
  command: "diff <id>",
  describe: "compare local venue JSON vs live API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "venue ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diff Venue #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Comparing…")

    try {
      const res = await irisFetch(`/api/v1/venues/${args.id}`)
      const ok = await handleApiError(res, "Fetch venue")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const live = data?.data ?? data

      const dir = resolveSyncDir()
      let filepath = args.file
      if (!filepath) filepath = findLocalFile(dir, args.id)

      if (!filepath || !existsSync(filepath)) {
        spinner.stop("Failed", 1)
        prompts.log.error(`Local file not found. Run: ${highlight(`iris venues pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      const local = JSON.parse(readFileSync(filepath, "utf-8"))

      const fields = ["name", "type", "city", "state", "address", "zipcode", "email", "phone", "website_url", "description", "hourly_rate", "instagram", "rating"]
      const changes: { field: string; live: unknown; local: unknown }[] = []

      for (const f of fields) {
        if (JSON.stringify(live[f] ?? null) !== JSON.stringify(local[f] ?? null)) {
          changes.push({ field: f, live: live[f], local: local[f] })
        }
      }

      spinner.stop(changes.length === 0 ? success("In sync") : `${changes.length} difference(s)`)

      printDivider()
      printKV("Venue", live.name ?? `#${args.id}`)
      printKV("Type", live.type)
      console.log()

      if (changes.length === 0) {
        console.log(`  ${success("No differences")}`)
      } else {
        for (const c of changes) {
          console.log(`  ${UI.Style.TEXT_WARNING}~ ${c.field}${UI.Style.TEXT_NORMAL}`)
          console.log(`    ${UI.Style.TEXT_DANGER}- live:  ${String(c.live ?? "(empty)").slice(0, 120)}${UI.Style.TEXT_NORMAL}`)
          console.log(`    ${UI.Style.TEXT_SUCCESS}+ local: ${String(c.local ?? "(empty)").slice(0, 120)}${UI.Style.TEXT_NORMAL}`)
        }
      }
      console.log()
      printDivider()

      prompts.outro(changes.length > 0 ? dim(`iris venues push ${args.id}`) : "Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DeleteCommand = cmd({
  command: "delete <id>",
  describe: "delete a venue",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "venue ID", type: "number", demandOption: true })
      .option("force", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Venue #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    if (!args.force) {
      const confirmed = await prompts.confirm({ message: `Delete venue #${args.id}?` })
      if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await irisFetch(`/api/v1/venues/${args.id}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete venue")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Deleted`)
      prompts.outro(dim("iris venues list"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Search — find venues via Hive browser automation (Google Maps scraping)
// Falls back to Serper API if no Hive nodes are online.
// ============================================================================

async function findOnlineHiveNode(): Promise<{ id: string; name: string } | null> {
  try {
    const userId = await resolveUserId()
    if (!userId) return null
    const res = await irisFetch(`/api/v6/nodes/?user_id=${userId}`, {}, IRIS_API)
    if (!res.ok) return null
    const data = (await res.json()) as { nodes: Array<{ id: string; name: string; connection_status: string }> }
    return (data.nodes ?? []).find((n) => n.connection_status === "online") ?? null
  } catch { return null }
}

async function dispatchHiveSearch(node: { id: string; name: string }, query: string, limit: number): Promise<any[]> {
  const userId = await resolveUserId()

  // Self-contained Node.js script sent inline — no file dependencies on the node.
  // Uses Playwright (baked into the Hive daemon environment).
  // Strategy: Bing Maps (headless-friendly) → Google Maps fallback → DuckDuckGo fallback.
  const nodeScript = `
const { chromium } = require('playwright');
(async () => {
  const QUERY = ${JSON.stringify(query)};
  const LIMIT = ${limit};
  const log = (...a) => process.stderr.write('[venue-search] ' + a.join(' ') + '\\n');
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu'] });
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US', viewport: { width: 1280, height: 900 }
    });
    const page = await ctx.newPage();
    let venues = [];

    // ── Strategy 1: Google Maps ──
    log('Trying Google Maps...');
    try {
      await page.goto('https://www.google.com/maps/search/' + encodeURIComponent(QUERY), { waitUntil: 'networkidle', timeout: 25000 });
      await page.waitForTimeout(2000);
      // Dismiss consent
      try {
        const cb = page.locator('button:has-text("Accept all"), button:has-text("Reject all")');
        if (await cb.first().isVisible({ timeout: 1500 })) { await cb.first().click(); await page.waitForTimeout(1500); }
      } catch {}
      // Wait for feed
      try { await page.waitForSelector('div[role="feed"]', { timeout: 8000 }); } catch {}
      // Scroll
      for (let i = 0; i < Math.ceil(LIMIT/4)+1; i++) {
        try { await page.locator('div[role="feed"]').evaluate(el => el.scrollBy(0, 600)); await page.waitForTimeout(1200); } catch {}
      }
      venues = await page.evaluate((max) => {
        const items = [];
        for (const card of document.querySelectorAll('div[role="feed"] > div > div[jsaction]')) {
          if (items.length >= max) break;
          try {
            const a = card.querySelector('a[aria-label]');
            const title = a?.getAttribute('aria-label') || '';
            if (!title || title.length < 2) continue;
            const txt = card.textContent || '';
            const rm = (card.querySelector('span[role="img"]')?.getAttribute('aria-label')||'').match(/([\\d.]+)\\s*star/);
            const cm = (card.querySelector('span[role="img"]')?.getAttribute('aria-label')||'').match(/(\\d[\\d,]*)\\s*review/);
            const am = txt.match(/(\\d+\\s+[\\w\\s]+(?:St|Ave|Blvd|Dr|Rd|Ln|Way|Ct|Pkwy|Hwy|Loop|Cir|Pl)[^\\n]*)/i);
            const pm = txt.match(/\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}/);
            let website = '';
            for (const l of card.querySelectorAll('a[href]')) {
              if (l.href && !l.href.includes('google.com') && l.href.startsWith('http')) { website = l.href; break; }
            }
            items.push({ title, address: am?am[1].trim():'', rating: rm?parseFloat(rm[1]):null, ratingCount: cm?parseInt(cm[1].replace(/,/g,'')):null, phone: pm?pm[0]:'', website, photo: null, mapsUrl: a?.href||'' });
          } catch {}
        }
        return items;
      }, LIMIT);
      log('Google Maps: ' + venues.length + ' result(s)');
    } catch(e) { log('Google Maps error: ' + e.message); }

    // ── Strategy 2: Bing Maps ──
    if (venues.length === 0) {
      log('Trying Bing...');
      try {
        await page.goto('https://www.bing.com/maps?q=' + encodeURIComponent(QUERY), { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(4000);
        venues = await page.evaluate((max) => {
          const items = [];
          for (const card of document.querySelectorAll('.entity-listing-row, .b_scard, .b_algo')) {
            if (items.length >= max) break;
            const title = card.querySelector('.entity_listing_name, .lc_content h2, a')?.textContent?.trim() || '';
            if (!title) continue;
            const address = card.querySelector('.entity_listing_address, .b_factrow')?.textContent?.trim() || '';
            const phone = card.querySelector('.entity_listing_phone')?.textContent?.trim() || '';
            const rm = card.querySelector('.entity_listing_rating, .csrc')?.textContent?.match(/([\\d.]+)/);
            items.push({ title, address, rating: rm?parseFloat(rm[1]):null, ratingCount: null, phone, website: '', photo: null, mapsUrl: '' });
          }
          return items;
        }, LIMIT);
        log('Bing: ' + venues.length + ' result(s)');
      } catch(e) { log('Bing error: ' + e.message); }
    }

    // ── Strategy 3: Bing web search (most reliable headless) ──
    if (venues.length === 0) {
      log('Trying Bing web search...');
      try {
        await page.goto('https://www.bing.com/search?q=' + encodeURIComponent(QUERY), { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);
        venues = await page.evaluate((max) => {
          const items = [];
          // Bing local pack results
          for (const card of document.querySelectorAll('.b_scard, .b_ans .b_factrow, .local-results .b_algo, [data-tag="LocalResults.Places"] li, .b_localList li')) {
            if (items.length >= max) break;
            const title = card.querySelector('h2, a, .b_prominentFocusLabel, .lc_content h2')?.textContent?.trim() || '';
            if (!title || title.length < 3) continue;
            const text = card.textContent || '';
            const am = text.match(/(\\d+\\s+[\\w\\s]+(?:St|Ave|Blvd|Dr|Rd|Ln|Way|Ct|Pkwy|Hwy)[^\\n]*)/i);
            const pm = text.match(/\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}/);
            const rm = text.match(/(\\d\\.\\d)\\s*(?:\\/\\s*5|star)/i);
            if (!items.find(i => i.title === title)) {
              items.push({ title, address: am?am[1].trim():'', rating: rm?parseFloat(rm[1]):null, ratingCount: null, phone: pm?pm[0]:'', website: '', photo: null, mapsUrl: '' });
            }
          }
          return items;
        }, LIMIT);
        log('Bing web: ' + venues.length + ' result(s)');
      } catch(e) { log('Bing web error: ' + e.message); }
    }

    // ── Strategy 4: DuckDuckGo ──
    if (venues.length === 0) {
      log('Trying DuckDuckGo...');
      try {
        await page.goto('https://duckduckgo.com/?q=' + encodeURIComponent(QUERY) + '&ia=places', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);
        venues = await page.evaluate((max) => {
          const items = [];
          for (const card of document.querySelectorAll('.module--places__item, [data-testid="place"]')) {
            if (items.length >= max) break;
            const title = card.querySelector('h3, .module--places__name')?.textContent?.trim() || '';
            if (!title) continue;
            items.push({ title, address: card.querySelector('.module--places__address')?.textContent?.trim()||'', rating: null, ratingCount: null, phone: card.querySelector('.module--places__phone')?.textContent?.trim()||'', website: '', photo: null, mapsUrl: '' });
          }
          return items;
        }, LIMIT);
        log('DuckDuckGo: ' + venues.length + ' result(s)');
      } catch(e) { log('DuckDuckGo error: ' + e.message); }
    }

    // ── Email enrichment: visit each venue's website to find contact emails ──
    if (venues.length > 0) {
      log('Enriching ' + venues.length + ' venues with emails...');
      for (let i = 0; i < venues.length; i++) {
        const v = venues[i];
        // Skip if no website or already has email
        if (v.email || !v.website) continue;
        try {
          log('  Checking website: ' + v.website);
          await page.goto(v.website, { waitUntil: 'domcontentloaded', timeout: 10000 });
          await page.waitForTimeout(1500);
          const contactInfo = await page.evaluate(() => {
            const text = document.body?.innerText || '';
            const html = document.body?.innerHTML || '';
            // Find email addresses
            const emailRx = /[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}/g;
            const emails = [...new Set((text.match(emailRx) || []).concat(html.match(emailRx) || []))];
            // Filter out common junk emails
            const validEmails = emails.filter(e =>
              !e.includes('example.com') && !e.includes('sentry') &&
              !e.includes('wixpress') && !e.includes('squarespace') &&
              !e.includes('.png') && !e.includes('.jpg') &&
              !e.endsWith('.js') && !e.endsWith('.css')
            );
            // Also grab social links
            const socials = {};
            for (const a of document.querySelectorAll('a[href]')) {
              const h = a.href || '';
              if (h.includes('instagram.com/') && !socials.instagram) socials.instagram = h;
              if (h.includes('facebook.com/') && !socials.facebook) socials.facebook = h;
              if ((h.includes('twitter.com/') || h.includes('x.com/')) && !socials.twitter) socials.twitter = h;
            }
            return { emails: validEmails.slice(0, 3), socials };
          });
          if (contactInfo.emails.length > 0) {
            v.email = contactInfo.emails[0];
            v.emails = contactInfo.emails;
            log('    Found email: ' + v.email);
          }
          if (Object.keys(contactInfo.socials).length > 0) {
            v.socials = contactInfo.socials;
          }
        } catch(e) { log('  Skip ' + v.title + ': ' + e.message); }
      }
    }

    // Also try contact/about pages for venues missing emails
    for (let i = 0; i < venues.length; i++) {
      const v = venues[i];
      if (v.email || !v.website) continue;
      const contactPaths = ['/contact', '/about', '/contact-us', '/about-us'];
      for (const cp of contactPaths) {
        try {
          const base = new URL(v.website).origin;
          await page.goto(base + cp, { waitUntil: 'domcontentloaded', timeout: 8000 });
          await page.waitForTimeout(1000);
          const emails = await page.evaluate(() => {
            const rx = /[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}/g;
            return [...new Set((document.body?.innerText||'').match(rx)||[])].filter(e =>
              !e.includes('example') && !e.includes('sentry') && !e.endsWith('.png') && !e.endsWith('.js')
            );
          });
          if (emails.length > 0) {
            v.email = emails[0];
            v.emails = emails.slice(0, 3);
            log('    Found email on ' + cp + ': ' + v.email);
            break;
          }
        } catch {}
      }
    }

    console.log(JSON.stringify(venues, null, 2));
    const withEmail = venues.filter(v => v.email).length;
    log('Total: ' + venues.length + ' venue(s), ' + withEmail + ' with email');
  } catch(e) {
    log('Fatal: ' + e.message);
    console.log('[]');
  } finally {
    if (browser) await browser.close();
  }
})();
`.trim()

  // Use heredoc to avoid single-quote escaping hell.
  // Set NODE_PATH so require('playwright') resolves from the daemon's node_modules
  // regardless of which workspace dir the script runs from.
  const script = `#!/bin/bash
set -e

# Resolve daemon's node_modules for playwright
DAEMON_DIR=""
for d in ~/.iris/daemon ~/Sites/freelabel/fl-docker-dev/coding-agent-bridge; do
  [ -d "$d/node_modules/playwright" ] && DAEMON_DIR="$d" && break
done

if [ -n "$DAEMON_DIR" ]; then
  export NODE_PATH="$DAEMON_DIR/node_modules:$NODE_PATH"
fi

SCRIPT_FILE=$(mktemp /tmp/iris-venue-search-XXXXXX.js)
cat > "$SCRIPT_FILE" << 'VENUE_SEARCH_EOF'
${nodeScript}
VENUE_SEARCH_EOF
node "$SCRIPT_FILE"
EXIT_CODE=$?
rm -f "$SCRIPT_FILE"
exit $EXIT_CODE`

  const createRes = await irisFetch(`/api/v6/nodes/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      title: `venue-search: ${query.slice(0, 60)}`,
      type: "sandbox_execute",
      node_id: node.id,
      prompt: script,
      config: { timeout_seconds: 120 },
      timeout_seconds: 120,
    }),
  }, IRIS_API)

  if (!createRes.ok) throw new Error(`Hive dispatch failed: ${createRes.status}`)

  const created = (await createRes.json()) as { task: { id: string; status: string } }
  const taskId = created.task.id

  // Poll for completion
  const deadline = Date.now() + 150_000
  const terminal = new Set(["succeeded", "completed", "failed", "cancelled", "timeout", "errored"])

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    const r = await irisFetch(`/api/v6/nodes/tasks/${taskId}?user_id=${userId}`, {}, IRIS_API)
    if (!r.ok) continue
    const body = (await r.json()) as { task: any }
    const t = body.task

    if (terminal.has(t.status)) {
      if (t.status === "succeeded" || t.status === "completed") {
        // Parse JSON from task output
        const output = t.output || t.result || ""
        try {
          // Output may have log lines on stderr, JSON on stdout
          // Try parsing the whole thing first, then extract JSON array
          const parsed = JSON.parse(typeof output === "string" ? output : JSON.stringify(output))
          return Array.isArray(parsed) ? parsed : []
        } catch {
          // Try to find JSON array in output
          const match = (typeof output === "string" ? output : "").match(/\[[\s\S]*\]/)
          if (match) {
            try { return JSON.parse(match[0]) } catch { /* not valid JSON */ }
          }
          return []
        }
      }
      throw new Error(`Hive task ${t.status}: ${t.error || t.output || "unknown error"}`)
    }
  }
  throw new Error("Hive task timed out after 150s")
}

const SearchCommand = cmd({
  command: "search <query>",
  describe: "search for venues via Hive browser (Google Maps). Falls back to Serper API if no nodes online.",
  aliases: ["find", "scrape"],
  builder: (yargs) =>
    yargs
      .positional("query", { describe: "search query (e.g. 'concert venues in Dallas TX')", type: "string", demandOption: true })
      .option("limit", { describe: "max results", type: "number", default: 10 })
      .option("save", { describe: "auto-create venues from results", type: "boolean", default: false })
      .option("type", { describe: "venue type to assign on save", type: "string", default: "venue" })
      .option("serper", { describe: "force Serper API instead of Hive browser", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Venue Search") }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    let places: any[] = []
    let searchMethod = "hive"

    try {
      // ── Strategy: Hive browser first, Serper fallback ──
      if (!args.serper) {
        if (spinner) spinner.start("Finding online Hive node…")
        const node = await findOnlineHiveNode()

        if (node) {
          if (spinner) spinner.stop(`${success("✓")} Node: ${bold(node.name)}`)
          const hiveSpinner = args.json ? null : prompts.spinner()
          if (hiveSpinner) hiveSpinner.start(`Searching via Hive browser: ${args.query}…`)

          try {
            places = await dispatchHiveSearch(node, args.query, args.limit)
            if (hiveSpinner) hiveSpinner.stop(`${places.length} venue(s) found via Hive`)
          } catch (hiveErr) {
            if (hiveSpinner) hiveSpinner.stop(`Hive search failed: ${hiveErr instanceof Error ? hiveErr.message : String(hiveErr)}`, 1)
            if (!args.json) prompts.log.warn("Falling back to Serper API…")
            searchMethod = "serper-fallback"
          }
        } else {
          if (spinner) spinner.stop("No Hive nodes online")
          if (!args.json) prompts.log.warn("No Hive nodes online — falling back to Serper API")
          searchMethod = "serper-fallback"
        }
      } else {
        searchMethod = "serper"
      }

      // ── Serper fallback ──
      if (places.length === 0 && searchMethod !== "hive") {
        if (spinner) spinner.start(`Searching via Serper: ${args.query}…`)
        const userId = await resolveUserId()
        const queryWords = args.query.trim().split(/\s+/)
        const locationHint = queryWords.length > 3 ? queryWords.slice(-2).join(" ") : ""
        const res = await irisFetch("/api/v1/tools/execute", {
          method: "POST",
          body: JSON.stringify({
            tool: "searchPlaces",
            params: { query: args.query, location: locationHint },
            user_id: userId,
          }),
        }, IRIS_API)
        const ok = await handleApiError(res, "Search venues")
        if (!ok) { if (spinner) spinner.stop("Failed", 1); if (!args.json) prompts.outro("Done"); return }

        const raw = (await res.json()) as any
        const toolResult = raw?.result ?? raw?.data ?? raw
        places = (toolResult?.results ?? toolResult?.places ?? []).slice(0, args.limit)
        if (spinner) spinner.stop(`${places.length} venue(s) found via Serper`)
      }

      if (args.json && !args.save) { console.log(JSON.stringify(places, null, 2)); return }

      if (places.length === 0) {
        if (!args.json) prompts.log.warn("No venues found for that query")
        if (!args.json) prompts.outro(dim("Try a different search, e.g. 'music venues in Little Rock AR'"))
        return
      }

      // Check each result against existing venues for dedup
      const dedupSpinner = args.json ? null : prompts.spinner()
      if (dedupSpinner) dedupSpinner.start("Checking for duplicates…")

      const enrichedPlaces: Array<any & { _existing?: any; _isNew: boolean }> = []
      for (const p of places) {
        const placeId = p.cid || p.place_id || null
        let existing: any = null

        // Dedup by name match (browser results don't have google place IDs)
        const searchName = p.title || p.name || ""
        if (searchName) {
          try {
            const checkRes = await irisFetch(`/api/v1/venues?query=${encodeURIComponent(searchName)}&limit=5`)
            if (checkRes.ok) {
              const checkRaw = (await checkRes.json()) as any
              const candidates: any[] = checkRaw?.data?.data ?? checkRaw?.data ?? []
              existing = candidates.find((c: any) =>
                (placeId && c.google_place_id === placeId) ||
                (c.name && searchName && c.name.toLowerCase() === searchName.toLowerCase())
              ) || null
            }
          } catch { /* ignore lookup failures */ }
        }

        enrichedPlaces.push({ ...p, _existing: existing, _isNew: !existing })
      }
      if (dedupSpinner) dedupSpinner.stop("Dedup complete")

      if (!args.save) {
        // Display-only mode with dedup badges
        printDivider()
        for (const p of enrichedPlaces) {
          const badge = p._existing
            ? highlight(`[EXISTS x${p._existing.search_count || 1}]`)
            : success("[NEW]")
          console.log(`  ${bold(p.title || p.name || "Unknown")}  ${badge}`)
          if (p.address) console.log(`    ${dim(p.address)}`)
          const meta = [p.rating ? `★ ${p.rating}` : null, p.ratingCount ? `(${p.ratingCount})` : null, p.phone, p.website].filter(Boolean)
          if (meta.length) console.log(`    ${dim(meta.join("  ·  "))}`)
          if (p.email) console.log(`    ${success(p.email)}`)
          if (p.category) console.log(`    ${dim(p.category)}`)
          console.log()
        }
        printDivider()
        prompts.log.info(dim(`Search method: ${searchMethod}`))
        prompts.outro(dim("Add --save to auto-create these as venue records"))
        return
      }

      // Save mode — create or touch venues
      const saveSpinner = prompts.spinner()
      saveSpinner.start("Creating/updating venue records…")
      let created = 0
      let touched = 0

      for (const p of enrichedPlaces) {
        if (p._existing) {
          // Venue exists — increment touch via PUT
          try {
            await irisFetch(`/api/v1/venues/${p._existing.id}`, { method: "PUT", body: JSON.stringify({}) })
            touched++
          } catch { /* skip */ }
          continue
        }

        const payload: Record<string, unknown> = {
          name: p.title || p.name,
          type: args.type,
          address: p.address || null,
          phone: p.phone || null,
          website_url: p.website || p.website_url || null,
          rating: p.rating || null,
          rating_count: p.ratingCount || null,
          google_place_id: p.cid || p.place_id || null,
          photo: p.photo || null,
          email: p.email || null,
          instagram: p.socials?.instagram || null,
          data_source: searchMethod === "hive" ? "hive-browser" : "searchPlaces",
        }
        // Try to parse city/state from address
        const addrParts = (p.address || "").split(",").map((s: string) => s.trim())
        if (addrParts.length >= 2) {
          payload.city = addrParts[addrParts.length - 2] || null
          const stateZip = addrParts[addrParts.length - 1] || ""
          const stateMatch = stateZip.match(/^([A-Z]{2})\b/)
          if (stateMatch) payload.state = stateMatch[1]
        }

        try {
          const createRes = await irisFetch("/api/v1/venues", { method: "POST", body: JSON.stringify(payload) })
          if (createRes.ok) created++
        } catch { /* skip individual failures */ }
      }

      const summary = [created > 0 ? `${created} created` : null, touched > 0 ? `${touched} touched` : null].filter(Boolean).join(", ")
      saveSpinner.stop(`${success("✓")} ${summary || "No changes"}`)

      if (args.json) {
        console.log(JSON.stringify({ created, touched, total: places.length, method: searchMethod, places }, null, 2))
      }

      prompts.outro(dim("iris venues list --sort trending"))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
    }
  },
})

// ============================================================================
// Enrich — backfill venue data from Serper Places + Images
// ============================================================================

const EnrichCommand = cmd({
  command: "enrich <id>",
  describe: "enrich a venue with Google Places data (rating, phone, address, photos)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "venue ID (or 'all' to enrich all venues missing data)", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Enrich Venue${args.id === "all" ? "s" : " #" + args.id}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()

    // Determine which venues to enrich
    let venueIds: number[] = []
    if (args.id === "all") {
      if (spinner) spinner.start("Finding venues that need enrichment…")
      const listRes = await irisFetch("/api/v1/venues?limit=100")
      if (!listRes.ok) { if (spinner) spinner.stop("Failed", 1); if (!args.json) prompts.outro("Done"); return }
      const listRaw = (await listRes.json()) as any
      const allVenues: any[] = listRaw?.data?.data ?? listRaw?.data ?? (Array.isArray(listRaw) ? listRaw : [])
      venueIds = allVenues
        .filter((v: any) => !v.google_place_id || !v.photo || !v.description)
        .map((v: any) => Number(v.id))
      if (spinner) spinner.stop(`${venueIds.length} venue(s) need enrichment`)
      if (venueIds.length === 0) { if (!args.json) prompts.outro("All venues already enriched"); return }
    } else {
      venueIds = [Number(args.id)]
    }

    const results: any[] = []
    for (const vid of venueIds) {
      if (spinner) spinner.start(`Enriching venue #${vid}…`)

      // Fetch current venue data
      const getRes = await irisFetch(`/api/v1/venues/${vid}`)
      if (!getRes.ok) { if (spinner) spinner.stop(`#${vid}: not found`, 1); continue }
      const venueData = (await getRes.json()) as any
      const venue = venueData?.data ?? venueData?.venue ?? venueData

      // Search Serper for this venue
      const city = venue.city || ""
      const state = venue.state || ""
      const locationStr = [city, state].filter(Boolean).join(", ")
      const searchQuery = `${venue.name} ${locationStr}`

      const enrichUserId = await resolveUserId()
      const searchRes = await irisFetch("/api/v1/tools/execute", {
        method: "POST",
        body: JSON.stringify({
          tool: "searchPlaces",
          params: { query: searchQuery, location: locationStr },
          user_id: enrichUserId || 193,
        }),
      }, IRIS_API)

      if (!searchRes.ok) { if (spinner) spinner.stop(`#${vid}: search failed`, 1); continue }
      const searchRaw = (await searchRes.json()) as any
      const searchResult = searchRaw?.result ?? searchRaw?.data ?? searchRaw
      const places: any[] = searchResult?.results ?? searchResult?.places ?? []
      const match = places[0]

      if (!match) {
        if (spinner) spinner.stop(`#${vid}: no match found`)
        results.push({ id: vid, name: venue.name, status: "no_match" })
        continue
      }

      // Build update payload
      const update: Record<string, unknown> = {}
      if (match.phone && !venue.phone) update.phone = match.phone
      if (match.website && !venue.website_url) update.website_url = match.website
      if (match.rating) update.rating = match.rating
      if (match.address && !venue.address) update.address = match.address

      if (Object.keys(update).length === 0) {
        if (spinner) spinner.stop(`#${vid}: already up to date`)
        results.push({ id: vid, name: venue.name, status: "up_to_date" })
        continue
      }

      // Apply update
      const updateRes = await irisFetch(`/api/v1/venues/${vid}`, { method: "PUT", body: JSON.stringify(update) })
      if (updateRes.ok) {
        if (spinner) spinner.stop(`${success("✓")} #${vid} ${venue.name}: enriched (${Object.keys(update).join(", ")})`)
        results.push({ id: vid, name: venue.name, status: "enriched", fields: Object.keys(update) })
      } else {
        if (spinner) spinner.stop(`#${vid}: update failed`, 1)
        results.push({ id: vid, name: venue.name, status: "update_failed" })
      }
    }

    if (args.json) { console.log(JSON.stringify(results, null, 2)); return }
    prompts.outro(dim("iris venues list"))
  },
})

// ============================================================================
// Discover — full venue outreach pipeline (Eventbrite + DDG + AI tour-seed)
// Wraps the existing tests/e2e/venue-outreach.spec.ts Playwright pipeline
// ============================================================================

function findProjectRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "tests", "e2e", "venue-outreach.spec.ts"))) return dir
    if (existsSync(join(dir, "fl-docker-dev"))) return dir
    const parent = join(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

const DiscoverCommand = cmd({
  command: "discover <cities>",
  describe: "discover, enrich & outreach venues via full pipeline (Eventbrite + DDG + AI tour-seed)",
  builder: (yargs) =>
    yargs
      .positional("cities", { describe: "comma-separated city slugs (e.g. 'houston,dallas,atlanta')", type: "string", demandOption: true })
      .option("artist", { describe: "artist name for tour-seeded discovery + email context", type: "string" })
      .option("genre", { describe: "music genre (default: hip-hop)", type: "string", default: "hip-hop" })
      .option("seed-artists", { describe: "comma-separated similar artists to seed", type: "string" })
      .option("limit", { describe: "venues to process per city", type: "number", default: 15 })
      .option("board", { describe: "board/bloq ID for lead creation", type: "number", default: 292 })
      .option("enrich", { describe: "also enrich venues (scrape emails + socials)", type: "boolean", default: false })
      .option("email", { describe: "also generate + send booking inquiry emails", type: "boolean", default: false })
      .option("dry", { describe: "preview mode — no saves or sends", type: "boolean", default: false })
      .option("tour-seed-max", { describe: "max AI-recommended cities to add", type: "number", default: 8 }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Venue Discovery Pipeline`)

    const root = findProjectRoot()
    const specPath = join(root, "tests", "e2e", "venue-outreach.spec.ts")

    if (!existsSync(specPath)) {
      prompts.log.error(`Pipeline not found at: ${specPath}`)
      prompts.log.warn("Run from the freelabel project root directory")
      prompts.outro("Done")
      return
    }

    // Build env vars for the Playwright pipeline
    const env: Record<string, string> = {
      CITIES: args.cities,
      DISCOVER: "1",
      LIMIT: String(args.limit),
      BOARD_ID: String(args.board),
    }
    if (args.enrich) env.ENRICH = "1"
    if (args.email) env.EMAIL = "1"
    if (args.dry) env.DRY_RUN = "1"
    if (args.artist) env.ARTIST_NAME = args.artist
    if (args.genre) env.GENRE = args.genre
    if (args["seed-artists"]) env.SEED_ARTISTS = args["seed-artists"]
    if (args["tour-seed-max"]) env.TOUR_SEED_MAX = String(args["tour-seed-max"])

    // Display run config
    const cityDisplay = args.cities.split(",").map((c: string) => c.trim().replace(/-/g, " ")).join(", ")
    const phases = ["Discover", args.enrich ? "Enrich" : null, args.email ? "Email" : null].filter(Boolean).join(" → ")

    printDivider()
    printKV("Cities", cityDisplay)
    printKV("Phases", phases)
    printKV("Limit", `${args.limit}/city`)
    printKV("Board", args.board)
    if (args.artist) printKV("Artist", args.artist)
    if (args["seed-artists"]) printKV("Seed Artists", args["seed-artists"])
    if (args.dry) printKV("Mode", "DRY RUN (no saves)")
    printDivider()
    console.log()

    const spinner = prompts.spinner()
    spinner.start("Running venue outreach pipeline…")

    try {
      const { execSync } = require("child_process")
      const timeout = Math.max(600000, args.limit * (args.enrich ? 3 : 1) * 120000)
      const cmd = `npx playwright test tests/e2e/venue-outreach.spec.ts --headed --timeout ${timeout}`

      spinner.stop("Pipeline started — output below:")
      console.log()

      execSync(cmd, {
        stdio: "inherit",
        cwd: root,
        env: { ...process.env, ...env },
      })

      console.log()
      prompts.log.success("Pipeline completed")
      prompts.outro(dim("iris venues list --sort trending"))
    } catch (err: any) {
      console.log()
      if (err.status) {
        prompts.log.error(`Pipeline exited with code ${err.status}`)
      } else {
        prompts.log.error(err instanceof Error ? err.message : String(err))
      }
      prompts.outro(dim("Check output above for details"))
    }
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformVenuesCommand = cmd({
  command: "venues",
  aliases: ["studios"],
  describe: "manage venues & studios — pull, push, diff, CRUD, search (Hive browser), enrich",
  builder: (yargs) =>
    yargs
      .command(ListCommand)
      .command(GetCommand)
      .command(CreateCommand)
      .command(UpdateCommand)
      .command(PullCommand)
      .command(PushCommand)
      .command(DiffCommand)
      .command(DeleteCommand)
      .command(SearchCommand)
      .command(EnrichCommand)
      .command(DiscoverCommand)
      .demandCommand(),
  async handler() {},
})
