import { homedir } from "os"
import { join } from "path"
import { existsSync, readFileSync } from "fs"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, success, irisFetch, PLATFORM_URLS } from "./iris-api"
import { resolveDiscordWebhook } from "./platform-release"

// A bloq with a single connected channel can omit --bloq-id by storing
// `default_bloq_id` in ~/.iris/config.json.
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

// Operator escape hatch only (--webhook): post one Discord embed locally, bypassing
// the bloq broadcast. Used internally when no bloq channel is connected.
async function publishDiscordWebhook(
  webhook: string,
  title: string | undefined,
  message: string,
  tag?: string,
): Promise<void> {
  const fields = tag ? [{ name: "Version", value: tag, inline: true }] : []
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [
        {
          ...(title ? { title } : {}),
          description: message,
          color: 0x8b5cf6,
          fields,
          footer: { text: "IRIS" },
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`Discord webhook: HTTP ${res.status}`)
}

interface AnnounceResult {
  channel_id: number
  channel_type: string
  status: "sent" | "failed" | "skipped" | "preview"
  target?: string
  error?: string
  reason?: string
  preview?: string
}

export const PlatformAnnounceCommand = cmd({
  command: "announce <message>",
  describe: "Broadcast an announcement to a Bloq's connected Slack + Discord channels",
  builder: (yargs) =>
    yargs
      .positional("message", {
        describe: "The announcement body (markdown supported)",
        type: "string",
        demandOption: true,
      })
      .option("bloq-id", {
        type: "number",
        alias: "b",
        describe: "Bloq to broadcast to (default: default_bloq_id in ~/.iris/config.json)",
      })
      .option("title", { type: "string", alias: "t", describe: "Optional bold headline above the message" })
      .option("tag", { type: "string", describe: "Optional version tag (e.g. v1.3.81)" })
      .option("channels", {
        type: "string",
        describe: "Limit to specific channel types, comma-separated (e.g. slack,discord)",
      })
      .option("dry-run", { type: "boolean", default: false, describe: "Preview without sending" })
      .option("webhook", {
        type: "string",
        describe: "OPERATOR: post one Discord embed to this webhook, bypassing the bloq",
      }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Announce")

    const title = args.title as string | undefined
    const message = args.message as string
    const tag = args.tag as string | undefined
    const dryRun = args["dry-run"] as boolean

    // ── Operator escape hatch: --webhook (or fall back to a configured webhook) ──
    if (args.webhook) {
      const webhook = (args.webhook as string) || (await resolveDiscordWebhook())
      if (!webhook) {
        prompts.log.error("No Discord webhook resolved")
        prompts.outro("Done")
        process.exitCode = 1
        return
      }
      if (dryRun) {
        prompts.log.info(`${bold("Would post to Discord webhook:")}\n${title ? bold(title) + "\n" : ""}${message}`)
        prompts.outro("Dry run — nothing sent")
        return
      }
      const sp = prompts.spinner()
      sp.start("Publishing to Discord (webhook)...")
      try {
        await publishDiscordWebhook(webhook, title, message, tag)
        sp.stop(success("Discord published"))
        prompts.outro(`${success("✓")} Published`)
      } catch (e: any) {
        sp.stop("Discord failed")
        prompts.log.error(e?.message || String(e))
        process.exitCode = 1
      }
      return
    }

    // ── Product path: broadcast to the bloq's connected channels (per-tenant tokens) ──
    const bloqId = (args["bloq-id"] as number | undefined) ?? resolveDefaultBloqId()
    if (!bloqId) {
      prompts.log.error("Which bloq? Pass --bloq-id <id> (or set default_bloq_id in ~/.iris/config.json)")
      prompts.outro("Done")
      process.exitCode = 1
      return
    }

    const body: Record<string, unknown> = { message, dry_run: dryRun }
    if (title) body.title = title
    if (tag) body.tag = tag
    if (args.channels) body.channel_types = String(args.channels).split(",").map((s) => s.trim()).filter(Boolean)

    const sp = prompts.spinner()
    sp.start(dryRun ? "Resolving channels..." : "Broadcasting...")
    let res: Response
    try {
      res = await irisFetch(
        `/api/v6/bloqs/${bloqId}/announce`,
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

    const data = (await res.json()) as { sent: number; failed: number; skipped: number; results: AnnounceResult[] }
    sp.stop(dryRun ? "Preview" : "Done")

    if (!data.results.length) {
      prompts.log.warn(
        `No Slack/Discord channels connected to bloq ${bloqId} — run: iris channels connect slack --bloq-id ${bloqId}`,
      )
      prompts.outro("Nothing to send")
      return
    }

    for (const r of data.results) {
      const where = `${r.channel_type}${r.target ? ` → ${r.target}` : ""}`
      if (r.status === "sent") {
        prompts.log.success(`${success("✓")} ${where}`)
      } else if (r.status === "preview") {
        prompts.log.info(`${bold(where)}\n${r.preview}`)
      } else if (r.status === "skipped") {
        prompts.log.warn(`${dim("–")} ${r.channel_type}: ${r.reason ?? "skipped"}`)
      } else {
        const hint =
          r.error === "not_in_channel"
            ? " — invite the bot to that channel in Slack"
            : r.error === "channel_not_found"
              ? " — check the announce target id"
              : ""
        prompts.log.error(`✗ ${where}: ${r.error}${hint}`)
      }
    }

    if (dryRun) {
      prompts.outro(`Dry run — ${data.results.filter((r) => r.status === "preview").length} channel(s) would receive this`)
      return
    }

    const summary = [`${data.sent} sent`, data.failed ? `${data.failed} failed` : "", data.skipped ? `${data.skipped} skipped` : ""]
      .filter(Boolean)
      .join(", ")
    if (data.sent === 0 && data.failed > 0) process.exitCode = 1
    prompts.outro(data.sent > 0 ? `${success("✓")} ${summary}` : summary || "Nothing published")
  },
})
