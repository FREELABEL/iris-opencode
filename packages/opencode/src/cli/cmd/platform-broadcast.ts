import { homedir } from "os"
import { join } from "path"
import { existsSync, readFileSync } from "fs"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, success, irisFetch, PLATFORM_URLS } from "./iris-api"

// A bloq can omit --bloq-id by storing `default_bloq_id` in ~/.iris/config.json.
function resolveDefaultBloqId(): number | undefined {
  try {
    const p = join(homedir(), ".iris", "config.json")
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, "utf-8"))
      const v = cfg.default_bloq_id ?? cfg.bloq_id
      if (typeof v === "number") return v
      if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10)
    }
  } catch {}
  return undefined
}

interface BroadcastResult {
  recipient_type: "human" | "agent"
  recipient_id: number
  name: string
  status: "sent" | "failed" | "skipped" | "preview"
  target?: string
  reason?: string
  error?: string
}

export const PlatformBroadcastCommand = cmd({
  command: "broadcast <message>",
  describe: "Broadcast an announcement to every member of a Bloq — humans (email) + AI agents (inbox)",
  builder: (yargs) =>
    yargs
      .positional("message", {
        describe: "The announcement body",
        type: "string",
        demandOption: true,
      })
      .option("bloq-id", {
        type: "number",
        alias: "b",
        describe: "Bloq to broadcast to (default: default_bloq_id in ~/.iris/config.json)",
      })
      .option("title", { type: "string", alias: "t", describe: "Optional headline / email subject" })
      .option("audience", {
        type: "string",
        choices: ["all", "humans", "agents"] as const,
        default: "all",
        describe: "Who to reach: all members, humans only, or agents only",
      })
      .option("dry-run", { type: "boolean", default: false, describe: "Preview the recipient list without sending" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Broadcast")

    const title = args.title as string | undefined
    const message = args.message as string
    const audience = args.audience as string
    const dryRun = args["dry-run"] as boolean

    const bloqId = (args["bloq-id"] as number | undefined) ?? resolveDefaultBloqId()
    if (!bloqId) {
      prompts.log.error("Which bloq? Pass --bloq-id <id> (or set default_bloq_id in ~/.iris/config.json)")
      prompts.outro("Done")
      process.exitCode = 1
      return
    }

    const body: Record<string, unknown> = { message, audience, dry_run: dryRun }
    if (title) body.title = title

    const sp = prompts.spinner()
    sp.start(dryRun ? "Resolving members..." : "Broadcasting...")
    let res: Response
    try {
      res = await irisFetch(
        `/api/v6/bloqs/${bloqId}/broadcast`,
        { method: "POST", body: JSON.stringify(body) },
        PLATFORM_URLS.irisApi,
      )
    } catch (e: any) {
      sp.stop("Request failed")
      prompts.log.error(e?.message || String(e))
      prompts.outro("Done")
      process.exitCode = 1
      return
    }

    if (!res.ok) {
      sp.stop("Failed")
      const data = (await res.json().catch(() => ({}))) as any
      prompts.log.error(
        res.status === 404
          ? `Bloq ${bloqId} not found (or not yours)`
          : data?.error || data?.message || `HTTP ${res.status}`,
      )
      prompts.outro("Done")
      process.exitCode = 1
      return
    }

    const data = (await res.json()) as {
      sent: number
      failed: number
      skipped: number
      results: BroadcastResult[]
    }
    sp.stop(dryRun ? "Preview" : "Done")

    if (!data.results.length) {
      prompts.log.warn(`Bloq ${bloqId} has no members matching audience "${audience}".`)
      prompts.outro("Nothing to send")
      return
    }

    for (const r of data.results) {
      const who = `${r.name} ${dim(`(${r.recipient_type})`)}`
      if (r.status === "sent") {
        prompts.log.success(`${success("✓")} ${who}${r.target ? dim(` → ${r.target}`) : ""}`)
      } else if (r.status === "preview") {
        prompts.log.info(`${bold(r.name)} ${dim(`(${r.recipient_type})`)}${r.target ? dim(` → ${r.target}`) : ""}`)
      } else if (r.status === "skipped") {
        prompts.log.warn(`${dim("–")} ${who}: ${r.reason ?? "skipped"}`)
      } else {
        prompts.log.error(`✗ ${who}: ${r.error ?? "failed"}`)
      }
    }

    if (dryRun) {
      const previews = data.results.filter((r) => r.status === "preview").length
      prompts.outro(`Dry run — ${previews} member(s) would receive this`)
      return
    }

    const summary = [`${data.sent} sent`, data.failed ? `${data.failed} failed` : "", data.skipped ? `${data.skipped} skipped` : ""]
      .filter(Boolean)
      .join(", ")
    if (data.sent === 0 && data.failed > 0) process.exitCode = 1
    prompts.outro(data.sent > 0 ? `${success("✓")} ${summary}` : summary || "Nothing sent")
  },
})
