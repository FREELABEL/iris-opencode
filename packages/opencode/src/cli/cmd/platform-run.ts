import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  requireUserId,
  handleApiError,
  printDivider,
  dim,
  bold,
  success,
  highlight,
  IRIS_API,
} from "./iris-api"
import { exec } from "child_process"

// ============================================================================
// Known integration types — anything else routes to V6 system tools.
// ============================================================================

const INTEGRATION_TYPES = [
  "atlas-os", "beatbox-showcase", "buffer", "copycat-ai", "fal-ai",
  "fl-api", "genesis", "github-copilot", "gmail", "google-calendar",
  "google-drive", "google-gemini", "macos", "savelife-ai", "servis-ai",
  "slack", "vagaro", "vapi", "whatsapp", "workflow-composer",
]

const OAUTH_TYPES = ["google-drive", "google-calendar", "gmail", "slack", "github", "mailchimp"]
const APIKEY_TYPES = ["vapi", "servis-ai", "smtp-email", "mailjet", "google-gemini", "savelife-ai"]

function isIntegration(t: string): boolean {
  return INTEGRATION_TYPES.includes(t.toLowerCase())
}

// ============================================================================
// Param parsing — key=value pairs into typed object
// ============================================================================

function parseParams(raw: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of raw) {
    if (!p.includes("=")) continue
    const eq = p.indexOf("=")
    const key = p.slice(0, eq)
    let val: unknown = p.slice(eq + 1).replace(/^["']|["']$/g, "")
    if (typeof val === "string") {
      if (/^-?\d+$/.test(val)) val = parseInt(val, 10)
      else if (/^-?\d*\.\d+$/.test(val)) val = parseFloat(val)
      else if (val === "true") val = true
      else if (val === "false") val = false
    }
    out[key] = val
  }
  return out
}

// ============================================================================
// Integration execute (routes through fl-api execute-direct)
// ============================================================================

export async function executeIntegrationCall(
  type: string,
  fn: string,
  params: Record<string, unknown>,
): Promise<any> {
  const userId = await requireUserId()
  if (!userId) throw new Error("user_id required")
  const res = await irisFetch(
    `/api/v1/users/${userId}/integrations/execute-direct?user_id=${userId}`,
    {
      method: "POST",
      body: JSON.stringify({ integration: type, action: fn, params }),
    },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  return await res.json()
}

function displayResult(result: any, name: string): void {
  const ok = result?.success ?? !result?.error
  if (!ok) {
    prompts.log.error(result?.error ?? "Execution failed")
    return
  }
  console.log(`  ${success("✓")} ${bold(name)} completed`)
  for (const [k, v] of Object.entries(result ?? {})) {
    if (k === "success" || k === "status") continue
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      console.log(`  ${dim(k + ":")} ${v}`)
    } else if (Array.isArray(v) || typeof v === "object") {
      const enc = JSON.stringify(v, null, 2)
      if (enc.length < 500) console.log(`  ${dim(k + ":")} ${enc}`)
      else console.log(`  ${dim(k + ":")} [${Array.isArray(v) ? v.length + " items" : "object"}]`)
    }
  }
}

// ============================================================================
// Composio OAuth URL via iris-api
// ============================================================================

async function getComposioOAuthUrl(type: string): Promise<string | null> {
  const userId = await requireUserId()
  if (!userId) return null
  const bases = [IRIS_API, "https://main.heyiris.io", "https://heyiris.io", "https://iris-api.freelabel.net"]
  for (const base of bases) {
    try {
      const res = await irisFetch(
        `/api/v1/integrations-temp/oauth-url/${type}?user_id=${userId}`,
        {},
        base,
      )
      if (res.ok) {
        const data = (await res.json()) as any
        const url = data?.data?.oauth_url ?? data?.oauth_url ?? data?.url
        if (url) return url
      }
    } catch {}
  }
  return null
}

function openBrowser(url: string): void {
  const opener =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" :
    "xdg-open"
  exec(`${opener} "${url.replace(/"/g, '\\"')}"`, () => {})
}

// ============================================================================
// Subcommands
// ============================================================================

const ListToolsCommand = cmd({
  command: "list-tools",
  describe: "list V6 system tools",
  builder: (y) => y.option("json", { type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  V6 System Tools")
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    try {
      const res = await irisFetch("/api/v1/v6/tools/registry")
      if (!res.ok) {
        prompts.log.warn(`Could not fetch registry: HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }
      const data = (await res.json()) as any
      if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }
      printDivider()
      for (const t of data?.tools ?? data?.data ?? []) {
        const healthy = t.healthy ? success("ok") : dim("?")
        console.log(`  ${highlight(t.name ?? "?")} [${healthy}]`)
      }
      printDivider()
      prompts.outro(dim("iris integrations <tool> key=value …"))
    } catch (e) {
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})

const ListIntegrationsCommand = cmd({
  command: "list-integrations",
  describe: "list known integration types",
  async handler() {
    UI.empty()
    prompts.intro("◈  Available Integrations")
    printDivider()
    for (const t of INTEGRATION_TYPES) console.log(`  ${highlight(t)}`)
    printDivider()
    prompts.outro(dim("iris integrations <type> <function> key=value …"))
  },
})

const ListConnectedCommand = cmd({
  command: "list-connected",
  describe: "show your connected integrations",
  builder: (y) => y.option("json", { type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Connected Integrations")
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const userId = await requireUserId()
    if (!userId) { prompts.outro("Done"); return }
    try {
      const res = await irisFetch(`/api/v1/users/${userId}/integrations`)
      const ok = await handleApiError(res, "List integrations")
      if (!ok) { prompts.outro("Done"); return }
      const data = (await res.json()) as any
      const items: any[] = data?.data ?? data ?? []
      if (args.json) { console.log(JSON.stringify(items, null, 2)); prompts.outro("Done"); return }
      if (items.length === 0) {
        prompts.log.warn("No integrations connected.")
        prompts.outro(dim("iris integrations list-available"))
        return
      }
      printDivider()
      for (const i of items) {
        console.log(`  ${highlight(i.type ?? i.name ?? "?")}  ${dim("[" + (i.status ?? "active") + "]")}  ${dim("#" + i.id)}`)
      }
      printDivider()
      prompts.outro(dim("iris integrations <type> <function> key=value …"))
    } catch (e) {
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})

const ListAvailableCommand = cmd({
  command: "list-available",
  describe: "all available integrations + connection status",
  async handler() {
    UI.empty()
    prompts.intro("◈  Available Integrations")
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const userId = await requireUserId()
    const connected = new Set<string>()
    try {
      const res = await irisFetch(`/api/v1/users/${userId}/integrations`)
      if (res.ok) {
        const data = (await res.json()) as any
        for (const i of data?.data ?? data ?? []) {
          if (i.type) connected.add(String(i.type).toLowerCase())
        }
      }
    } catch {}
    printDivider()
    for (const t of INTEGRATION_TYPES) {
      const status = connected.has(t) ? success("connected") : dim("not connected")
      console.log(`  ${highlight(t)}  ${status}`)
    }
    printDivider()
    prompts.outro(dim("iris integrations connect <type>"))
  },
})

const ConnectCommand = cmd({
  command: "connect <type>",
  describe: "start OAuth or show API-key instructions for an integration",
  builder: (y) =>
    y.positional("type", { type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Connect: ${args.type}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const type = String(args.type)

    if (APIKEY_TYPES.includes(type)) {
      const hints: Record<string, string> = {
        vapi: "https://dashboard.vapi.ai",
        "servis-ai": "https://freeagent.network",
        openai: "https://platform.openai.com/api-keys",
      }
      console.log(`  ${type} uses API key authentication.`)
      if (hints[type]) console.log(`  Get credentials: ${highlight(hints[type])}`)
      console.log(`  Run: ${highlight("iris integrations <type> ...")} once stored.`)
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Generating OAuth URL…")

    let url = await getComposioOAuthUrl(type)

    // Fallback to fl-api SDK route
    if (!url) {
      try {
        const userId = await requireUserId()
        const res = await irisFetch(`/api/v1/users/${userId}/integrations/oauth-url/${type}`)
        if (res.ok) {
          const data = (await res.json()) as any
          url = data?.url ?? data?.oauth_url ?? null
        }
      } catch {}
    }

    if (!url) {
      spinner.stop("Failed", 1)
      prompts.log.error(`Could not generate OAuth URL for ${type}.`)
      prompts.log.info("OAuth client credentials may not be configured for this provider.")
      prompts.outro("Done")
      return
    }

    spinner.stop("OAuth URL ready")
    console.log()
    console.log(`  ${bold("Step 1:")} Authorize in your browser`)
    console.log(`  ${highlight(url)}`)
    console.log()
    openBrowser(url)
    console.log(`  ${dim("(Opened in your default browser)")}`)
    console.log()
    console.log(`  ${bold("Step 2:")} After authorizing, check status with`)
    console.log(`  ${highlight("iris integrations list-connected")}`)
    prompts.outro("Done")
  },
})

const ExecCommand = cmd({
  command: "exec <target> [function] [params..]",
  aliases: ["call"],
  describe: "execute an integration function or system tool",
  builder: (y) =>
    y
      .positional("target", { type: "string", demandOption: true, describe: "integration type or tool name" })
      .positional("function", { type: "string", describe: "function (for integrations)" })
      .positional("params", { type: "string", array: true, default: [], describe: "key=value params" })
      .option("json", { type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Run: ${args.target}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const target = String(args.target)
    let fn = args.function ? String(args.function) : undefined
    const rawParams = (args.params as string[]) ?? []
    let params = parseParams(rawParams)

    try {
      if (isIntegration(target)) {
        if (!fn) {
          prompts.log.warn(`No function specified for ${target}.`)
          prompts.outro(dim(`iris integrations exec ${target} <function> key=value …`))
          return
        }
        const spinner = prompts.spinner()
        spinner.start(`Executing ${target}.${fn}…`)
        const result = await executeIntegrationCall(target, fn, params)
        spinner.stop(`${target}.${fn}`)
        if (args.json) console.log(JSON.stringify(result, null, 2))
        else displayResult(result, `${target}.${fn}`)
        prompts.outro("Done")
        return
      }

      // System tool path — function name might be a key=value
      if (fn && fn.includes("=")) {
        params = { ...parseParams([fn]), ...params }
        fn = undefined
      }

      const userId = await requireUserId()
      const spinner = prompts.spinner()
      spinner.start(`Executing tool ${target}…`)
      const res = await irisFetch(`/api/v1/v6/tools/execute`, {
        method: "POST",
        body: JSON.stringify({ tool: target, params, user_id: userId }),
      })
      if (!res.ok) {
        spinner.stop("Failed", 1)
        prompts.log.error(`HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }
      const result = await res.json()
      spinner.stop(target)
      if (args.json) console.log(JSON.stringify(result, null, 2))
      else displayResult(result, target)
      prompts.outro("Done")
    } catch (e) {
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Root command — `iris integrations …`
// (Top-level `run` is taken by opencode's RunCommand, so we use `integrations`.)
// ============================================================================

export const PlatformRunCommand = cmd({
  command: "integrations",
  aliases: ["int"],
  describe: "execute integration functions, V6 system tools, OAuth connect",
  builder: (yargs) =>
    yargs
      .command(ExecCommand)
      .command(ListToolsCommand)
      .command(ListIntegrationsCommand)
      .command(ListConnectedCommand)
      .command(ListAvailableCommand)
      .command(ConnectCommand)
      .demandCommand(),
  async handler() {},
})
