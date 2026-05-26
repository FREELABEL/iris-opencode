import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { printDivider, dim, bold, success, getBridgeToken, BRIDGE_URL } from "./iris-api"

const BRIDGE_BASE = BRIDGE_URL

function bridgeHeaders(): Record<string, string> {
  const token = getBridgeToken()
  const headers: Record<string, string> = { Accept: "application/json" }
  if (token) headers["X-Bridge-Key"] = token
  return headers
}

async function bridgeFetch(path: string, timeout = 30000): Promise<any> {
  const res = await fetch(`${BRIDGE_BASE}${path}`, {
    headers: bridgeHeaders(),
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let message = `HTTP ${res.status}`
    try { const err = JSON.parse(text) as any; if (err?.error) message = err.error } catch {
      if (res.status === 404 && text.includes("Cannot")) message = "Instagram endpoints not available. Restart bridge: iris bridge restart"
    }
    throw new Error(message)
  }
  return res.json()
}

function formatTimestamp(ts: string): string {
  if (!ts) return ""
  try {
    return new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  } catch { return ts }
}

const InstagramInboxCommand = cmd({
  command: "inbox",
  aliases: ["list", "dms", "ls"],
  describe: "scan Instagram DM inbox (uses saved browser session)",
  builder: (yargs) =>
    yargs
      .option("account", { type: "string", describe: "IG account name (e.g., freelabelnet)" })
      .option("limit", { type: "number", default: 20, describe: "max conversations" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Instagram Inbox") }

    try {
      const sp = args.json ? null : prompts.spinner()
      if (sp) sp.start("Scanning Instagram DMs (this takes ~10s)...")

      let url = `/api/instagram/inbox?limit=${args.limit}`
      if (args.account) url += `&account=${encodeURIComponent(args.account)}`

      const data = await bridgeFetch(url, 60000)
      const conversations = data?.conversations ?? []

      if (sp) sp.stop(`${conversations.length} conversation(s)`)

      if (!conversations.length) {
        prompts.log.info("No DM conversations found")
        prompts.log.info(dim("Check your session: iris hive credentials save-session --platform instagram"))
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

      if (data.account) prompts.log.info(dim(`Account: @${data.account}`))
      printDivider()
      for (const conv of conversations) {
        const time = conv.timestamp ? dim(formatTimestamp(conv.timestamp)) : ""
        console.log(`  ${bold(conv.username)}  ${time}`)
        if (conv.preview) console.log(`    ${dim(conv.preview.slice(0, 100))}`)
        console.log()
      }
      printDivider()
      prompts.outro(`${success("✓")} ${conversations.length} conversation${conversations.length === 1 ? "" : "s"}`)
    } catch (err: any) {
      if (err.name === "TimeoutError" || err.message?.includes("fetch failed")) {
        prompts.log.error("Bridge not running. Start with: iris bridge start")
      } else { prompts.log.error(err.message) }
      prompts.outro("Done")
    }
  },
})

const InstagramScrapeCommand = cmd({
  command: "scrape <url>",
  describe: "scrape an Instagram post (caption, images, metadata)",
  builder: (yargs) =>
    yargs
      .positional("url", { type: "string", demandOption: true, describe: "Instagram post URL" })
      .option("account", { type: "string", describe: "IG account for session" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Instagram Scrape") }

    try {
      const sp = args.json ? null : prompts.spinner()
      if (sp) sp.start("Scraping post...")

      const res = await fetch(`${BRIDGE_BASE}/api/scrape/instagram`, {
        method: "POST",
        headers: { ...bridgeHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ url: args.url, account: args.account }),
        signal: AbortSignal.timeout(30000),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as any
        throw new Error(err?.error || `HTTP ${res.status}`)
      }

      const data = await res.json()
      if (sp) sp.stop("Done")

      if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

      printDivider()
      if (data.caption) console.log(`  ${bold("Caption:")} ${data.caption.slice(0, 300)}${data.caption.length > 300 ? "..." : ""}`)
      if (data.author) console.log(`  ${bold("Author:")} ${data.author}`)
      if (data.timestamp) console.log(`  ${bold("Date:")} ${data.timestamp}`)
      if (data.images?.length) console.log(`  ${bold("Images:")} ${data.images.length} image(s)`)
      if (data.location) console.log(`  ${bold("Location:")} ${data.location}`)
      printDivider()
      prompts.outro(success("Scraped"))
    } catch (err: any) {
      prompts.log.error(err.message)
      prompts.outro("Done")
    }
  },
})

export const PlatformInstagramCommand = cmd({
  command: "instagram",
  aliases: ["ig"],
  describe: "scan Instagram DMs and scrape posts (requires saved browser session)",
  builder: (yargs) =>
    yargs
      .command(InstagramInboxCommand)
      .command(InstagramScrapeCommand)
      .strict(false),
  async handler() {
    return InstagramInboxCommand.handler({} as any)
  },
})