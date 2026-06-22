import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, FL_API, IRIS_API } from "./iris-api"

// ============================================================================
// Shape helpers — discover endpoints return heterogeneous shapes; coerce
// defensively so a surprise object never crashes the whole command with
// "X.slice is not a function" (#147306 — degrade honestly, never crash).
// ============================================================================

/** Coerce any value to an array. Unwraps a paginated { data: [...] } object. */
export function asArray(v: any): any[] {
  if (Array.isArray(v)) return v
  if (v && Array.isArray(v.data)) return v.data
  return []
}

/**
 * Flatten the trending-content response into one views-ranked list.
 *
 * The endpoint returns `data.top_uploads_this_month = { tracks, articles,
 * videos, services }`, where each value is either an array OR a paginated
 * `{ data: [...] }` object — NOT the flat array the old code assumed (which is
 * why `trendingItems.slice(...)` threw and aborted the command). Falls back to
 * the older flat shapes for safety.
 */
export function extractTrendingItems(trending: any): any[] {
  const top = trending?.data?.top_uploads_this_month
  if (top && typeof top === "object" && !Array.isArray(top)) {
    return Object.values(top)
      .flatMap((v: any) => asArray(v))
      .sort((a: any, b: any) => Number(b?.views ?? 0) - Number(a?.views ?? 0))
  }
  const flat = asArray(trending?.data?.data)
  return flat.length ? flat : asArray(trending?.data)
}

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
// Learning Profiles subcommand (config key: discover.learning_profiles)
// ============================================================================

const DEFAULT_LEARNING_PROFILES: Record<string, number> = {
  "entropy": 9203690,
  "theniea": 9203691,
  "mino-marketing": 890795,
  "capital-collective": 633213,
  "gastro": 920342,
  "freelabel": 635263,
  "know-it-alls": 918887,
  "iris-academy": 9207072,
}

async function readLearningProfiles(): Promise<Record<string, number>> {
  const remote = await readConfigObject("discover.learning_profiles")
  return Object.keys(remote).length > 0 ? remote as Record<string, number> : DEFAULT_LEARNING_PROFILES
}

const LearningListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list learning tab profiles",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Learning Profiles")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const profiles = await readLearningProfiles()
      const isCustom = Object.keys(await readConfigObject("discover.learning_profiles")).length > 0
      spinner.stop(`${Object.keys(profiles).length} profile(s)${isCustom ? "" : " (defaults)"}`)

      if (args.json) {
        console.log(JSON.stringify(profiles, null, 2))
        prompts.outro("Done")
        return
      }

      printDivider()
      for (const [key, id] of Object.entries(profiles)) {
        console.log(`  ${bold(key)}  ${dim(`pk: ${id}`)}`)
      }
      printDivider()

      prompts.outro(dim("iris discover learning add <key> <profile-id>"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LearningAddCommand = cmd({
  command: "add <key> <profile-id>",
  describe: "add a profile to the learning tab",
  builder: (yargs) =>
    yargs
      .positional("key", { describe: "slug key (e.g. entropy)", type: "string", demandOption: true })
      .positional("profile-id", { describe: "profile pk ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Add Learning Profile: ${args.key}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const profiles = await readLearningProfiles()
      profiles[String(args.key)] = Number(args["profile-id"])

      const putRes = await writeConfigObject("discover.learning_profiles", profiles as Record<string, unknown>)
      const ok = await handleApiError(putRes, "Add learning profile")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Added ${bold(String(args.key))} (pk: ${args["profile-id"]})`)
      prompts.outro(dim("iris discover learning list"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LearningRemoveCommand = cmd({
  command: "remove <key>",
  aliases: ["rm", "delete"],
  describe: "remove a profile from the learning tab",
  builder: (yargs) =>
    yargs.positional("key", { describe: "slug key to remove", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Remove Learning Profile: ${args.key}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const profiles = await readLearningProfiles()
      const key = String(args.key)

      if (!(key in profiles)) {
        spinner.stop(`${key} not found`)
        prompts.outro("Done")
        return
      }

      delete profiles[key]

      const putRes = await writeConfigObject("discover.learning_profiles", profiles as Record<string, unknown>)
      const ok = await handleApiError(putRes, "Remove learning profile")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Removed ${bold(key)}`)
      prompts.outro(dim("iris discover learning list"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LearningResetCommand = cmd({
  command: "reset",
  describe: "reset learning profiles to defaults",
  builder: (yargs) => yargs,
  async handler() {
    UI.empty()
    prompts.intro("◈  Reset Learning Profiles")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Resetting…")

    try {
      const putRes = await writeConfigObject("discover.learning_profiles", DEFAULT_LEARNING_PROFILES as Record<string, unknown>)
      const ok = await handleApiError(putRes, "Reset learning profiles")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Reset to ${Object.keys(DEFAULT_LEARNING_PROFILES).length} defaults`)
      prompts.outro(dim("iris discover learning list"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LearningCommand = cmd({
  command: "learning",
  aliases: ["learn"],
  describe: "manage learning tab profiles",
  builder: (yargs) =>
    yargs
      .command(LearningListCommand)
      .command(LearningAddCommand)
      .command(LearningRemoveCommand)
      .command(LearningResetCommand)
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
// Status command — full page snapshot for agent curation
// ============================================================================

const StatusCommand = cmd({
  command: "status",
  aliases: ["overview", "state"],
  describe: "full snapshot of Discover page configuration (agent-ready)",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Discover Page Status")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading full config…")

    try {
      // Fetch public discover-config (has sponsors, streamers, producers, instrumentals, featured artists, curator meta)
      const configRes = await fetch(`${FL_API}/api/v1/public/discover-config`, {
        headers: { Accept: "application/json" },
      })
      const configData = configRes.ok ? ((await configRes.json()) as any)?.data ?? {} : {}

      // Fetch section toggles
      const sections = await readSectionConfig()

      // Fetch brands
      const brands = await readBrandsConfig()

      // Fetch learning profiles
      const learning = await readLearningProfiles()

      spinner.stop(success("Loaded"))

      const sponsors: string[] = configData.sponsors ?? []
      const streamers: string[] = configData.streamers ?? []
      const producers: string[] = configData.producers ?? []
      const instrumentals: any[] = configData.instrumentals ?? []
      const featuredArtists: any[] = configData.featuredArtists ?? []
      const curator = configData.curator ?? {}

      if (args.json) {
        console.log(JSON.stringify({
          brands,
          featuredArtists,
          sponsors,
          streamers,
          producers,
          instrumentals,
          learning,
          sections,
          curator,
        }, null, 2))
        prompts.outro("Done")
        return
      }

      // Brands
      console.log()
      console.log(`  ${bold("BRANDS")} ${dim(`(${Object.keys(brands).length})`)}`)
      for (const [key, cfg] of Object.entries(brands) as [string, any][]) {
        console.log(`    ${cfg.name || key}  ${dim(cfg.category || "")}`)
      }

      // Featured Artists
      console.log()
      console.log(`  ${bold("FEATURED ARTISTS")} ${dim(`(${featuredArtists.length})`)}`)
      if (featuredArtists.length === 0) {
        console.log(`    ${dim("(none)")}`)
      } else {
        for (const a of featuredArtists) {
          const name = typeof a === "string" ? a : (a.name ?? a.username ?? a)
          console.log(`    ${name}`)
        }
      }
      if (curator.last_run_at) {
        console.log(`    ${dim(`Last curated: ${curator.last_run_at} by ${curator.last_run_by ?? "unknown"}`)}`)
      }

      // Sponsors
      console.log()
      console.log(`  ${bold("SPONSORS")} ${dim(`(${sponsors.length})`)}`)
      for (const s of sponsors) console.log(`    ${s}`)
      if (sponsors.length === 0) console.log(`    ${dim("(none)")}`)

      // Streamers
      console.log()
      console.log(`  ${bold("STREAMERS")} ${dim(`(${streamers.length})`)}`)
      for (const s of streamers) console.log(`    ${s}`)
      if (streamers.length === 0) console.log(`    ${dim("(none)")}`)

      // Producers
      console.log()
      console.log(`  ${bold("PRODUCERS")} ${dim(`(${producers.length})`)}`)
      for (const p of producers) console.log(`    ${p}`)
      if (producers.length === 0) console.log(`    ${dim("(none)")}`)

      // Instrumentals
      console.log()
      console.log(`  ${bold("INSTRUMENTALS")} ${dim(`(${instrumentals.length})`)}`)
      for (const i of instrumentals) {
        const title = typeof i === "object" ? (i.title ?? `ID: ${i.id}`) : i
        console.log(`    ${title}`)
      }
      if (instrumentals.length === 0) console.log(`    ${dim("(none)")}`)

      // Learning Profiles
      console.log()
      console.log(`  ${bold("LEARNING PROFILES")} ${dim(`(${Object.keys(learning).length})`)}`)
      for (const [key, id] of Object.entries(learning)) {
        console.log(`    ${key}  ${dim(`pk: ${id}`)}`)
      }

      // Section Toggles
      const enabledCount = SECTION_NAMES.filter((s) => sections[s] !== false).length
      const disabledCount = SECTION_NAMES.length - enabledCount
      console.log()
      console.log(`  ${bold("SECTIONS")} ${dim(`(${enabledCount} on, ${disabledCount} off)`)}`)
      for (const s of SECTION_NAMES) {
        const on = sections[s] !== false
        console.log(`    ${on ? success("●") : dim("○")}  ${on ? s : dim(s)}`)
      }

      console.log()
      printDivider()
      prompts.outro(dim("iris discover <brands|artists|sponsors|streamers|producers|instrumentals|learning|sections>"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Stats command — content metrics + monetization visibility
// ============================================================================

const StatsCommand = cmd({
  command: "stats",
  aliases: ["metrics", "analytics"],
  describe: "Discover page content stats, trending, monetization overview",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Discover Page Stats")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching stats…")

    try {
      // These /api/v1/discover/* endpoints require auth — use irisFetch (adds the
      // Bearer token) not bare fetch, or they 401 and silently read as 0 (#147306).
      const [trendingRes, activeRes, videosRes, articlesRes, servicesRes, tutorialsRes] = await Promise.all([
        irisFetch(`/api/v1/discover/trending-content?limit=5`).catch(() => null),
        irisFetch(`/api/v1/discover/active-profiles?limit=5`).catch(() => null),
        irisFetch(`/api/v1/discover/recent-videos?limit=1`).catch(() => null),
        irisFetch(`/api/v1/discover/recent-articles?limit=1`).catch(() => null),
        irisFetch(`/api/v1/discover/recent-services?limit=1`).catch(() => null),
        irisFetch(`/api/v1/discover/tutorials`).catch(() => null),
      ])

      // Track which calls actually succeeded — a failed fetch must read as UNKNOWN,
      // never a confident 0 (#147306). 0 should only show when the API truly returns 0.
      const videosOk = !!videosRes?.ok
      const articlesOk = !!articlesRes?.ok
      const servicesOk = !!servicesRes?.ok

      const trending = trendingRes?.ok ? ((await trendingRes.json()) as any) : {}
      const active = activeRes?.ok ? ((await activeRes.json()) as any) : {}
      const videos = videosOk ? ((await videosRes!.json()) as any) : {}
      const articles = articlesOk ? ((await articlesRes!.json()) as any) : {}
      const services = servicesOk ? ((await servicesRes!.json()) as any) : {}
      const tutorials = tutorialsRes?.ok ? ((await tutorialsRes.json()) as any) : {}

      const videoTotal = videos?.data?.total ?? videos?.total ?? (videos?.data?.data?.length ?? 0)
      const articleTotal = articles?.data?.total ?? articles?.total ?? (articles?.data?.data?.length ?? 0)
      const serviceTotal = services?.data?.total ?? services?.total ?? (services?.data?.data?.length ?? 0)
      const anyFailed = !videosOk || !articlesOk || !servicesOk
      // Render a count honestly: the real number when the call succeeded, else "unknown".
      const fmtCount = (ok: boolean, total: number) => (ok ? bold(String(total)) : dim("unknown (fetch failed)"))
      const trendingItems: any[] = extractTrendingItems(trending)
      const activeProfiles: any[] = asArray(active?.data?.data ?? active?.data)
      const tutorialItems: any[] = asArray(tutorials?.data?.data ?? tutorials?.data)
      const paidTutorials = tutorialItems.filter((t: any) => t.price_usd && Number(t.price_usd) > 0)

      spinner.stop(success("Loaded"))

      if (args.json) {
        console.log(JSON.stringify({
          content: {
            videos: videosOk ? videoTotal : null,
            articles: articlesOk ? articleTotal : null,
            services: servicesOk ? serviceTotal : null,
            partial: anyFailed, // true = at least one count could not be fetched (null), not a real zero
          },
          monetization: { paid_tutorials: paidTutorials.length, tutorials: paidTutorials.map((t: any) => ({ title: t.title, price: t.price_usd, type: t.type })) },
          trending: trendingItems.slice(0, 5).map((t: any) => ({ title: t.title, views: t.views, profile: t.profile_name ?? t.name })),
          active_creators: activeProfiles.slice(0, 5).map((p: any) => ({ name: p.name, views: Number(p.views ?? 0) })),
        }, null, 2))
        prompts.outro("Done")
        return
      }

      // Content Stats
      console.log()
      console.log(`  ${bold("CONTENT")}`)
      console.log(`    Videos:    ${fmtCount(videosOk, videoTotal)}`)
      console.log(`    Articles:  ${fmtCount(articlesOk, articleTotal)}`)
      console.log(`    Services:  ${fmtCount(servicesOk, serviceTotal)}`)
      if (anyFailed) console.log(`    ${dim("⚠ some counts could not be fetched (auth/endpoint) — not a real zero")}`)

      // Monetization
      console.log()
      console.log(`  ${bold("MONETIZATION")}`)
      if (paidTutorials.length > 0) {
        console.log(`    Paid tutorials: ${bold(String(paidTutorials.length))}`)
        for (const t of paidTutorials.slice(0, 5)) {
          console.log(`      $${t.price_usd}  ${dim(t.title?.slice(0, 60) ?? "Untitled")}`)
        }
      } else {
        console.log(`    Paid tutorials: ${dim("0 — use iris tutorials price to monetize")}`)
      }

      // Trending
      if (trendingItems.length > 0) {
        console.log()
        console.log(`  ${bold("TRENDING")} ${dim("(last 30 days)")}`)
        for (const [i, t] of trendingItems.slice(0, 5).entries()) {
          const views = t.views ?? 0
          const name = t.profile_name ?? t.name ?? ""
          console.log(`    ${i + 1}. ${t.title?.slice(0, 50) ?? "Untitled"}  ${dim(`${views} views`)}  ${dim(name)}`)
        }
      }

      // Active Creators
      if (activeProfiles.length > 0) {
        console.log()
        console.log(`  ${bold("MOST ACTIVE CREATORS")} ${dim("(last 30 days)")}`)
        for (const [i, p] of activeProfiles.slice(0, 5).entries()) {
          // active-profiles returns `views`, not an upload/content count — show the real
          // field instead of a fabricated "0 uploads" (#147306/#147307 false-data class).
          const views = Number(p.views ?? 0)
          console.log(`    ${i + 1}. ${p.name ?? "Unknown"}  ${dim(`${views.toLocaleString()} views`)}`)
        }
      }

      console.log()
      printDivider()
      prompts.outro(dim("iris discover status  |  iris tutorials price <type> <id>"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Curate command — AI-driven page curation
// ============================================================================

async function getFullDiscoverState(): Promise<Record<string, unknown>> {
  const configRes = await fetch(`${FL_API}/api/v1/public/discover-config`, {
    headers: { Accept: "application/json" },
  })
  const configData = configRes.ok ? ((await configRes.json()) as any)?.data ?? {} : {}
  const sections = await readSectionConfig()
  const brands = await readBrandsConfig()
  const learning = await readLearningProfiles()

  return {
    brands,
    featuredArtists: configData.featuredArtists ?? [],
    sponsors: configData.sponsors ?? [],
    streamers: configData.streamers ?? [],
    producers: configData.producers ?? [],
    instrumentals: configData.instrumentals ?? [],
    learning,
    sections,
    curator: configData.curator ?? {},
  }
}

const CurateCommand = cmd({
  command: "curate",
  aliases: ["auto"],
  describe: "AI-driven curation — analyze page state and suggest or apply changes",
  builder: (yargs) =>
    yargs
      .option("apply", { describe: "auto-apply AI suggestions", type: "boolean", default: false })
      .option("dry-run", { describe: "show suggestions without applying (default)", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Discover Curator")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Reading page state…")

    try {
      // Step 1: Get current page state
      const state = await getFullDiscoverState()

      // Step 2: Get live activity
      spinner.message("Fetching live activity…")
      const headers = { Accept: "application/json" }
      const [trendingRes, activeRes] = await Promise.all([
        fetch(`${FL_API}/api/v1/discover/trending-content?limit=10`, { headers }).catch(() => null),
        fetch(`${FL_API}/api/v1/discover/active-profiles?limit=10`, { headers }).catch(() => null),
      ])
      const trending = trendingRes?.ok ? ((await trendingRes.json()) as any)?.data ?? [] : []
      const activeProfiles = activeRes?.ok ? ((await activeRes.json()) as any)?.data ?? [] : []

      // Step 3: Ask AI for curation suggestions
      spinner.message("AI analyzing…")

      // Pull the distilled taste doc (from `iris discover review`) so curation
      // reflects accumulated editorial taste — the same signal n8n consumes.
      const tasteProfile = await readConfigObject(TASTE_KEY) as any
      const tasteSection = tasteProfile?.doc
        ? `\nEDITORIAL TASTE (distilled from staff 👍/👎 — weight this heavily):\n${tasteProfile.doc}\n`
        : ""

      const prompt = `You are the Discover Page Curator for FreeLABEL, a content platform for creators, brands, and businesses.
${tasteSection}
CURRENT PAGE STATE:
${JSON.stringify(state, null, 2)}

TRENDING CONTENT (last 30 days):
${JSON.stringify(Array.isArray(trending) ? trending.slice(0, 10) : (trending.data ?? []).slice(0, 10), null, 2)}

ACTIVE CREATORS (last 30 days):
${JSON.stringify(Array.isArray(activeProfiles) ? activeProfiles.slice(0, 10) : (activeProfiles.data ?? []).slice(0, 10), null, 2)}

Analyze the page and suggest curation changes. Consider:
1. Are featured artists still active? Should any be rotated?
2. Are any sections disabled that should be enabled (or vice versa)?
3. Are there active creators who should be featured?
4. Are there brands with no content that should be removed?
5. Any monetization opportunities (tutorials that should be priced)?

Return a JSON object with this EXACT structure (include only changes needed, omit sections with no changes):
{
  "summary": "1-2 sentence summary of recommendations",
  "actions": [
    { "type": "artists_set", "usernames": ["list", "of", "suggested"], "reason": "why" },
    { "type": "section_enable", "name": "sectionName", "reason": "why" },
    { "type": "section_disable", "name": "sectionName", "reason": "why" },
    { "type": "brand_remove", "name": "brand key", "reason": "why" },
    { "type": "sponsor_add", "username": "handle", "reason": "why" }
  ]
}

Return ONLY the JSON object, no markdown or explanation.`

      const aiRes = await irisFetch("/api/v6/openai/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "iris/gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          max_tokens: 1500,
        }),
      }, IRIS_API)

      if (!aiRes.ok) {
        spinner.stop("AI call failed", 1)
        await handleApiError(aiRes, "Curate")
        prompts.outro("Done")
        return
      }

      const aiData = (await aiRes.json()) as any
      const content = aiData?.choices?.[0]?.message?.content ?? ""

      let suggestions: any
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/)
        suggestions = jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: content, actions: [] }
      } catch {
        suggestions = { summary: content, actions: [] }
      }

      spinner.stop(success("Analysis complete"))

      if (args.json) {
        console.log(JSON.stringify(suggestions, null, 2))
        prompts.outro("Done")
        return
      }

      // Display suggestions
      console.log()
      console.log(`  ${bold("AI RECOMMENDATION")}`)
      console.log(`  ${suggestions.summary ?? "No summary"}`)
      console.log()

      const actions: any[] = suggestions.actions ?? []
      if (actions.length === 0) {
        console.log(`  ${dim("No changes suggested — page looks good!")}`)
        prompts.outro("Done")
        return
      }

      for (const [i, action] of actions.entries()) {
        const icon = args.apply ? success("✓") : dim("→")
        console.log(`  ${icon}  ${bold(action.type)}${action.name || action.username ? `: ${action.name || action.username}` : ""}`)
        if (action.usernames) console.log(`     ${dim(action.usernames.join(", "))}`)
        if (action.reason) console.log(`     ${dim(action.reason)}`)
      }

      if (args.apply) {
        // Execute each action
        console.log()
        const applySpinner = prompts.spinner()
        applySpinner.start("Applying changes…")
        let applied = 0

        for (const action of actions) {
          try {
            if (action.type === "artists_set" && Array.isArray(action.usernames)) {
              await writeConfigList("discover.featured_profiles", action.usernames)
              applied++
            } else if (action.type === "section_enable" && action.name) {
              const secs = await readSectionConfig()
              secs[action.name] = true
              await writeSectionConfig(secs)
              applied++
            } else if (action.type === "section_disable" && action.name) {
              const secs = await readSectionConfig()
              secs[action.name] = false
              await writeSectionConfig(secs)
              applied++
            } else if (action.type === "brand_remove" && action.name) {
              const br = await readBrandsConfig()
              delete br[action.name]
              await writeConfigObject("discover.brands", br)
              applied++
            } else if (action.type === "sponsor_add" && action.username) {
              const sp = await readConfigList("discover.sponsors") as string[]
              if (!sp.includes(action.username)) {
                sp.push(action.username)
                await writeConfigList("discover.sponsors", sp)
              }
              applied++
            } else if (action.type === "sponsor_remove" && action.username) {
              let sp = await readConfigList("discover.sponsors") as string[]
              sp = sp.filter((s) => s !== action.username)
              await writeConfigList("discover.sponsors", sp)
              applied++
            }
          } catch { /* skip failed actions */ }
        }

        applySpinner.stop(`${success("✓")} ${applied}/${actions.length} actions applied`)
      } else {
        console.log()
        console.log(`  ${dim("Dry run — use --apply to execute these changes")}`)
      }

      prompts.outro(dim("iris discover status"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Taste engine — curation feedback loop
// (config keys: discover.feedback_log, discover.taste_profile)
// In-context learning: staff 👍/👎 → distilled "taste doc" → injected into the
// n8n "Analyze Discover Content" curator prompt. No model training, no new tables.
// ============================================================================

const FEEDBACK_KEY = "discover.feedback_log"
const TASTE_KEY = "discover.taste_profile"
const FEEDBACK_CAP = 500

const REJECT_REASONS = [
  { value: "off-topic", label: "Off-topic — not what Discover is about" },
  { value: "low-quality", label: "Low quality — weak / clickbait / thin" },
  { value: "already-covered", label: "Already covered — duplicate angle" },
  { value: "boring", label: "Boring — no hook, won't keep people going" },
  { value: "other", label: "Other (type a reason)" },
]

type FeedbackEntry = {
  verdict: "approve" | "reject"
  ref: string
  title: string
  channel: string
  reason: string
  ts: number
}

function normalizeReviewItem(v: any): { ref: string; title: string; channel: string; url: string } {
  const mediaId = v?.media_id ?? v?.mediaId ?? v?.youtube_id ?? v?.youtubeId ?? ""
  return {
    ref: String(v?.id ?? mediaId ?? v?.slug ?? ""),
    title: String(v?.title || v?.name || "(untitled)"),
    channel: String(v?.profile_name || v?.channel || v?.twitter || v?.instagram || ""),
    url: String(v?.url || v?.link || (mediaId ? `https://www.youtube.com/watch?v=${mediaId}` : "")),
  }
}

async function readFeedback(): Promise<FeedbackEntry[]> {
  const list = await readConfigList(FEEDBACK_KEY)
  return Array.isArray(list) ? (list as FeedbackEntry[]) : []
}

async function recordFeedback(entry: FeedbackEntry): Promise<Response> {
  const list = await readFeedback()
  list.push(entry)
  return writeConfigList(FEEDBACK_KEY, list.slice(-FEEDBACK_CAP))
}

async function fetchReviewQueue(limit: number): Promise<any[]> {
  const res = await irisFetch(`/api/v1/discover/recent-videos?limit=${limit}`)
  if (!res.ok) return []
  const data = (await res.json()) as any
  const inner = data?.data
  if (Array.isArray(inner)) return inner
  if (Array.isArray(inner?.data)) return inner.data // LengthAwarePaginator
  return []
}

// Distill accumulated feedback into a short taste doc and persist it.
// Returns null when there's no feedback yet.
async function distillTaste(): Promise<{ doc: string; counts: { approve: number; reject: number } } | null> {
  const feedback = await readFeedback()
  if (feedback.length === 0) return null

  const approvals = feedback.filter((f) => f.verdict === "approve")
  const rejections = feedback.filter((f) => f.verdict === "reject")
  const fmt = (f: FeedbackEntry) =>
    `- "${f.title}"${f.channel ? ` (${f.channel})` : ""}${f.reason ? ` — ${f.reason}` : ""}`

  const prompt = `You are the editorial taste director for "The Discover Page" (@thediscoverpage_), a curated content feed. Below is staff feedback on individual videos: which were APPROVED (good fit) and which were REJECTED (and why).

APPROVED — we love content like this:
${approvals.slice(-60).map(fmt).join("\n") || "(none yet)"}

REJECTED — do NOT post content like this:
${rejections.slice(-60).map(fmt).join("\n") || "(none yet)"}

Write a short, sharp "taste doc" that a curation AI will read before scoring new videos. Format EXACTLY as:

LOVE:
- <durable rule about what to favor>
(3-6 bullets)

SKIP:
- <durable rule about what to reject>
(3-6 bullets)

Derive durable PATTERNS (topics, formats, tone, channels) — not one-off restatements. Be specific and opinionated. Output ONLY the taste doc, no preamble.`

  const aiRes = await irisFetch("/api/v6/openai/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "iris/gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      max_tokens: 600,
    }),
  }, IRIS_API)
  if (!aiRes.ok) throw new Error(`Distill failed: HTTP ${aiRes.status}`)

  const aiData = (await aiRes.json()) as any
  const doc = String(aiData?.choices?.[0]?.message?.content ?? "").trim()
  if (!doc) throw new Error("Distill returned an empty taste doc")

  const counts = { approve: approvals.length, reject: rejections.length }
  await writeConfigObject(TASTE_KEY, {
    doc,
    counts,
    updated_at: new Date().toISOString(),
    recent_love: approvals.slice(-8).map((f) => ({ title: f.title, channel: f.channel })),
    recent_skip: rejections.slice(-8).map((f) => ({ title: f.title, channel: f.channel, reason: f.reason })),
  })
  return { doc, counts }
}

const DiscoverReviewCommand = cmd({
  command: "review",
  describe: "step through recent Discover videos and mark each 👍/👎 (feeds the taste engine)",
  builder: (yargs) =>
    yargs
      .option("limit", { describe: "how many recent items to pull", type: "number", default: 15 })
      .option("refresh", { describe: "auto-distill the taste doc when done", type: "boolean", default: true }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Discover Review")
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading recent items…")
    const items = await fetchReviewQueue(args.limit as number)
    if (items.length === 0) { spinner.stop("Nothing to review", 1); prompts.outro("Done"); return }

    const seen = new Set((await readFeedback()).map((f) => f.ref))
    const queue = items.map(normalizeReviewItem).filter((i) => i.ref && !seen.has(i.ref))
    spinner.stop(`${queue.length} new item(s) to review`)
    if (queue.length === 0) {
      prompts.log.info("All recent items already reviewed.")
      prompts.outro(dim("iris discover taste"))
      return
    }

    let approved = 0, rejected = 0, skipped = 0
    for (let idx = 0; idx < queue.length; idx++) {
      const item = queue[idx]
      console.log()
      console.log(`  ${dim(`[${idx + 1}/${queue.length}]`)} ${bold(item.title)}`)
      if (item.channel) console.log(`  ${dim(item.channel)}`)
      if (item.url) console.log(`  ${dim(item.url)}`)

      const verdict = await prompts.select({
        message: "Verdict?",
        options: [
          { value: "approve", label: "👍 Keep — good fit" },
          { value: "reject", label: "👎 Reject — doesn't belong" },
          { value: "skip", label: "⏭  Skip (don't record)" },
          { value: "quit", label: "■ Stop reviewing" },
        ],
      })
      if (prompts.isCancel(verdict) || verdict === "quit") break
      if (verdict === "skip") { skipped++; continue }

      let reason = ""
      if (verdict === "reject") {
        const r = await prompts.select({ message: "Why?", options: REJECT_REASONS })
        if (prompts.isCancel(r)) break
        if (r === "other") {
          const typed = await prompts.text({ message: "Reason:" })
          if (prompts.isCancel(typed)) break
          reason = String(typed || "other")
        } else {
          reason = String(r)
        }
      }

      await recordFeedback({
        verdict: verdict as "approve" | "reject",
        ref: item.ref, title: item.title, channel: item.channel, reason, ts: Date.now(),
      })
      if (verdict === "approve") approved++; else rejected++
    }

    printDivider()
    console.log(`  ${success("✓")} ${approved} kept   ${rejected} rejected   ${skipped} skipped`)
    printDivider()

    if (args.refresh && approved + rejected > 0) {
      const ds = prompts.spinner()
      ds.start("Distilling taste doc…")
      try {
        const out = await distillTaste()
        ds.stop(out ? success("Taste doc updated") : "Nothing to distill")
      } catch (e) {
        ds.stop("Distill failed", 1)
        prompts.log.error(e instanceof Error ? e.message : String(e))
      }
    }
    prompts.outro(dim("iris discover taste"))
  },
})

const DiscoverApproveCommand = cmd({
  command: "approve <ref>",
  aliases: ["like"],
  describe: "record a 👍 good-fit example (ref = video id or URL)",
  builder: (yargs) =>
    yargs
      .positional("ref", { describe: "video id or URL", type: "string", demandOption: true })
      .option("title", { describe: "title for the taste examples", type: "string" })
      .option("channel", { describe: "channel / creator", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Approve")
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    await recordFeedback({
      verdict: "approve", ref: String(args.ref),
      title: String(args.title || args.ref), channel: String(args.channel || ""),
      reason: "", ts: Date.now(),
    })
    console.log(`  ${success("✓")} Recorded 👍 for ${bold(String(args.title || args.ref))}`)
    prompts.outro(dim("iris discover taste refresh"))
  },
})

const DiscoverRejectCommand = cmd({
  command: "reject <ref>",
  describe: "record a 👎 bad-fit example with a reason",
  builder: (yargs) =>
    yargs
      .positional("ref", { describe: "video id or URL", type: "string", demandOption: true })
      .option("reason", { describe: "why it's a bad fit", type: "string", default: "" })
      .option("title", { describe: "title", type: "string" })
      .option("channel", { describe: "channel / creator", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Reject")
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    await recordFeedback({
      verdict: "reject", ref: String(args.ref),
      title: String(args.title || args.ref), channel: String(args.channel || ""),
      reason: String(args.reason || ""), ts: Date.now(),
    })
    console.log(`  ${success("✓")} Recorded 👎 for ${bold(String(args.title || args.ref))}${args.reason ? dim(` — ${args.reason}`) : ""}`)
    prompts.outro(dim("iris discover taste refresh"))
  },
})

const DiscoverTasteRefreshCommand = cmd({
  command: "refresh",
  aliases: ["distill"],
  describe: "re-distill the taste doc from accumulated feedback (gpt-4o-mini)",
  builder: (yargs) => yargs,
  async handler() {
    UI.empty()
    prompts.intro("◈  Distill Taste")
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const spinner = prompts.spinner()
    spinner.start("Reading feedback + distilling…")
    try {
      const out = await distillTaste()
      if (!out) { spinner.stop("No feedback yet — review some items first", 1); prompts.outro(dim("iris discover review")); return }
      spinner.stop(success("Taste doc updated"))
      printDivider()
      console.log(out.doc)
      printDivider()
      console.log(`  ${dim(`from ${out.counts.approve} 👍 / ${out.counts.reject} 👎`)}`)
      prompts.outro("Done")
    } catch (e) {
      spinner.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})

const DiscoverTasteCommand = cmd({
  command: "taste",
  describe: "show the current distilled taste doc (the curator's editorial brain)",
  builder: (yargs) => yargs.command(DiscoverTasteRefreshCommand),
  async handler() {
    UI.empty()
    prompts.intro("◈  Discover Taste")
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const taste = await readConfigObject(TASTE_KEY) as any
    if (!taste?.doc) {
      prompts.log.info("No taste doc yet. Run `iris discover review`, then `iris discover taste refresh`.")
      prompts.outro("Done")
      return
    }
    printDivider()
    console.log(taste.doc)
    printDivider()
    if (taste.counts) {
      console.log(`  ${dim(`from ${taste.counts.approve ?? 0} 👍 / ${taste.counts.reject ?? 0} 👎`)}${taste.updated_at ? dim(`  ·  updated ${taste.updated_at}`) : ""}`)
    }
    prompts.outro(dim("iris discover taste refresh"))
  },
})

const DiscoverFeedbackCommand = cmd({
  command: "feedback",
  aliases: ["history"],
  describe: "list recent curation feedback (👍/👎 with reasons)",
  builder: (yargs) =>
    yargs
      .option("limit", { describe: "how many entries to show", type: "number", default: 30 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Discover Feedback")
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const feedback = await readFeedback()
    const recent = feedback.slice(-(args.limit as number)).reverse()
    if (args.json) { console.log(JSON.stringify(recent, null, 2)); prompts.outro("Done"); return }
    if (recent.length === 0) { prompts.log.info("No feedback yet."); prompts.outro(dim("iris discover review")); return }
    printDivider()
    for (const f of recent) {
      const icon = f.verdict === "approve" ? success("👍") : "👎"
      console.log(`  ${icon} ${bold(f.title)}${f.channel ? dim(` · ${f.channel}`) : ""}${f.reason ? dim(`  (${f.reason})`) : ""}`)
    }
    printDivider()
    const approve = feedback.filter((f) => f.verdict === "approve").length
    const reject = feedback.filter((f) => f.verdict === "reject").length
    console.log(`  ${dim(`${approve} 👍 / ${reject} 👎 total`)}`)
    prompts.outro(dim("iris discover taste"))
  },
})

// ============================================================================
// Promoted slots — monetization real estate (config key: discover.promoted_slots)
// One component, three payers: membership CTA / newsletter / sponsor.
// ============================================================================

const PROMOS_KEY = "discover.promoted_slots"
const PROMO_TYPES = ["membership", "newsletter", "sponsor"] as const

type PromoSlot = {
  id: string
  type: string
  title: string
  body: string
  cta_label: string
  cta_url: string
  image?: string
  sponsor_name?: string
  position?: number
  active: boolean
}

function slugifyPromoId(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "slot"
  return `${base}-${Math.floor(Math.random() * 1e6).toString(36)}`
}

async function readPromos(): Promise<PromoSlot[]> {
  const list = await readConfigList(PROMOS_KEY)
  return Array.isArray(list) ? (list as PromoSlot[]) : []
}

// Backend `value => required` rejects an empty array; store `false` (reads back as []).
async function writePromos(slots: PromoSlot[]): Promise<Response> {
  return irisFetch(`/api/v1/platform-config/${PROMOS_KEY}`, {
    method: "PUT",
    body: JSON.stringify({ value: slots.length ? slots : false }),
  })
}

const PromosListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list promoted slots on the Discover page",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Promoted Slots")
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const slots = await readPromos()
    if (args.json) { console.log(JSON.stringify(slots, null, 2)); prompts.outro("Done"); return }
    if (slots.length === 0) { prompts.log.info("No promoted slots yet."); prompts.outro(dim("iris discover promos add")); return }
    printDivider()
    for (const s of slots) {
      const status = s.active === false ? dim("○ off") : success("●")
      console.log(`  ${status} ${bold(s.title)}  ${dim(`[${s.type}]`)}${s.position != null ? dim(`  pos ${s.position}`) : ""}`)
      console.log(`     ${dim(`${s.cta_label} → ${s.cta_url}  ·  id=${s.id}`)}`)
    }
    printDivider()
    prompts.outro(dim("iris discover promos add"))
  },
})

const PromosAddCommand = cmd({
  command: "add",
  describe: "add a promoted slot (membership / newsletter / sponsor)",
  builder: (yargs) =>
    yargs
      .option("type", { describe: "slot type", type: "string", choices: PROMO_TYPES as unknown as string[], demandOption: true })
      .option("title", { describe: "headline", type: "string", demandOption: true })
      .option("body", { describe: "short pitch", type: "string", default: "" })
      .option("cta-label", { describe: "button label", type: "string", demandOption: true })
      .option("cta-url", { describe: "button URL/path", type: "string", demandOption: true })
      .option("image", { describe: "image URL", type: "string" })
      .option("sponsor", { describe: "sponsor name (for sponsor type)", type: "string" })
      .option("position", { describe: "ordering position (lower = earlier)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Add Promoted Slot: ${args.title}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const slots = await readPromos()
    const slot: PromoSlot = {
      id: slugifyPromoId(String(args.title)),
      type: String(args.type),
      title: String(args.title),
      body: String(args.body || ""),
      cta_label: String(args["cta-label"]),
      cta_url: String(args["cta-url"]),
      active: true,
    }
    if (args.image) slot.image = String(args.image)
    if (args.sponsor) slot.sponsor_name = String(args.sponsor)
    if (args.position != null) slot.position = Number(args.position)
    slots.push(slot)
    const ok = await handleApiError(await writePromos(slots), "Add slot")
    if (!ok) { prompts.outro("Done"); return }
    console.log(`  ${success("✓")} Added ${bold(slot.title)} ${dim(`[${slot.type}]  id=${slot.id}`)}`)
    prompts.outro(dim("iris discover promos list"))
  },
})

const PromosRemoveCommand = cmd({
  command: "remove <id>",
  aliases: ["rm", "delete"],
  describe: "remove a promoted slot by id",
  builder: (yargs) => yargs.positional("id", { describe: "slot id", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Remove Slot: ${args.id}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    let slots = await readPromos()
    if (!slots.some((s) => s.id === args.id)) { prompts.log.error(`No slot with id ${args.id}`); prompts.outro(dim("iris discover promos list")); return }
    slots = slots.filter((s) => s.id !== args.id)
    const ok = await handleApiError(await writePromos(slots), "Remove slot")
    if (!ok) { prompts.outro("Done"); return }
    console.log(`  ${success("✓")} Removed ${bold(String(args.id))}  ${dim(`(${slots.length} remaining)`)}`)
    prompts.outro(dim("iris discover promos list"))
  },
})

const PromosToggleCommand = cmd({
  command: "toggle <id>",
  describe: "turn a promoted slot on/off",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "slot id", type: "string", demandOption: true })
      .option("on", { type: "boolean", describe: "force on" })
      .option("off", { type: "boolean", describe: "force off" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Toggle Slot: ${args.id}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const slots = await readPromos()
    const slot = slots.find((s) => s.id === args.id)
    if (!slot) { prompts.log.error(`No slot with id ${args.id}`); prompts.outro(dim("iris discover promos list")); return }
    slot.active = args.on ? true : args.off ? false : slot.active === false
    const ok = await handleApiError(await writePromos(slots), "Toggle slot")
    if (!ok) { prompts.outro("Done"); return }
    console.log(`  ${success("✓")} ${bold(slot.title)} is now ${slot.active ? success("ON") : dim("OFF")}`)
    prompts.outro(dim("iris discover promos list"))
  },
})

const PromosCommand = cmd({
  command: "promos",
  aliases: ["promoted", "slots"],
  describe: "manage promoted slots — membership / newsletter / sponsor cards on the Discover page",
  builder: (yargs) =>
    yargs
      .command(PromosListCommand)
      .command(PromosAddCommand)
      .command(PromosRemoveCommand)
      .command(PromosToggleCommand)
      .demandCommand(),
  async handler() {},
})

// ============================================================================
// Root discover command
// ============================================================================

export const PlatformDiscoverCommand = cmd({
  command: "discover",
  describe: "manage the Discover page — status, curate, review/taste, promos, stats, brands, artists, sponsors, streamers, producers, instrumentals, learning, sections",
  builder: (yargs) =>
    yargs
      .command(StatusCommand)
      .command(StatsCommand)
      .command(CurateCommand)
      .command(DiscoverReviewCommand)
      .command(DiscoverApproveCommand)
      .command(DiscoverRejectCommand)
      .command(DiscoverTasteCommand)
      .command(DiscoverFeedbackCommand)
      .command(PromosCommand)
      .command(SponsorsCommand)
      .command(StreamersCommand)
      .command(ProducersCommand)
      .command(InstrumentalsCommand)
      .command(ArtistsCommand)
      .command(BrandsCommand)
      .command(LearningCommand)
      .command(SectionsCommand)
      .demandCommand(),
  async handler() {},
})
