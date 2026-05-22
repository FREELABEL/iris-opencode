import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, FL_API } from "./iris-api"

// ============================================================================
// Sponsors subcommand
// ============================================================================

const SponsorsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list current discover page sponsors",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Discover Sponsors")

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await fetch(`${FL_API}/api/v1/public/discover-config`, {
        headers: { Accept: "application/json" },
      })

      if (!res.ok) {
        spinner.stop("Failed", 1)
        prompts.log.error(`HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as any
      const sponsors: string[] = data?.data?.sponsors ?? []
      spinner.stop(`${sponsors.length} sponsor(s)`)

      if (args.json) {
        console.log(JSON.stringify({ sponsors }, null, 2))
        prompts.outro("Done")
        return
      }

      printDivider()
      if (sponsors.length === 0) {
        console.log(`  ${dim("No sponsors configured")}`)
      } else {
        for (const s of sponsors) {
          console.log(`  ${bold(s)}  ${dim(`→ /@${s}`)}`)
        }
      }
      console.log()
      printDivider()

      prompts.outro(dim("iris discover sponsors add <username>  |  iris discover sponsors remove <username>"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const SponsorsAddCommand = cmd({
  command: "add <username>",
  describe: "add a sponsor profile to the discover page",
  builder: (yargs) =>
    yargs.positional("username", { describe: "profile username (e.g. moore-life)", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Add Sponsor: ${args.username}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      // Get current sponsors
      const getRes = await irisFetch("/api/v1/platform-config/discover.sponsors")
      let sponsors: string[] = []

      if (getRes.ok) {
        const getData = (await getRes.json()) as any
        sponsors = getData?.data?.value ?? []
      }

      if (sponsors.includes(args.username)) {
        spinner.stop(`${args.username} is already a sponsor`)
        prompts.outro("Done")
        return
      }

      sponsors.push(args.username)

      const putRes = await irisFetch("/api/v1/platform-config/discover.sponsors", {
        method: "PUT",
        body: JSON.stringify({ value: sponsors }),
      })
      const ok = await handleApiError(putRes, "Add sponsor")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Added ${bold(args.username)}`)

      printDivider()
      console.log(`  ${dim("Current sponsors:")} ${sponsors.join(", ")}`)
      printDivider()

      prompts.outro(dim("iris discover sponsors list"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const SponsorsRemoveCommand = cmd({
  command: "remove <username>",
  aliases: ["rm", "delete"],
  describe: "remove a sponsor from the discover page",
  builder: (yargs) =>
    yargs.positional("username", { describe: "profile username to remove", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Remove Sponsor: ${args.username}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const getRes = await irisFetch("/api/v1/platform-config/discover.sponsors")
      let sponsors: string[] = []

      if (getRes.ok) {
        const getData = (await getRes.json()) as any
        sponsors = getData?.data?.value ?? []
      }

      if (!sponsors.includes(args.username)) {
        spinner.stop(`${args.username} is not a sponsor`)
        prompts.outro("Done")
        return
      }

      sponsors = sponsors.filter((s) => s !== args.username)

      const putRes = await irisFetch("/api/v1/platform-config/discover.sponsors", {
        method: "PUT",
        body: JSON.stringify({ value: sponsors }),
      })
      const ok = await handleApiError(putRes, "Remove sponsor")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Removed ${bold(args.username)}`)

      printDivider()
      console.log(`  ${dim("Remaining sponsors:")} ${sponsors.length > 0 ? sponsors.join(", ") : "(none)"}`)
      printDivider()

      prompts.outro(dim("iris discover sponsors list"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const SponsorsCommand = cmd({
  command: "sponsors",
  describe: "manage sponsor profiles on the discover page",
  builder: (yargs) =>
    yargs
      .command(SponsorsListCommand)
      .command(SponsorsAddCommand)
      .command(SponsorsRemoveCommand)
      .demandCommand(),
  async handler() {},
})

// ============================================================================
// Streamers subcommand (same pattern as sponsors, config key: discover.streamers)
// ============================================================================

const StreamersListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list featured streamers on the discover page",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Featured Streamers")
    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const res = await fetch(`${FL_API}/api/v1/public/discover-config`, { headers: { Accept: "application/json" } })
      if (!res.ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const data = (await res.json()) as any
      const streamers: string[] = data?.data?.streamers ?? []
      spinner.stop(`${streamers.length} streamer(s)`)
      if (args.json) { console.log(JSON.stringify({ streamers }, null, 2)); prompts.outro("Done"); return }
      printDivider()
      if (streamers.length === 0) { console.log(`  ${dim("No streamers configured")}`) }
      else { for (const s of streamers) console.log(`  ${bold(s)}  ${dim(`→ /@${s}`)}`) }
      console.log()
      printDivider()
      prompts.outro(dim("iris discover streamers add <username>  |  iris discover streamers remove <username>"))
    } catch (err) { spinner.stop("Error", 1); prompts.log.error(err instanceof Error ? err.message : String(err)); prompts.outro("Done") }
  },
})

const StreamersAddCommand = cmd({
  command: "add <username>",
  describe: "add a featured streamer to the discover page",
  builder: (yargs) => yargs.positional("username", { describe: "profile username", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Add Streamer: ${args.username}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const spinner = prompts.spinner()
    spinner.start("Updating…")
    try {
      const getRes = await irisFetch("/api/v1/platform-config/discover.streamers")
      let streamers: string[] = getRes.ok ? ((await getRes.json()) as any)?.data?.value ?? [] : []
      if (streamers.includes(args.username)) { spinner.stop(`${args.username} is already a streamer`); prompts.outro("Done"); return }
      streamers.push(args.username)
      const putRes = await irisFetch("/api/v1/platform-config/discover.streamers", { method: "PUT", body: JSON.stringify({ value: streamers }) })
      const ok = await handleApiError(putRes, "Add streamer")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop(`${success("✓")} Added ${bold(args.username)}`)
      printDivider()
      console.log(`  ${dim("Current streamers:")} ${streamers.join(", ")}`)
      printDivider()
      prompts.outro(dim("iris discover streamers list"))
    } catch (err) { spinner.stop("Error", 1); prompts.log.error(err instanceof Error ? err.message : String(err)); prompts.outro("Done") }
  },
})

const StreamersRemoveCommand = cmd({
  command: "remove <username>",
  aliases: ["rm", "delete"],
  describe: "remove a featured streamer from the discover page",
  builder: (yargs) => yargs.positional("username", { describe: "profile username to remove", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Remove Streamer: ${args.username}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const spinner = prompts.spinner()
    spinner.start("Updating…")
    try {
      const getRes = await irisFetch("/api/v1/platform-config/discover.streamers")
      let streamers: string[] = getRes.ok ? ((await getRes.json()) as any)?.data?.value ?? [] : []
      if (!streamers.includes(args.username)) { spinner.stop(`${args.username} is not a streamer`); prompts.outro("Done"); return }
      streamers = streamers.filter((s) => s !== args.username)
      const putRes = await irisFetch("/api/v1/platform-config/discover.streamers", { method: "PUT", body: JSON.stringify({ value: streamers }) })
      const ok = await handleApiError(putRes, "Remove streamer")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop(`${success("✓")} Removed ${bold(args.username)}`)
      printDivider()
      console.log(`  ${dim("Remaining streamers:")} ${streamers.length > 0 ? streamers.join(", ") : "(none)"}`)
      printDivider()
      prompts.outro(dim("iris discover streamers list"))
    } catch (err) { spinner.stop("Error", 1); prompts.log.error(err instanceof Error ? err.message : String(err)); prompts.outro("Done") }
  },
})

const StreamersCommand = cmd({
  command: "streamers",
  describe: "manage featured streamers on the discover page",
  builder: (yargs) =>
    yargs
      .command(StreamersListCommand)
      .command(StreamersAddCommand)
      .command(StreamersRemoveCommand)
      .demandCommand(),
  async handler() {},
})

// ============================================================================
// Generic config-list helpers (used by producers + instrumentals)
// ============================================================================

async function readConfigList(key: string): Promise<unknown[]> {
  const res = await irisFetch(`/api/v1/platform-config/${key}`)
  if (!res.ok) return []
  const data = (await res.json()) as any
  const value = data?.data?.value
  return Array.isArray(value) ? value : []
}

async function writeConfigList(key: string, value: unknown[]): Promise<Response> {
  return irisFetch(`/api/v1/platform-config/${key}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  })
}

async function readConfigObject(key: string): Promise<Record<string, unknown>> {
  const res = await irisFetch(`/api/v1/platform-config/${key}`)
  if (!res.ok) return {}
  const data = (await res.json()) as any
  const value = data?.data?.value
  return (value && typeof value === "object" && !Array.isArray(value)) ? value : {}
}

async function writeConfigObject(key: string, value: Record<string, unknown>): Promise<Response> {
  return irisFetch(`/api/v1/platform-config/${key}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  })
}

// ============================================================================
// Producers subcommand (config key: discover.producers)
// ============================================================================

const ProducersListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list featured producers on the discover page",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Featured Producers")
    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const res = await fetch(`${FL_API}/api/v1/public/discover-config`, { headers: { Accept: "application/json" } })
      if (!res.ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const data = (await res.json()) as any
      const producers: string[] = data?.data?.producers ?? []
      spinner.stop(`${producers.length} producer(s)`)

      if (args.json) { console.log(JSON.stringify({ producers }, null, 2)); prompts.outro("Done"); return }

      printDivider()
      if (producers.length === 0) console.log(`  ${dim("No producers configured")}`)
      else for (const p of producers) console.log(`  ${bold(p)}  ${dim(`→ /@${p}`)}`)
      console.log()
      printDivider()
      prompts.outro(dim("iris discover producers add <username>  |  iris discover producers remove <username>"))
    } catch (err) { spinner.stop("Error", 1); prompts.log.error(err instanceof Error ? err.message : String(err)); prompts.outro("Done") }
  },
})

const ProducersAddCommand = cmd({
  command: "add <username>",
  describe: "feature a producer profile on the discover page",
  builder: (yargs) => yargs.positional("username", { describe: "profile username", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Add Producer: ${args.username}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const spinner = prompts.spinner()
    spinner.start("Updating…")
    try {
      const producers = (await readConfigList("discover.producers")) as string[]
      if (producers.includes(args.username)) { spinner.stop(`${args.username} already featured`); prompts.outro("Done"); return }
      producers.push(args.username)
      const putRes = await writeConfigList("discover.producers", producers)
      const ok = await handleApiError(putRes, "Add producer")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop(`${success("✓")} Featured ${bold(args.username)}`)
      printDivider()
      console.log(`  ${dim("Featured producers:")} ${producers.join(", ")}`)
      printDivider()
      prompts.outro(dim("iris discover producers list"))
    } catch (err) { spinner.stop("Error", 1); prompts.log.error(err instanceof Error ? err.message : String(err)); prompts.outro("Done") }
  },
})

const ProducersRemoveCommand = cmd({
  command: "remove <username>",
  aliases: ["rm", "delete"],
  describe: "remove a featured producer from the discover page",
  builder: (yargs) => yargs.positional("username", { describe: "profile username to remove", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Remove Producer: ${args.username}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const spinner = prompts.spinner()
    spinner.start("Updating…")
    try {
      let producers = (await readConfigList("discover.producers")) as string[]
      if (!producers.includes(args.username)) { spinner.stop(`${args.username} is not featured`); prompts.outro("Done"); return }
      producers = producers.filter((p) => p !== args.username)
      const putRes = await writeConfigList("discover.producers", producers)
      const ok = await handleApiError(putRes, "Remove producer")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop(`${success("✓")} Removed ${bold(args.username)}`)
      printDivider()
      console.log(`  ${dim("Remaining producers:")} ${producers.length > 0 ? producers.join(", ") : "(none)"}`)
      printDivider()
      prompts.outro(dim("iris discover producers list"))
    } catch (err) { spinner.stop("Error", 1); prompts.log.error(err instanceof Error ? err.message : String(err)); prompts.outro("Done") }
  },
})

const ProducersCommand = cmd({
  command: "producers",
  describe: "manage featured producers on the discover page",
  builder: (yargs) =>
    yargs
      .command(ProducersListCommand)
      .command(ProducersAddCommand)
      .command(ProducersRemoveCommand)
      .demandCommand(),
  async handler() {},
})

// ============================================================================
// Instrumentals subcommand (config key: discover.instrumentals — array of IDs)
// ============================================================================

const InstrumentalsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list curated instrumentals on the community tab",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Curated Instrumentals")
    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const res = await fetch(`${FL_API}/api/v1/public/discover-config`, { headers: { Accept: "application/json" } })
      if (!res.ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const data = (await res.json()) as any
      const instrumentals: any[] = data?.data?.instrumentals ?? []
      spinner.stop(`${instrumentals.length} instrumental(s)`)

      if (args.json) { console.log(JSON.stringify({ instrumentals }, null, 2)); prompts.outro("Done"); return }

      printDivider()
      if (instrumentals.length === 0) console.log(`  ${dim("No instrumentals curated")}`)
      else for (const i of instrumentals) {
        const producer = i.producer?.username ? dim(`@${i.producer.username}`) : ""
        console.log(`  ${dim(`#${i.id}`)}  ${bold(String(i.title ?? "Untitled"))}  ${producer}`)
      }
      console.log()
      printDivider()
      prompts.outro(dim("iris discover instrumentals add <id>  |  iris discover instrumentals remove <id>"))
    } catch (err) { spinner.stop("Error", 1); prompts.log.error(err instanceof Error ? err.message : String(err)); prompts.outro("Done") }
  },
})

const InstrumentalsAddCommand = cmd({
  command: "add <id>",
  describe: "curate an instrumental for the community tab",
  builder: (yargs) => yargs.positional("id", { describe: "instrumental ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Curate Instrumental #${args.id}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const spinner = prompts.spinner()
    spinner.start("Updating…")
    try {
      const ids = (await readConfigList("discover.instrumentals")) as number[]
      const numericIds = ids.map((x) => Number(x))
      if (numericIds.includes(Number(args.id))) { spinner.stop(`#${args.id} already curated`); prompts.outro("Done"); return }
      numericIds.push(Number(args.id))
      const putRes = await writeConfigList("discover.instrumentals", numericIds)
      const ok = await handleApiError(putRes, "Add instrumental")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop(`${success("✓")} Curated #${args.id}`)
      printDivider()
      console.log(`  ${dim("Curated IDs:")} ${numericIds.join(", ")}`)
      printDivider()
      prompts.outro(dim("iris discover instrumentals list"))
    } catch (err) { spinner.stop("Error", 1); prompts.log.error(err instanceof Error ? err.message : String(err)); prompts.outro("Done") }
  },
})

const InstrumentalsRemoveCommand = cmd({
  command: "remove <id>",
  aliases: ["rm", "delete"],
  describe: "remove a curated instrumental from the community tab",
  builder: (yargs) => yargs.positional("id", { describe: "instrumental ID to remove", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Remove Instrumental #${args.id}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const spinner = prompts.spinner()
    spinner.start("Updating…")
    try {
      let ids = (await readConfigList("discover.instrumentals")) as number[]
      const numericIds = ids.map((x) => Number(x))
      if (!numericIds.includes(Number(args.id))) { spinner.stop(`#${args.id} is not curated`); prompts.outro("Done"); return }
      const remaining = numericIds.filter((x) => x !== Number(args.id))
      const putRes = await writeConfigList("discover.instrumentals", remaining)
      const ok = await handleApiError(putRes, "Remove instrumental")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop(`${success("✓")} Removed #${args.id}`)
      printDivider()
      console.log(`  ${dim("Remaining IDs:")} ${remaining.length > 0 ? remaining.join(", ") : "(none)"}`)
      printDivider()
      prompts.outro(dim("iris discover instrumentals list"))
    } catch (err) { spinner.stop("Error", 1); prompts.log.error(err instanceof Error ? err.message : String(err)); prompts.outro("Done") }
  },
})

const InstrumentalsCommand = cmd({
  command: "instrumentals",
  aliases: ["beats"],
  describe: "manage curated instrumentals on the community tab",
  builder: (yargs) =>
    yargs
      .command(InstrumentalsListCommand)
      .command(InstrumentalsAddCommand)
      .command(InstrumentalsRemoveCommand)
      .demandCommand(),
  async handler() {},
})

// ============================================================================
// Featured Artists subcommand (agent-curated, manual override only)
// ============================================================================

const ArtistsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "show the curator's currently featured artists + last run meta",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Featured Artists")
    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const res = await fetch(`${FL_API}/api/v1/public/discover-config`, { headers: { Accept: "application/json" } })
      if (!res.ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const data = (await res.json()) as any
      const artists: any[] = data?.data?.featuredArtists ?? []
      const meta: any = data?.data?.curator ?? {}
      spinner.stop(`${artists.length} featured artist(s)`)

      if (args.json) { console.log(JSON.stringify({ featuredArtists: artists, curator: meta }, null, 2)); prompts.outro("Done"); return }

      printDivider()
      if (meta.last_run_at) {
        printKV("Last curated", meta.last_run_at)
        if (meta.last_run_by) printKV("Curator", meta.last_run_by)
        if (meta.reason) printKV("Reason", meta.reason)
        console.log()
      }
      if (artists.length === 0) {
        console.log(`  ${dim("No artists featured — curator agent has not run yet")}`)
      } else {
        for (const a of artists) {
          const username = bold(`@${a.username}`)
          const name = a.name ? dim(`(${a.name})`) : ""
          const category = a.category ? `  ${dim(String(a.category))}` : ""
          console.log(`  ${username}  ${name}${category}`)
        }
      }
      console.log()
      printDivider()
      prompts.outro(dim("iris discover artists set <username...>  to manually override (curator owns the list)"))
    } catch (err) { spinner.stop("Error", 1); prompts.log.error(err instanceof Error ? err.message : String(err)); prompts.outro("Done") }
  },
})

