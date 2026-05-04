import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import {
  irisFetch,
  requireAuth,
  handleApiError,
  resolveUserId,
  printDivider,
  printKV,
  bold,
  success,
} from "./iris-api"

// ============================================================================
// iris scan — system-discovery profile (apps + sync folders + browser hints)
// ============================================================================
//
// v1: macOS only, basic consent tier (non-content metadata only).
// Detects installed apps, productivity sync folders, and connected integrations,
// then POSTs a profile to /api/v1/users/{id}/stack-profile.
//
// Three consent tiers (only --basic implemented in v1):
//   --basic     installed apps + sync folder presence + browser config dirs
//   --workspace adds filename keyword counts (no content reads)        [TODO]
//   --deep      adds content/mail parsing                              [TODO]
// ============================================================================

interface ProviderSig {
  key: string
  label: string
  category: "google" | "microsoft" | "apple" | "productivity" | "dev" | "comm"
  app_names?: string[]
  sync_paths?: string[]
  config_paths?: string[]
}

const PROVIDERS: ProviderSig[] = [
  { key: "google_drive", label: "Google Drive", category: "google",
    app_names: ["Google Drive.app"],
    sync_paths: ["~/Library/Application Support/Google/DriveFS", "~/Google Drive"] },
  { key: "google_chrome", label: "Google Chrome", category: "google",
    app_names: ["Google Chrome.app"],
    config_paths: ["~/Library/Application Support/Google/Chrome/Default"] },
  { key: "gmail", label: "Gmail (Chrome account)", category: "google",
    config_paths: ["~/Library/Application Support/Google/Chrome/Default/Preferences"] },
  { key: "onedrive", label: "OneDrive", category: "microsoft",
    app_names: ["OneDrive.app"],
    sync_paths: ["~/OneDrive", "~/Library/CloudStorage/OneDrive-Personal"] },
  { key: "outlook", label: "Microsoft Outlook", category: "microsoft",
    app_names: ["Microsoft Outlook.app"] },
  { key: "teams", label: "Microsoft Teams", category: "microsoft",
    app_names: ["Microsoft Teams.app", "Microsoft Teams (work or school).app"] },
  { key: "icloud", label: "iCloud Drive", category: "apple",
    sync_paths: ["~/Library/Mobile Documents/com~apple~CloudDocs"] },
  { key: "safari", label: "Safari", category: "apple",
    app_names: ["Safari.app"] },
  { key: "dropbox", label: "Dropbox", category: "productivity",
    app_names: ["Dropbox.app"], sync_paths: ["~/Dropbox"] },
  { key: "notion", label: "Notion", category: "productivity",
    app_names: ["Notion.app"] },
  { key: "slack", label: "Slack", category: "comm",
    app_names: ["Slack.app"] },
  { key: "discord", label: "Discord", category: "comm",
    app_names: ["Discord.app"] },
  { key: "zoom", label: "Zoom", category: "comm",
    app_names: ["zoom.us.app", "Zoom.app"] },
  { key: "vscode", label: "Visual Studio Code", category: "dev",
    app_names: ["Visual Studio Code.app"] },
  { key: "docker", label: "Docker Desktop", category: "dev",
    app_names: ["Docker.app"] },
]

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
  return p
}

function safeExists(p: string): boolean {
  try { return fs.existsSync(expandHome(p)) } catch { return false }
}

function detectProvider(p: ProviderSig): { confidence: number; evidence: string[] } {
  const evidence: string[] = []
  let weight = 0

  for (const name of p.app_names ?? []) {
    if (safeExists(`/Applications/${name}`)) { evidence.push(`app:/Applications/${name}`); weight += 50 }
  }
  for (const sp of p.sync_paths ?? []) {
    if (safeExists(sp)) { evidence.push(`sync:${sp}`); weight += 35 }
  }
  for (const cp of p.config_paths ?? []) {
    if (safeExists(cp)) { evidence.push(`config:${cp}`); weight += 20 }
  }

  return { confidence: Math.min(100, weight), evidence }
}

function inferStack(detections: Record<string, { confidence: number; category: string }>): string {
  let google = 0, microsoft = 0, apple = 0
  for (const [, det] of Object.entries(detections)) {
    if (det.confidence < 35) continue
    if (det.category === "google") google += det.confidence
    else if (det.category === "microsoft") microsoft += det.confidence
    else if (det.category === "apple") apple += det.confidence
  }
  const max = Math.max(google, microsoft, apple)
  if (max === 0) return "unknown"
  // mixed if two camps both score above 50
  const aboveThresh = [google, microsoft, apple].filter((v) => v >= 50).length
  if (aboveThresh >= 2) return "mixed"
  if (max === google) return "google"
  if (max === microsoft) return "microsoft"
  return "apple"
}

