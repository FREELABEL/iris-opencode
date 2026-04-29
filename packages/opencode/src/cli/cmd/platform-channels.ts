import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
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

    // OAuth flow (Discord, Slack, WhatsApp, Facebook)
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
  async handler() {
    UI.empty()
    prompts.intro("◈  Channel Health")

    const checks: { name: string; ok: boolean; detail: string }[] = []

    // Bridge health
    try {
      const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        const data = (await res.json()) as any
        checks.push({ name: "Bridge", ok: true, detail: `running on :3200` })

        const msg = data?.messaging ?? {}

        // Discord
        if (msg.discord?.status === "running") {
          const bots = msg.discord.bots ?? []
          const readyBots = bots.filter((b: any) => b.ready)
          checks.push({
            name: "Discord",
            ok: readyBots.length > 0,
            detail: `${readyBots.length}/${bots.length} bot(s) ready`,
          })
        } else {
          checks.push({ name: "Discord", ok: false, detail: "not connected" })
        }

        // iMessage
        if (msg.imessage?.running) {
          checks.push({
            name: "iMessage",
            ok: true,
            detail: `${msg.imessage.conversations} convos, ${msg.imessage.messages_processed} msgs`,
          })
        }

        // Telegram
        if (msg.telegram?.status === "running") {
          checks.push({ name: "Telegram", ok: true, detail: msg.telegram.username ?? "connected" })
        }
      } else {
        checks.push({ name: "Bridge", ok: false, detail: "not responding" })
      }
    } catch {
      checks.push({ name: "Bridge", ok: false, detail: "not running (start: iris bridge start)" })
    }

    // iris-api health
    try {
      const res = await fetch(`${PLATFORM_URLS.irisApi}/api/health`, {
        signal: AbortSignal.timeout(5000),
        headers: { Accept: "application/json" },
      })
      checks.push({
        name: "iris-api",
        ok: res.ok,
        detail: res.ok ? "healthy" : `HTTP ${res.status}`,
      })
    } catch {
      checks.push({ name: "iris-api", ok: false, detail: "unreachable" })
    }

    // Discord webhook endpoint
    try {
      const token = getBridgeToken()
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" }
      const bridgeSecret = process.env.DISCORD_BRIDGE_SECRET
      if (bridgeSecret) headers["X-Bridge-Secret"] = bridgeSecret

      const res = await fetch(`${PLATFORM_URLS.irisApi}/api/v6/channels/discord`, {
        method: "POST",
        headers,
        body: JSON.stringify({ t: "HEALTH_CHECK", d: { content: "", author: { id: "health", username: "health", bot: true } } }),
        signal: AbortSignal.timeout(5000),
      })
      checks.push({
        name: "Discord webhook",
        ok: res.ok,
        detail: res.ok ? "accepting requests" : `HTTP ${res.status}`,
      })
    } catch {
      checks.push({ name: "Discord webhook", ok: false, detail: "unreachable" })
    }

    // Display results
    printDivider()
    for (const c of checks) {
      const icon = c.ok ? success("✓") : "✗"
      console.log(`  ${icon} ${bold(c.name)}  ${dim(c.detail)}`)
    }
    printDivider()

    const allOk = checks.every((c) => c.ok)
    if (allOk) {
      prompts.log.success("All channels healthy")
    } else {
      const failed = checks.filter((c) => !c.ok)
      prompts.log.warn(`${failed.length} issue(s) found`)
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
      .strict(false),
  async handler() {
    // Default: show list
    return ChannelsListCommand.handler({} as any)
  },
})