const ArtistsSetCommand = cmd({
  command: "set <usernames..>",
  describe: "atomically replace the featured artists list (manual override or agent write)",
  builder: (yargs) =>
    yargs
      .positional("usernames", { describe: "profile usernames (space-separated)", type: "string", array: true, demandOption: true })
      .option("reason", { describe: "why this set was chosen (logged with the run)", type: "string" })
      .option("by", { describe: "who/what made the change (defaults to 'manual')", type: "string", default: "manual" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Set Featured Artists (${(args.usernames as string[]).length})`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const spinner = prompts.spinner()
    spinner.start("Updating…")
    try {
      const usernames = args.usernames as string[]
      const putRes = await writeConfigList("discover.featured_profiles", usernames)
      const ok = await handleApiError(putRes, "Set featured artists")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const meta = {
        last_run_at: new Date().toISOString(),
        last_run_by: String(args.by ?? "manual"),
        reason: args.reason ? String(args.reason) : null,
        count: usernames.length,
      }
      await irisFetch("/api/v1/platform-config/discover.featured_profiles_meta", {
        method: "PUT",
        body: JSON.stringify({ value: meta }),
      })

      spinner.stop(`${success("✓")} Featured ${bold(String(usernames.length))} artist(s)`)
      printDivider()
      console.log(`  ${dim("Featured:")} ${usernames.join(", ")}`)
      if (args.reason) console.log(`  ${dim("Reason:")} ${args.reason}`)
      console.log(`  ${dim("By:")} ${args.by}`)
      printDivider()
      prompts.outro(dim("iris discover artists list"))
    } catch (err) { spinner.stop("Error", 1); prompts.log.error(err instanceof Error ? err.message : String(err)); prompts.outro("Done") }
  },
})

const ArtistsCommand = cmd({
  command: "artists",
  aliases: ["featured"],
  describe: "view + manually override featured artists (normally curated by an agent on heartbeat)",
  builder: (yargs) =>
    yargs
      .command(ArtistsListCommand)
      .command(ArtistsSetCommand)
      .demandCommand(),
  async handler() {},
})

// ============================================================================
// Brands subcommand (config key: discover.brands)
// ============================================================================

// Default brand config — matches fl-api DiscoverContentController::getProfileConfiguration()
const DEFAULT_BRANDS: Record<string, { name: string; alias: string; short_description: string; description: string; category: string }> = {
  "mino marketing": { name: "Mino Marketing", alias: "marketing", short_description: "MKT", description: "Marketing & Advertising", category: "business" },
  "freelabel": { name: "FREELABEL", alias: "news", short_description: "NEWS", description: "News & Media", category: "media" },
  "noys": { name: "NOYS", alias: "music", short_description: "MUS", description: "Music & Audio", category: "entertainment" },
  "capital collective": { name: "Capital Collective", alias: "entrepreneurship", short_description: "BIZ", description: "Business & Entrepreneurship", category: "business" },
  "the know it alls": { name: "The Know It Alls", alias: "science-tech", short_description: "SCI", description: "Science & Technology", category: "education" },
  "gastro": { name: "GASTRO", alias: "food-business", short_description: "FOOD", description: "Food & Business", category: "lifestyle" },
  "rap cap": { name: "Rap Cap", alias: "urban-hiphop", short_description: "HIP", description: "Urban & Hip Hop", category: "music" },
  "amradiolive": { name: "AMRadioLIVE", alias: "live-music", short_description: "LIVE", description: "Live Music & DJ", category: "entertainment" },
  "entropy": { name: "Entropy", alias: "engineering-science", short_description: "ENG", description: "Engineering & Science", category: "education" },
  "theniea": { name: "THENIEA", alias: "economics-environmental", short_description: "ECO", description: "Economic & Environmental", category: "education" },
  "beatbox": { name: "Beatbox", alias: "beats-instrumentals", short_description: "BEATS", description: "Beats & Instrumentals", category: "music" },
}

async function readBrandsConfig(): Promise<Record<string, any>> {
  const remote = await readConfigObject("discover.brands")
  return Object.keys(remote).length > 0 ? remote : DEFAULT_BRANDS
}

const BrandsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list brand categories on the discover page",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Discover Brands")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const brands = await readBrandsConfig()
      const keys = Object.keys(brands)
      const isCustom = Object.keys(await readConfigObject("discover.brands")).length > 0
      spinner.stop(`${keys.length} brand(s)${isCustom ? "" : " (defaults)"}`)

      if (args.json) {
        console.log(JSON.stringify(brands, null, 2))
        prompts.outro("Done")
        return
      }

      printDivider()
      for (const [key, cfg] of Object.entries(brands) as [string, any][]) {
        console.log(`  ${bold(cfg.name || key)}  ${dim(cfg.alias || "")}  ${dim(cfg.category || "")}`)
      }
      printDivider()

      prompts.outro(dim("iris discover brands add <name>  |  iris discover brands remove <name>"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BrandsAddCommand = cmd({
  command: "add <name>",
  describe: "add a brand category to the discover page",
  builder: (yargs) =>
    yargs
      .positional("name", { describe: "profile name (lowercase, e.g. 'mino marketing')", type: "string", demandOption: true })
      .option("alias", { describe: "URL alias slug", type: "string" })
      .option("description", { describe: "category description", type: "string" })
      .option("short-description", { describe: "short label (3-5 chars)", type: "string" })
      .option("category", { describe: "category type", type: "string", choices: ["business", "media", "entertainment", "education", "lifestyle", "music", "technology"] }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Add Brand: ${args.name}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      // Read current (or defaults if no custom config)
      const brands = await readBrandsConfig()
      const key = String(args.name).toLowerCase()

      if (brands[key]) {
        spinner.stop(`${key} already exists`)
        prompts.outro("Done")
        return
      }

      const alias = args.alias || key.replace(/\s+/g, "-")
      const desc = args.description || args.name
      const shortDesc = args["short-description"] || alias.slice(0, 4).toUpperCase()
      const category = args.category || "business"

      brands[key] = {
        name: args.name,
        alias,
        short_description: shortDesc,
        description: desc,
        category,
      }

      const putRes = await writeConfigObject("discover.brands", brands)
      const ok = await handleApiError(putRes, "Add brand")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Added ${bold(String(args.name))}`)
      printDivider()
      printKV("Name", args.name)
      printKV("Alias", alias)
      printKV("Description", desc)
      printKV("Category", category)
      printDivider()
      prompts.outro(dim("iris discover brands list"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BrandsRemoveCommand = cmd({
  command: "remove <name>",
  aliases: ["rm", "delete"],
  describe: "remove a brand category from the discover page",
  builder: (yargs) =>
    yargs.positional("name", { describe: "profile name to remove", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Remove Brand: ${args.name}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const brands = await readBrandsConfig()
      const key = String(args.name).toLowerCase()

      if (!brands[key]) {
        spinner.stop(`${key} not found`)
        prompts.outro("Done")
        return
      }

      delete brands[key]

      const putRes = await writeConfigObject("discover.brands", brands)
      const ok = await handleApiError(putRes, "Remove brand")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Removed ${bold(String(args.name))}`)
      prompts.outro(dim("iris discover brands list"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BrandsResetCommand = cmd({
  command: "reset",
  describe: "reset brand categories to hardcoded defaults",
  builder: (yargs) => yargs,
  async handler() {
    UI.empty()
    prompts.intro("◈  Reset Brands to Defaults")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Resetting…")

    try {
      // Write defaults explicitly to reset
      const putRes = await writeConfigObject("discover.brands", DEFAULT_BRANDS as Record<string, unknown>)
      const ok = await handleApiError(putRes, "Reset brands")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Brands reset to ${Object.keys(DEFAULT_BRANDS).length} defaults`)
      prompts.outro(dim("iris discover brands list"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BrandsCommand = cmd({
  command: "brands",
  aliases: ["categories"],
  describe: "manage brand categories on the discover page content tab",
  builder: (yargs) =>
    yargs
      .command(BrandsListCommand)
      .command(BrandsAddCommand)
      .command(BrandsRemoveCommand)
      .command(BrandsResetCommand)
      .demandCommand(),
  async handler() {},
})

// ============================================================================
// Sections subcommand (config key: discover.sections)
// ============================================================================

const SECTION_NAMES = [
  "newServices", "trendingServices", "featuredServices", "products",
  "twitchLive", "topArtists", "studios", "programs", "sponsors",
  "opportunities", "venues", "events", "learning", "agentTemplates",
  "audioArticles", "producers", "instrumentals",
] as const

async function readSectionConfig(): Promise<Record<string, boolean>> {
  const res = await irisFetch("/api/v1/platform-config/discover.sections")
  if (!res.ok) return {}
  const data = (await res.json()) as any
  return data?.data?.value ?? {}
}

async function writeSectionConfig(sections: Record<string, boolean>): Promise<Response> {
  return irisFetch("/api/v1/platform-config/discover.sections", {
    method: "PUT",
    body: JSON.stringify({ value: sections }),
  })
}

const SectionsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "show current section visibility toggles",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Discover Sections")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const sections = await readSectionConfig()
      const enabled = SECTION_NAMES.filter((s) => sections[s] !== false)
      const disabled = SECTION_NAMES.filter((s) => sections[s] === false)

      spinner.stop(`${enabled.length} enabled, ${disabled.length} disabled`)

      if (args.json) {
        const full: Record<string, boolean> = {}
        for (const s of SECTION_NAMES) full[s] = sections[s] !== false
        console.log(JSON.stringify(full, null, 2))
        prompts.outro("Done")
        return
      }

      printDivider()
      for (const s of SECTION_NAMES) {
        const on = sections[s] !== false
        const icon = on ? "●" : "○"
        const color = on ? success(icon) : dim(icon)
        console.log(`  ${color}  ${on ? bold(s) : dim(s)}`)
      }
      printDivider()

      prompts.outro(dim("iris discover sections enable <name>  |  iris discover sections disable <name>"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const SectionsEnableCommand = cmd({
  command: "enable <name>",
  aliases: ["on", "show"],
  describe: "enable a section on the discover page",
  builder: (yargs) =>
    yargs.positional("name", { describe: "section name", type: "string", demandOption: true, choices: SECTION_NAMES as unknown as string[] }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Enable Section: ${args.name}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const sections = await readSectionConfig()
      sections[args.name as string] = true

      const putRes = await writeSectionConfig(sections)
      const ok = await handleApiError(putRes, "Enable section")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} ${bold(String(args.name))} enabled`)
      prompts.outro(dim("iris discover sections list"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const SectionsDisableCommand = cmd({
  command: "disable <name>",
  aliases: ["off", "hide"],
  describe: "disable a section on the discover page",
  builder: (yargs) =>
    yargs.positional("name", { describe: "section name", type: "string", demandOption: true, choices: SECTION_NAMES as unknown as string[] }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Disable Section: ${args.name}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const sections = await readSectionConfig()
      sections[args.name as string] = false

      const putRes = await writeSectionConfig(sections)
      const ok = await handleApiError(putRes, "Disable section")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} ${bold(String(args.name))} disabled`)
      prompts.outro(dim("iris discover sections list"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const SectionsCommand = cmd({
  command: "sections",
  aliases: ["toggles"],
  describe: "toggle discover page section visibility",
  builder: (yargs) =>
    yargs
      .command(SectionsListCommand)
      .command(SectionsEnableCommand)
      .command(SectionsDisableCommand)
      .demandCommand(),
  async handler() {},
})

// ============================================================================
// Root discover command
// ============================================================================

export const PlatformDiscoverCommand = cmd({
  command: "discover",
  describe: "manage the Discover page — sponsors, streamers, producers, instrumentals, artists, sections",
  builder: (yargs) =>
    yargs
      .command(SponsorsCommand)
      .command(StreamersCommand)
      .command(ProducersCommand)
      .command(InstrumentalsCommand)
      .command(ArtistsCommand)
      .command(BrandsCommand)
      .command(SectionsCommand)
      .demandCommand(),
  async handler() {},
})
