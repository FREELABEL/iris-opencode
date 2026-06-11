import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  requireUserId,
  IRIS_API,
  dim,
  bold,
  success,
  highlight,
  getBridgeToken,
  PLATFORM_URLS,
} from "./iris-api"

const BRIDGE_URL = "http://localhost:3200"

// Channel type metadata
const CHANNEL_META: Record<string, { icon: string; name: string; connectVia: string }> = {
  discord: { icon: "🎮", name: "Discord", connectVia: "oauth" },
  slack: { icon: "💬", name: "Slack", connectVia: "oauth" },
  telegram: { icon: "✈️", name: "Telegram", connectVia: "bot_token" },
  whatsapp: { icon: "📱", name: "WhatsApp", connectVia: "oauth" },
  email: { icon: "📧", name: "Email", connectVia: "config" },
  imessage: { icon: "💬", name: "iMessage", connectVia: "bridge" },
}

function printDivider() {
  console.log(`  ${dim("─".repeat(56))}`)
}

// ─── List ────────────────────────────────────────────────────────

const ChannelsListCommand = cmd({
  command: "list",
  describe: "show all connected messaging channels",
  async handler() {
    UI.empty()
    prompts.intro("◈  Messaging Channels")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const userId = await requireUserId()

    // Fetch workflow_channels from iris-api
    const sp = prompts.spinner()
    sp.start("Loading channels…")

    try {
      // Get workflow channels for this user
      const res = await irisFetch(`/api/v6/user/channels`, {}, PLATFORM_URLS.irisApi)
      let channels: any[] = []

      if (res.ok) {
        const data = (await res.json()) as any
        channels = data?.channels ?? data?.data ?? []
      }

      // Also check bridge for live bot status
      let bridgeStatus: any = null
      try {
        const bh = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(2000) })
        if (bh.ok) bridgeStatus = await bh.json()
      } catch {}

      sp.stop("Loaded")

      if (channels.length === 0 && !bridgeStatus?.messaging) {
        console.log()
        console.log(`  No channels connected yet.`)
        console.log()
        console.log(`  ${dim("Connect one:")}`)
        console.log(`    ${highlight("iris channels connect discord")}`)
        console.log(`    ${highlight("iris channels connect slack")}`)
        console.log(`    ${highlight("iris channels connect telegram")}`)
        prompts.outro("Done")
        return
      }

      printDivider()

      // Show database channels
      for (const ch of channels) {
        const meta = CHANNEL_META[ch.channel_type] ?? { icon: "📡", name: ch.channel_type }
        const status = ch.is_active ? `${success("● active")}` : `${dim("○ inactive")}`
        console.log(`  ${meta.icon} ${bold(meta.name)}  ${status}`)
        console.log(`    ${dim("ID:")} ${ch.id}  ${dim("Identifier:")} ${ch.channel_identifier ?? "—"}`)
        if (ch.bloq_id) console.log(`    ${dim("Bloq:")} ${ch.bloq_id}  ${dim("Agent:")} ${ch.agent_id ?? "default"}`)
        if (ch.config?.bot_token) console.log(`    ${dim("Bot token:")} ${ch.config.bot_token.slice(0, 15)}...`)
        console.log()
      }

      // Show bridge live status
      if (bridgeStatus?.messaging) {
        const msg = bridgeStatus.messaging
        console.log(`  ${bold("Bridge Live Status")} ${dim("(localhost:3200)")}`)
        printDivider()

        if (msg.discord?.status === "running") {
          const bots = msg.discord.bots ?? []
          for (const bot of bots) {
            console.log(`  🎮 ${bot.username}  ${bot.ready ? success("● online") : dim("○ connecting")}`)
          }
        } else {
          console.log(`  🎮 Discord  ${dim("○ not connected")}`)
        }

        if (msg.imessage?.running) {
          console.log(`  💬 iMessage  ${success("● running")}  ${dim(`${msg.imessage.conversations} convos`)}`)
        }

        if (msg.telegram?.status === "running") {
          console.log(`  ✈️  Telegram  ${success("● online")}  ${dim(msg.telegram.username ?? "")}`)
        }

        console.log()
      }

      printDivider()
      prompts.outro("Done")
    } catch (e) {
      sp.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})

// ─── Connect ─────────────────────────────────────────────────────

