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

// Composio toolkits that use API key auth (use `iris integrations setup <type>-api-key --api-key <key>`)
const COMPOSIO_APIKEY_TOOLKITS: Record<string, string> = {
  cloudflare: "cloudflare_api_key",
  openai: "openai_api_key",
  anthropic: "anthropic_api_key",
  perplexity: "perplexity_api_key",
}

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

async function getComposioOAuthUrl(type: string): Promise<{ url: string | null; error: string | null }> {
  const userId = await requireUserId()
  if (!userId) return { url: null, error: "Not authenticated" }
  const bases = [IRIS_API, "https://main.heyiris.io", "https://heyiris.io", "https://iris-api.freelabel.net"]
  let lastError: string | null = null
  for (const base of bases) {
    try {
      const res = await irisFetch(
        `/api/v1/integrations-temp/oauth-url/${type}?user_id=${userId}`,
        {},
        base,
      )
      const data = await res.json().catch(() => ({})) as any
      if (res.ok) {
        const url = data?.data?.oauth_url ?? data?.oauth_url ?? data?.url
        if (url) return { url, error: null }
      } else {
        lastError = data?.error ?? data?.message ?? `HTTP ${res.status}`
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }
  return { url: null, error: lastError }
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

    const composioResult = await getComposioOAuthUrl(type)
    let url = composioResult.url
    let composioError = composioResult.error

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

      // Detect API-key toolkits and route the user to the right command
      const apiKeyToolkit = COMPOSIO_APIKEY_TOOLKITS[type]
      if (apiKeyToolkit) {
        prompts.log.warn(`${type} uses API key authentication, not OAuth.`)
        console.log()
        console.log(`  ${bold("Step 1:")} Get your API key`)
        const hints: Record<string, string> = {
          cloudflare: "https://dash.cloudflare.com/profile/api-tokens",
          openai: "https://platform.openai.com/api-keys",
          anthropic: "https://console.anthropic.com/settings/keys",
          perplexity: "https://www.perplexity.ai/settings/api",
        }
        if (hints[type]) console.log(`  ${highlight(hints[type])}`)
        console.log()
        console.log(`  ${bold("Step 2:")} Create the auth config`)
        console.log(`  ${highlight(`iris integrations setup ${apiKeyToolkit} --api-key <your-key>`)}`)
        console.log()
        console.log(`  ${bold("Step 3:")} Connect your account`)
        console.log(`  ${highlight(`iris integrations connect-composio ${apiKeyToolkit}`)}`)
        prompts.outro("Done")
        return
      }

      // Detect "no auth_config" errors and surface the actual setup command
      if (composioError && /auth.?config|integration.*not.*found/i.test(composioError)) {
        prompts.log.error(`No Composio auth config exists for ${type}.`)
        console.log()
        console.log(`  ${dim("Composio error:")} ${composioError}`)
        console.log()
        console.log(`  ${bold("Fix:")} An admin needs to register OAuth credentials for ${type} with Composio first.`)
        console.log(`  ${dim("Or, if this is an API-key integration, run:")}`)
        console.log(`  ${highlight(`iris integrations setup ${type} --api-key <key>`)}`)
        prompts.outro("Done")
        return
      }

      prompts.log.error(`Could not generate OAuth URL for ${type}.`)
      if (composioError) {
        console.log(`  ${dim("Reason:")} ${composioError}`)
      } else {
        prompts.log.info("OAuth client credentials may not be configured for this provider.")
      }
      console.log()
      console.log(`  ${dim("Try:")} ${highlight("iris integrations list")} to see available integrations.`)
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

const COMPOSIO_KEY = process.env.COMPOSIO_API_KEY ?? "ak_c2m5Q0Av7lOHYK9NPTCn"
const COMPOSIO_BASE = "https://backend.composio.dev/api"

async function composioFetch(path: string, init?: RequestInit) {
  return fetch(`${COMPOSIO_BASE}${path}`, {
    ...init,
    headers: {
      "x-api-key": COMPOSIO_KEY,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  })
}

const SetupCommand = cmd({
  command: "setup <toolkit>",
  describe: "create a Composio v3 auth_config (calls Composio API directly)",
  builder: (y) =>
    y
      .positional("toolkit", { type: "string", demandOption: true, describe: "Composio toolkit slug (e.g., cloudflare_api_key)" })
      .option("api-key", { type: "string", describe: "API key for API_KEY toolkits" })
      .option("managed", { type: "boolean", default: false, describe: "use Composio-managed credentials" })
      .option("auth-scheme", { type: "string", default: "API_KEY" })
      .option("name", { type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Setup: ${args.toolkit}`)

    const toolkit = String(args.toolkit)
    const managed = !!args.managed
    const authScheme = String(args["auth-scheme"] ?? "API_KEY")
    const apiKey = args["api-key"] ? String(args["api-key"]) : null

    if (!managed && !apiKey && authScheme === "API_KEY") {
      prompts.log.error("API_KEY toolkits need --api-key <key> or --managed")
      prompts.outro("Done")
      return
    }

    const body = {
      toolkit: { slug: toolkit },
      auth_config: {
        name: args.name ? String(args.name) : `${toolkit}-config`,
        type: managed ? "use_composio_managed_auth" : "use_custom_auth",
        authScheme,
        credentials: apiKey ? { api_key: apiKey } : {},
      },
    }

    const spinner = prompts.spinner()
    spinner.start("POST /v3/auth_configs…")
    try {
      const res = await composioFetch("/v3/auth_configs", {
        method: "POST",
        body: JSON.stringify(body),
      })
      const text = await res.text()
      let data: any = {}
      try { data = JSON.parse(text) } catch {}

      if (!res.ok) {
        spinner.stop("Failed", 1)
        prompts.log.error(`HTTP ${res.status}`)
        console.log(text)
        prompts.outro("Done")
        return
      }

      const ac = data.auth_config ?? data
      const id = ac?.id ?? data?.id
      spinner.stop("Auth config created")
      console.log()
      console.log(`  ${bold("Toolkit:")}        ${highlight(toolkit)}`)
      console.log(`  ${bold("Auth config ID:")} ${highlight(id ?? "?")}`)
      console.log(`  ${bold("Auth scheme:")}    ${authScheme}`)
      console.log(`  ${bold("Managed:")}        ${managed}`)
      console.log()
      console.log(`  ${bold("Next:")} ${highlight(`iris integrations connect-composio ${toolkit} --auth-config ${id}`)}`)
      prompts.outro("Done")
    } catch (e) {
      spinner.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})

const ConnectComposioCommand = cmd({
  command: "connect-composio <toolkit>",
  describe: "create a Composio v3 connected_account (calls Composio API directly)",
  builder: (y) =>
    y
      .positional("toolkit", { type: "string", demandOption: true })
      .option("auth-config", { type: "string", describe: "auth_config id (ac_xxx); auto-discovered if omitted" })
      .option("user-id", { type: "string", describe: "entity/user id (defaults to local user)" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Connect: ${args.toolkit}`)

    const toolkit = String(args.toolkit)
    let authConfigId = args["auth-config"] ? String(args["auth-config"]) : null
    const userId = args["user-id"] ? String(args["user-id"]) : `user-${(await requireUserId().catch(() => 0)) || "local"}`

    const spinner = prompts.spinner()

    // Auto-discover auth_config if not provided
    if (!authConfigId) {
      spinner.start("Looking up auth_config…")
      try {
        const res = await composioFetch(`/v3/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}`)
        const data = (await res.json()) as any
        const items = data.items ?? data.data ?? []
        if (items.length === 0) {
          spinner.stop("None found", 1)
          prompts.log.error(`No auth_config for ${toolkit}. Run: iris integrations setup ${toolkit} --api-key <key>`)
          prompts.outro("Done")
          return
        }
        authConfigId = items[0].id
        spinner.stop(`Found ${authConfigId}`)
      } catch (e) {
        spinner.stop("Failed", 1)
        prompts.log.error(e instanceof Error ? e.message : String(e))
        prompts.outro("Done")
        return
      }
    }

    spinner.start("POST /v3/connected_accounts…")
    try {
      const res = await composioFetch("/v3/connected_accounts", {
        method: "POST",
        body: JSON.stringify({
          auth_config: { id: authConfigId },
          connection: { user_id: userId },
        }),
      })
      const text = await res.text()
      let data: any = {}
      try { data = JSON.parse(text) } catch {}

      if (!res.ok) {
        spinner.stop("Failed", 1)
        prompts.log.error(`HTTP ${res.status}`)
        console.log(text)
        prompts.outro("Done")
        return
      }

      const cid = data.id ?? data.connected_account_id
      const url = data.redirect_url ?? data.redirectUrl ?? data.connectionData?.redirectUrl
      const status = data.status ?? data.connectionData?.status

      spinner.stop("Connected account created")
      console.log()
      console.log(`  ${bold("Connected account:")} ${highlight(cid ?? "?")}`)
      console.log(`  ${bold("Status:")}            ${status ?? "?"}`)
      if (url) {
        console.log()
        console.log(`  ${bold("Authorize:")} ${highlight(url)}`)
        openBrowser(url)
        console.log(`  ${dim("(Opened in browser)")}`)
      } else {
        console.log()
        console.log(`  ${dim("API_KEY toolkit — connection is active immediately, no redirect needed.")}`)
      }
      prompts.outro("Done")
    } catch (e) {
      spinner.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})

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
      .command(SetupCommand)
      .command(ConnectComposioCommand)
      .demandCommand(),
  async handler() {},
})

// Top-level shortcuts so AI agents and users can find these without nesting
export const PlatformConnectCommand = cmd({
  command: "connect <type>",
  describe: "connect an integration via OAuth or API key (alias for `integrations connect`)",
  builder: (yargs) =>
    yargs.positional("type", {
      describe: "integration type (e.g., google-docs, canva, apollo)",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    return ConnectCommand.handler(args as any)
  },
})

export const PlatformListConnectedCommand = cmd({
  command: "list-connected",
  aliases: ["connections"],
  describe: "show your connected integrations (alias for `integrations list-connected`)",
  async handler(args) {
    return ListConnectedCommand.handler(args as any)
  },
})

export const PlatformListAvailableCommand = cmd({
  command: "list-available",
  describe: "show all available integrations + connection status",
  async handler(args) {
    return ListAvailableCommand.handler(args as any)
  },
})
