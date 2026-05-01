import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
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
// Root discover command
// ============================================================================

export const PlatformDiscoverCommand = cmd({
  command: "discover",
  describe: "manage the Discover page — sponsors, featured content",
  builder: (yargs) =>
    yargs
      .command(SponsorsCommand)
      .command(StreamersCommand)
      .demandCommand(),
  async handler() {},
})