const ChannelsConnectCommand = cmd({
  command: "connect <type>",
  describe: "connect a messaging channel (discord, slack, telegram)",
  builder: (y) =>
    y
      .positional("type", { type: "string", demandOption: true, describe: "channel type (discord, slack, telegram, whatsapp)" })
      .option("print-url", { type: "boolean", default: false, describe: "print the OAuth URL instead of opening browser" })
      .option("bot-token", { type: "string", describe: "bot token for Telegram or custom bots" })
      .option("bloq-id", { type: "number", describe: "bloq to scope this channel to (PROJECT MODE)" })
      .option("agent-id", { type: "number", describe: "agent to handle messages on this channel" }),
  async handler(args) {
    UI.empty()
    const type = String(args.type).toLowerCase()
    const meta = CHANNEL_META[type] ?? { icon: "📡", name: type }
    prompts.intro(`◈  Connect ${meta.icon} ${meta.name}`)

    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const userId = await requireUserId()

    // Telegram: requires bot token (no OAuth)
    if (type === "telegram" && !args["bot-token"]) {
      console.log()
      console.log(`  Telegram requires a bot token from @BotFather.`)
      console.log(`  ${dim("1. Open Telegram → message @BotFather")}`)
      console.log(`  ${dim("2. Send /newbot and follow the prompts")}`)
      console.log(`  ${dim("3. Copy the bot token")}`)
      console.log()
      const token = await prompts.password({ message: "Paste your bot token:", mask: "•" })
      if (prompts.isCancel(token) || !token) { prompts.outro("Cancelled"); return }
      args["bot-token"] = token as string
    }

    // Bot token flow (Telegram, custom bots)
    if (args["bot-token"]) {
      const sp = prompts.spinner()
      sp.start("Creating channel…")
      try {
        const res = await irisFetch(`/api/v6/bloqs/${args["bloq-id"] ?? 0}/channels`, {
          method: "POST",
          body: JSON.stringify({
            user_id: userId,
            channel_type: type,
            config: { bot_token: args["bot-token"] },
            bloq_id: args["bloq-id"] ?? null,
            agent_id: args["agent-id"] ?? null,
          }),
        }, PLATFORM_URLS.irisApi)

        if (res.ok) {
          sp.stop("Connected", 0)
          prompts.log.success(`${meta.name} channel created. Bot token stored securely.`)
        } else {
          sp.stop("Failed", 1)
          const err = await res.json().catch(() => ({})) as any
          prompts.log.error(err?.message ?? `HTTP ${res.status}`)
        }
      } catch (e) {
        sp.stop("Failed", 1)
        prompts.log.error(e instanceof Error ? e.message : String(e))
      }
      prompts.outro("Done")
      return
    }

    // iMessage: bridge-based (no OAuth, no API)
    if (type === "imessage") {
      console.log()
      console.log(`  iMessage runs via the local bridge (macOS only).`)
      console.log(`  ${dim("It's already configured if the bridge is running.")}`)
      console.log()
      try {
        const bh = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(2000) })
        const data = (await bh.json()) as any
        if (data?.messaging?.imessage?.running) {
          prompts.log.success(`iMessage is running (${data.messaging.imessage.conversations} conversations)`)
        } else {
          prompts.log.warn("iMessage not running. Start bridge: iris bridge start")
        }
      } catch {
        prompts.log.warn("Bridge not running. Start with: iris bridge start")
      }
      prompts.outro("Done")
      return
    }

    // Slack agent-channel: "Add to Slack" OAuth bound to a Bloq (PROJECT MODE).
    // The workspace's bot token is captured by our callback — no token pasting.
    if (type === "slack") {
      const bloqId = args["bloq-id"]
      if (!bloqId) {
        console.log()
        prompts.log.error("Slack needs a Bloq to scope the agent to.")
        console.log(`  ${dim("Example:")} ${highlight("iris channels connect slack --bloq-id 368")}`)
        prompts.outro("Done")
        return
      }

      const sp = prompts.spinner()
      sp.start("Preparing Slack install link…")
      try {
        const res = await irisFetch(
          `/api/v6/bloqs/${bloqId}/channels/slack`,
          {
            method: "POST",
            body: JSON.stringify({
              agent_id: args["agent-id"] ?? null,
              memory_scope: "per_channel",
            }),
          },
          PLATFORM_URLS.irisApi,
        )

        const data = (await res.json().catch(() => ({}))) as any

        if (!res.ok) {
          sp.stop("Failed", 1)
          // 422 carries a human message: app not configured, or bloq has no agent
          prompts.log.error(data?.error ?? `HTTP ${res.status}`)
          if (String(data?.error ?? "").includes("SLACK_CLIENT_ID")) {
            console.log(`  ${dim("The IRIS Slack app isn't set up yet. See docs/slack-channel-setup.md (Part 1).")}`)
          }
          prompts.outro("Done")
          return
        }

        const url = data?.install_url as string
        sp.stop("Ready")
        console.log()
        if (data?.agent) {
          console.log(`  ${dim("Agent:")} ${bold(data.agent.name)} ${dim(`(#${data.agent.id})`)}  ${dim("Bloq:")} ${bloqId}`)
          console.log()
        }
        if (args["print-url"]) {
          console.log(`  ${highlight(url)}`)
        } else {
          console.log(`  ${dim("Opening Slack authorization…")}`)
          openBrowser(url)
          console.log(`  ${dim("If it didn't open:")} ${highlight(url)}`)
        }
        console.log()
        prompts.log.info("Approve in the Slack workspace, then invite the bot to a channel and mention it.")
        prompts.log.info(`Confirm with ${highlight("iris channels list")}.`)
        console.log(`  ${dim("Link expires in 30 minutes. Hand it to the client to install in their own workspace.")}`)
      } catch (e) {
        sp.stop("Failed", 1)
        prompts.log.error(e instanceof Error ? e.message : String(e))
      }
      prompts.outro("Done")
      return
    }

    // OAuth flow (Discord, WhatsApp, Facebook) — integration/tool linking
    const sp = prompts.spinner()
    sp.start("Generating OAuth URL…")

    try {
      // Try iris-api first (has Discord native OAuth + YAML channels)
      let url: string | null = null

      const res = await irisFetch(
        `/api/v1/integrations-temp/oauth-url/${type}?user_id=${userId}`,
        {},
        PLATFORM_URLS.irisApi,
      )

      if (res.ok) {
        const data = (await res.json()) as any
        url = data?.data?.oauth_url ?? data?.oauth_url ?? data?.url ?? null

        // Buffer-type integrations (auth: none) — auto-activated, no OAuth needed
        if (data?.data?.message?.includes("no OAuth required")) {
          sp.stop("Connected", 0)
          prompts.log.success(`${meta.name} activated (no OAuth required)`)
          prompts.outro("Done")
          return
        }
      }

      // Fallback: try fl-api
      if (!url) {
        const res2 = await irisFetch(`/api/v1/users/${userId}/integrations/oauth-url/${type}`)
        if (res2.ok) {
          const data = (await res2.json()) as any
          url = data?.url ?? data?.oauth_url ?? null
        }
      }

      if (!url) {
        sp.stop("Failed", 1)
        prompts.log.error(`Could not generate OAuth URL for ${type}`)
        prompts.log.info(dim("The integration may not be configured yet."))
        prompts.outro("Done")
        return
      }

      sp.stop("Ready")
      console.log()

      if (args["print-url"]) {
        console.log(`  ${highlight(url)}`)
      } else {
        console.log(`  ${dim("Opening browser…")}`)
        openBrowser(url)
        console.log(`  ${dim("If it didn't open:")} ${highlight(url)}`)
      }

      console.log()
      prompts.log.info(`After authorizing, your ${meta.name} account will be linked automatically.`)
      prompts.log.info(`DM the bot to start chatting with your IRIS AI agent.`)
    } catch (e) {
      sp.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
    }

    prompts.outro("Done")
  },
})

