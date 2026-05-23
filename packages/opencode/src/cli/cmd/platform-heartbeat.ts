import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, printDivider, printKV, dim, bold, success, FL_API } from "./iris-api"

// ============================================================================
// Helpers
// ============================================================================

function progressBar(score: number, width = 10): string {
  const filled = Math.round((score / 100) * width)
  const empty = width - filled
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty)
  // Color based on score
  if (score >= 90) return `${UI.Style.TEXT_SUCCESS}${bar}${UI.Style.TEXT_NORMAL}`
  if (score >= 75) return `${UI.Style.TEXT_WARNING ?? ""}${bar}${UI.Style.TEXT_NORMAL}`
  if (score >= 50) return `${bar}`
  return `${UI.Style.TEXT_DANGER ?? ""}${bar}${UI.Style.TEXT_NORMAL}`
}

function bandEmoji(band: string): string {
  switch (band) {
    case "healthy": return "●"
    case "attention": return "◐"
    case "at_risk": return "○"
    case "failing": return "✗"
    default: return "?"
  }
}

function bandLabel(band: string): string {
  switch (band) {
    case "healthy": return success("healthy")
    case "attention": return `${dim("attention")}`
    case "at_risk": return "at risk"
    case "failing": return "failing"
    default: return band
  }
}

// ============================================================================
// Main command — `iris heartbeat`
// ============================================================================

const HeartbeatCommand = cmd({
  command: "heartbeat",
  aliases: ["hb", "health"],
  describe: "your platform health dashboard — see how your IRIS setup is performing",
  builder: (yargs) =>
    yargs
      .option("json", { type: "boolean", default: false, describe: "JSON output" })
      .option("user-id", { type: "number", describe: "user ID (default: authenticated user)" })
      .command(HeartbeatSignalsCommand)
      .strict(false), // Allow bare `iris heartbeat` without subcommand
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  IRIS Heartbeat") }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Checking your health…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/heartbeat?include=copy,history`, {}, FL_API)
      if (!res.ok) {
        if (spinner) spinner.stop("Failed", 1)
        const errData = await res.json().catch(() => ({})) as Record<string, any>
        if (args.json) { console.log(JSON.stringify({ success: false, error: errData?.message ?? `HTTP ${res.status}` })); return }
        prompts.log.error(errData?.message ?? `HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }

      const raw = await res.json() as Record<string, any>
      const data = raw?.data ?? raw

      if (args.json) {
        console.log(JSON.stringify(data, null, 2))
        return
      }

      if (spinner) spinner.stop("Health computed")

      const score = data.score ?? 0
      const band = data.band ?? "unknown"
      const signals = data.signals ?? {}
      const weights = data.weights_applied ?? {}
      const clientLabels = data.client_labels ?? {}
      const history: any[] = data.history ?? []

      // Score header
      console.log()
      console.log(`  ${bold("Score:")} ${bold(String(score))}/100 (${bandLabel(band)})`)

      // Trend sparkline from history
      if (history.length >= 2) {
        const trend = history.slice(0, 5).reverse().map((h: any) => h.score).join(" → ")
        const direction = history[0].score > history[1].score ? "improving" : history[0].score < history[1].score ? "declining" : "stable"
        console.log(`  ${dim(`Trend: ${trend} (${direction})`)}`)
      }

      printDivider()

      // Signal breakdown — sorted by weight (highest impact first)
      const signalEntries = Object.entries(signals)
        .filter(([, v]) => v !== null && typeof v === "object")
        .sort(([a], [b]) => (weights[b] ?? 0) - (weights[a] ?? 0))

      for (const [name, signal] of signalEntries) {
        const sig = signal as Record<string, any>
        const sigScore = sig.score ?? 0
        const bar = progressBar(sigScore)
        const label = clientLabels[name] ?? sig.client_copy ?? name.replace(/_/g, " ")
        const scoreStr = String(sigScore).padStart(3)
        const copy = sig.client_copy ?? ""

        console.log(`  ${bar}  ${scoreStr}  ${bold(label)}`)
        if (copy && copy !== label) {
          console.log(`  ${dim("           " + copy)}`)
        }
      }

      console.log()
      printDivider()
      prompts.outro(`${dim("iris heartbeat --json")}  ${dim("|")}  ${dim("iris pulse --admin (agency view)")}`)
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Signals subcommand — list available signals from registry
// ============================================================================

const HeartbeatSignalsCommand = cmd({
  command: "signals",
  describe: "list available health signals from the registry",
  builder: (yargs) =>
    yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Signal Registry") }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    try {
      const res = await irisFetch("/api/v1/signals/registry", {}, FL_API)
      if (!res.ok) {
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        prompts.log.error(`Failed to fetch registry: HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }

      const registry = await res.json() as Record<string, any>

      if (args.json) {
        console.log(JSON.stringify(registry, null, 2))
        return
      }

      console.log()
      console.log(`  ${bold("Pulse")} ${dim("(agency)")}        ${bold("Heartbeat")} ${dim("(you)")}`)
      printDivider()

      for (const [name, def] of Object.entries(registry)) {
        const d = def as Record<string, any>
        const pulseFlag = d.pulse ? success("YES") : dim("no ")
        const hbFlag = d.heartbeat ? success("YES") : dim("no ")
        const weight = dim(`${Math.round(d.weight * 100)}%`)
        const label = d.client_label ?? d.label ?? name
        console.log(`  ${pulseFlag}  ${hbFlag}  ${weight}  ${bold(String(label))}  ${dim(name)}`)
      }

      console.log()
      prompts.outro(`${Object.keys(registry).length} signals registered`)
    } catch (err) {
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Export
// ============================================================================

export const PlatformHeartbeatCommand = HeartbeatCommand