export const PlatformScanCommand = cmd({
  command: "scan",
  describe: "scan the local system to build a productivity-stack profile (apps, sync folders, integrations)",
  builder: (y) =>
    y
      .option("basic", { describe: "basic consent tier (apps + sync folders + browser config) [default]", type: "boolean", default: true })
      .option("workspace", { describe: "include filename keyword counts (no contents) [TODO]", type: "boolean", default: false })
      .option("deep", { describe: "include content / mail parsing [TODO]", type: "boolean", default: false })
      .option("dry-run", { describe: "print profile but don't POST to backend", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  iris scan")

    if (args.workspace || args.deep) {
      prompts.log.warn("Only --basic is implemented in v1; running basic scan.")
    }

    if (process.platform !== "darwin") {
      prompts.log.warn(`Platform '${process.platform}' not yet supported. Only macOS detectors are implemented.`)
      prompts.outro("Done")
      return
    }

    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const userId = await resolveUserId()
    if (!userId) {
      prompts.log.error("Could not resolve user id. Run iris auth login.")
      prompts.outro("Done"); return
    }

    const sp = prompts.spinner()
    sp.start("Detecting installed apps and sync folders…")

    const detections: Record<string, { label: string; confidence: number; category: string; evidence: string[] }> = {}
    for (const p of PROVIDERS) {
      const r = detectProvider(p)
      if (r.confidence > 0) {
        detections[p.key] = { label: p.label, confidence: r.confidence, category: p.category, evidence: r.evidence }
      }
    }

    sp.stop(success(`Detected ${Object.keys(detections).length} providers locally`))

    // Pull connected integrations (remote)
    sp.start("Fetching connected integrations…")
    const integrationKeys: string[] = []
    try {
      const res = await irisFetch(`/api/v1/users/${userId}/integrations`)
      if (res.ok) {
        const body = (await res.json()) as { data?: Array<{ type?: string; status?: string }> }
        for (const i of body.data ?? []) {
          if (i.type && (i.status === "active" || !i.status)) integrationKeys.push(i.type)
        }
      }
    } catch {
      // non-fatal
    }
    sp.stop(success(`${integrationKeys.length} connected integrations`))

    const productivityStack = inferStack(detections)

    // Suggest connectors: providers detected locally but NOT yet connected
    const suggested: string[] = []
    for (const [key, det] of Object.entries(detections)) {
      if (det.confidence < 35) continue
      const matchesAny = integrationKeys.some((ik) => key.includes(ik) || ik.includes(key))
      if (!matchesAny) suggested.push(key)
    }
    suggested.sort((a, b) => detections[b].confidence - detections[a].confidence)

    const evidence: Record<string, string[]> = {}
    const confidenceScores: Record<string, number> = {}
    for (const [k, v] of Object.entries(detections)) {
      evidence[k] = v.evidence
      confidenceScores[k] = v.confidence
    }

    const profile = {
      platform: process.platform,
      productivity_stack: productivityStack,
      evidence,
      confidence_scores: confidenceScores,
      suggested_integrations: suggested.slice(0, 5),
    }

    // Render
    printDivider()
    printKV("Platform", process.platform)
    printKV("Stack", productivityStack)
    printKV("Detected", String(Object.keys(detections).length))
    printKV("Connected", String(integrationKeys.length))
    printDivider()
    UI.println(bold("Top detections:"))
    Object.entries(detections)
      .sort((a, b) => b[1].confidence - a[1].confidence)
      .slice(0, 10)
      .forEach(([k, v]) => UI.println(`  ${String(v.confidence).padStart(3)}  ${v.label}  (${k})`))
    if (suggested.length > 0) {
      UI.empty()
      UI.println(bold("Suggested next integrations to connect:"))
      suggested.slice(0, 5).forEach((s) => UI.println(`  • ${detections[s]?.label ?? s}`))
    }
    UI.empty()

    if (args["dry-run"]) {
      prompts.log.info("Dry run — profile not posted.")
      prompts.outro("Done")
      return
    }

    sp.start("Saving stack profile…")
    try {
      const res = await irisFetch(`/api/v1/users/${userId}/stack-profile`, {
        method: "POST",
        body: JSON.stringify(profile),
      })
      if (!(await handleApiError(res, "Save stack profile"))) {
        sp.stop("Failed", 1); prompts.outro("Done"); return
      }
      sp.stop(success("Stack profile saved"))
    } catch (err: any) {
      sp.stop("Failed", 1)
      prompts.log.error(err?.message ?? String(err))
    }

    prompts.outro("Scan complete")
  },
})