// ─── Disconnect ──────────────────────────────────────────────────

const ChannelsDisconnectCommand = cmd({
  command: "disconnect <type>",
  describe: "disconnect a messaging channel",
  builder: (y) =>
    y.positional("type", { type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    const type = String(args.type).toLowerCase()
    const meta = CHANNEL_META[type] ?? { icon: "📡", name: type }
    prompts.intro(`◈  Disconnect ${meta.icon} ${meta.name}`)

    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const confirmed = await prompts.confirm({
      message: `Disconnect ${meta.name}? The bot will stop responding on this channel.`,
    })
    if (prompts.isCancel(confirmed) || !confirmed) { prompts.outro("Cancelled"); return }

    const sp = prompts.spinner()
    sp.start("Disconnecting…")

    try {
      // Deactivate workflow_channels records for this type
      const res = await irisFetch(`/api/v6/user/channels/${type}`, {
        method: "DELETE",
      }, PLATFORM_URLS.irisApi)

      if (res.ok) {
        sp.stop("Disconnected", 0)
        prompts.log.success(`${meta.name} channel deactivated`)
      } else {
        // Try bridge disconnect as fallback
        const token = getBridgeToken()
        const headers: Record<string, string> = { "Content-Type": "application/json" }
        if (token) headers["X-Bridge-Key"] = token

        const bRes = await fetch(`${BRIDGE_URL}/api/providers/${type}`, {
          method: "DELETE",
          headers,
          signal: AbortSignal.timeout(5000),
        })

        if (bRes.ok) {
          sp.stop("Disconnected", 0)
          prompts.log.success(`${meta.name} bot stopped on bridge`)
        } else {
          sp.stop("Failed", 1)
          prompts.log.error(`Could not disconnect ${type}`)
        }
      }
    } catch (e) {
      sp.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
    }

    prompts.outro("Done")
  },
})

// ─── Status ──────────────────────────────────────────────────────

const ChannelsStatusCommand = cmd({
  command: "status",
  describe: "health check across all messaging channels",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(args) {
    const jsonOut = (args as any).json as boolean
    if (!jsonOut) { UI.empty(); prompts.intro("◈  Channel Health — All Channels") }

    const checks: { name: string; icon: string; ok: boolean; detail: string; connect: string }[] = []

    // ── iMessage (local SQLite) ──
    try {
      const { isAvailable: imAvail } = require("../lib/imessage")
      if (imAvail()) {
        const { listChats } = require("../lib/imessage")
        const chats = listChats(7, 999)
        checks.push({ name: "iMessage", icon: "💬", ok: true, detail: `${chats.length} chats (7d)`, connect: "" })
      } else {
        checks.push({ name: "iMessage", icon: "💬", ok: false, detail: "Full Disk Access required", connect: "System Settings > Privacy > Full Disk Access" })
      }
    } catch {
      checks.push({ name: "iMessage", icon: "💬", ok: false, detail: "not available (macOS only)", connect: "" })
    }

    // ── WhatsApp (local SQLite) ──
    try {
      const { isAvailable: waAvail, listChats: waChats } = require("../lib/whatsapp")
      if (waAvail()) {
        const chats = waChats(7, 999)
        checks.push({ name: "WhatsApp", icon: "📱", ok: true, detail: `${chats.length} chats (7d)`, connect: "" })
      } else {
        checks.push({ name: "WhatsApp", icon: "📱", ok: false, detail: "WhatsApp desktop not installed or no access", connect: "Install WhatsApp desktop + grant Full Disk Access" })
      }
    } catch {
      checks.push({ name: "WhatsApp", icon: "📱", ok: false, detail: "not available", connect: "" })
    }

    // ── Gmail (OAuth via fl-api) ──
    try {
      const { getToken: gmailToken } = await import("../lib/gmail")
      const token = await gmailToken()
      if (token) {
        // Quick validation — fetch labels
        const res = await fetch("https://www.googleapis.com/gmail/v1/users/me/labels?maxResults=1", {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        })
        checks.push({ name: "Gmail", icon: "📧", ok: res.ok, detail: res.ok ? "connected (OAuth)" : "token expired", connect: "iris channels connect gmail" })
      } else {
        checks.push({ name: "Gmail", icon: "📧", ok: false, detail: "not connected", connect: "iris channels connect gmail" })
      }
    } catch {
      checks.push({ name: "Gmail", icon: "📧", ok: false, detail: "not connected", connect: "iris channels connect gmail" })
    }

    // ── Apple Mail (bridge) ──
    try {
      const token = getBridgeToken()
      const headers: Record<string, string> = { Accept: "application/json" }
      if (token) headers["X-Bridge-Key"] = token
      const res = await fetch(`${BRIDGE_URL}/api/mail/search?from=test&days=1&limit=1`, { headers, signal: AbortSignal.timeout(3000) })
      checks.push({ name: "Apple Mail", icon: "📨", ok: res.ok || res.status === 200, detail: res.ok ? "bridge connected" : "bridge error", connect: "iris bridge start" })
    } catch {
      checks.push({ name: "Apple Mail", icon: "📨", ok: false, detail: "bridge not running", connect: "iris bridge start" })
    }

    // ── Slack (OAuth via fl-api) ──
    try {
      const { getToken: slackToken } = await import("../lib/slack")
      const token = await slackToken()
      if (token) {
        const res = await fetch("https://slack.com/api/auth.test", {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        })
        const data = res.ok ? await res.json() as any : null
        checks.push({ name: "Slack", icon: "💬", ok: !!data?.ok, detail: data?.ok ? `@${data.user} in ${data.team}` : "token invalid", connect: "iris channels connect slack" })
      } else {
        checks.push({ name: "Slack", icon: "💬", ok: false, detail: "not connected", connect: "iris channels connect slack" })
      }
    } catch {
      checks.push({ name: "Slack", icon: "💬", ok: false, detail: "not connected", connect: "iris channels connect slack" })
    }

    // ── Discord (bridge bot) ──
    try {
      const token = getBridgeToken()
      const headers: Record<string, string> = { Accept: "application/json" }
      if (token) headers["X-Bridge-Key"] = token
      const res = await fetch(`${BRIDGE_URL}/api/discord/guilds`, { headers, signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        const data = await res.json() as any
        checks.push({ name: "Discord", icon: "🎮", ok: true, detail: `${data.count} server(s)`, connect: "" })
      } else {
        const err = await res.json().catch(() => ({})) as any
        checks.push({ name: "Discord", icon: "🎮", ok: false, detail: err?.error?.includes("No Discord") ? "no bot connected" : `HTTP ${res.status}`, connect: "iris channels connect discord" })
      }
    } catch {
      checks.push({ name: "Discord", icon: "🎮", ok: false, detail: "bridge not running", connect: "iris bridge start" })
    }

    // ── Telegram (bridge bot) ──
    try {
      const token = getBridgeToken()
      const headers: Record<string, string> = { Accept: "application/json" }
      if (token) headers["X-Bridge-Key"] = token
      const res = await fetch(`${BRIDGE_URL}/api/telegram/info`, { headers, signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        const data = await res.json() as any
        if (data.connected) {
          checks.push({ name: "Telegram", icon: "✈️", ok: true, detail: `@${data.username} (${data.cached_messages} cached msgs)`, connect: "" })
        } else {
          checks.push({ name: "Telegram", icon: "✈️", ok: false, detail: "no bot connected", connect: "iris channels connect telegram" })
        }
      } else {
        checks.push({ name: "Telegram", icon: "✈️", ok: false, detail: "bridge endpoint missing", connect: "iris bridge restart" })
      }
    } catch {
      checks.push({ name: "Telegram", icon: "✈️", ok: false, detail: "bridge not running", connect: "iris bridge start" })
    }

    // ── Instagram (browser session) ──
    try {
      const fs = require("fs")
      const path = require("path")
      const somDir = path.join(process.env.HOME, "Sites/freelabel/fl-docker-dev/coding-agent-bridge/som")
      const testsDir = path.join(process.env.HOME, "Sites/freelabel/tests/e2e")
      const candidates = ["instagram-auth-thediscoverpage_.json", "instagram-auth-freelabelnet.json", "instagram-auth-heyiris.io.json", "instagram-auth.json"]
      let found = false
      for (const f of candidates) {
        if (fs.existsSync(path.join(somDir, f)) || fs.existsSync(path.join(testsDir, f))) { found = true; break }
      }
      checks.push({ name: "Instagram", icon: "📷", ok: found, detail: found ? "session file found" : "no saved session", connect: "iris hive credentials save-session --platform instagram" })
    } catch {
      checks.push({ name: "Instagram", icon: "📷", ok: false, detail: "not available", connect: "" })
    }

    // ── JSON output ──
    if (jsonOut) {
      console.log(JSON.stringify(checks.map(c => ({ name: c.name, ok: c.ok, detail: c.detail, connect: c.connect || undefined })), null, 2))
      return
    }

    // ── Display ──
    const connected = checks.filter(c => c.ok).length
    const total = checks.length

    printDivider()
    for (const c of checks) {
      const icon = c.ok ? success("✓") : "✗"
      const connectHint = !c.ok && c.connect ? `  ${dim(c.connect)}` : ""
      console.log(`  ${icon} ${c.icon} ${bold(c.name.padEnd(12))}  ${c.ok ? success(c.detail) : c.detail}${connectHint}`)
    }
    printDivider()

    if (connected === total) {
      prompts.log.success(`All ${total} channels connected`)
    } else {
      prompts.log.info(`${connected}/${total} channels connected`)
      const disconnected = checks.filter(c => !c.ok)
      if (disconnected.length > 0) {
        console.log()
        console.log(`  ${dim("To connect:")}`)
        for (const c of disconnected) {
          if (c.connect) console.log(`    ${c.icon} ${c.name}: ${highlight(c.connect)}`)
        }
      }
    }

    prompts.outro("Done")
  },
})

// ─── Helper: open browser ────────────────────────────────────────

function openBrowser(url: string) {
  try {
    const { execSync } = require("child_process")
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
    execSync(`${cmd} "${url}"`, { stdio: "ignore" })
  } catch {}
}

// ─── Announce Target ─────────────────────────────────────────────
// Designate which channel (within a connected workspace) receives announcements.
// Set once → `iris announce` broadcasts to it forever.

const AnnounceTargetSetCommand = cmd({
  command: "set <type>",
  describe: "designate which channel receives announcements",
  builder: (yargs) =>
    yargs
      .positional("type", { type: "string", demandOption: true, describe: "channel type (slack, discord)" })
      .option("bloq-id", { type: "number", demandOption: true, describe: "bloq the channel belongs to" })
      .option("channel", { type: "string", demandOption: true, describe: "the Slack/Discord channel id to post announcements to" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Announce Target")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const type = String(args.type)
    const bloqId = args["bloq-id"] as number
    const channelId = String(args.channel)

    const sp = prompts.spinner()
    sp.start("Setting target…")
    try {
      const setRes = await irisFetch(
        `/api/v6/bloqs/${bloqId}/announce-target`,
        { method: "POST", body: JSON.stringify({ channel_type: type, channel_id: channelId }) },
        PLATFORM_URLS.irisApi,
      )
      if (!setRes.ok) {
        sp.stop("Failed", 1)
        const d = (await setRes.json().catch(() => ({}))) as any
        if (setRes.status === 404 && (d?.error || "").includes("No active")) {
          prompts.log.error(`No active ${type} channel on bloq ${bloqId}. Connect it first:`)
          console.log(`    ${highlight(`iris channels connect ${type} --bloq-id ${bloqId}`)}`)
        } else {
          prompts.log.error(d?.error || d?.message || (setRes.status === 404 ? `Bloq ${bloqId} not found (or not yours)` : `HTTP ${setRes.status}`))
        }
        prompts.outro("Done")
        return
      }
      sp.stop(success("Set"))
      prompts.log.success(`${type} announcements → ${channelId}`)
      prompts.outro(`${success("✓")} Now run: ${highlight(`iris announce "your update" --bloq-id ${bloqId}`)}`)
    } catch (e) {
      sp.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})

const AnnounceTargetGetCommand = cmd({
  command: "get",
  describe: "show the announce target for each connected channel",
  builder: (yargs) => yargs.option("bloq-id", { type: "number", demandOption: true, describe: "bloq to inspect" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Announce Targets")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const bloqId = args["bloq-id"] as number
    const sp = prompts.spinner()
    sp.start("Loading…")
    try {
      const res = await irisFetch(`/api/v6/bloqs/${bloqId}/announce-targets`, {}, PLATFORM_URLS.irisApi)
      if (!res.ok) {
        sp.stop("Failed", 1)
        prompts.log.error(res.status === 404 ? `Bloq ${bloqId} not found (or not yours)` : `HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }
      const data = (await res.json()) as { channels?: Array<{ channel_type: string; announce_channel_id: string | null }> }
      sp.stop("Loaded")
      const broadcast = data.channels ?? []
      if (!broadcast.length) {
        prompts.log.info(`No Slack/Discord channels on bloq ${bloqId}`)
        prompts.outro("Done")
        return
      }
      console.log()
      for (const c of broadcast) {
        console.log(`  ${bold(c.channel_type)}  ${c.announce_channel_id ? success(c.announce_channel_id) : dim("(no target set)")}`)
      }
      console.log()
      prompts.outro("Done")
    } catch (e) {
      sp.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})

const ChannelsAnnounceTargetCommand = cmd({
  command: "announce-target <action>",
  describe: "set or view which channel receives announcements",
  builder: (yargs) =>
    yargs
      .command(AnnounceTargetSetCommand)
      .command(AnnounceTargetGetCommand)
      .demandCommand(1, "Use: announce-target set <type> --bloq-id N --channel <id>  |  announce-target get --bloq-id N"),
  async handler() {},
})

// ─── Main Command ────────────────────────────────────────────────

export const PlatformChannelsCommand = cmd({
  command: "channels",
  describe: "manage messaging channels — connect Discord, Slack, Telegram, iMessage",
  builder: (yargs) =>
    yargs
      .command(ChannelsListCommand)
      .command(ChannelsConnectCommand)
      .command(ChannelsDisconnectCommand)
      .command(ChannelsStatusCommand)
      .command(ChannelsAnnounceTargetCommand)
      .strict(false),
  async handler() {
    // Default: show list
    return ChannelsListCommand.handler({} as any)
  },
})
