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

// Fetch a Composio auth_config and build the connection.state.val payload
// using its expected_input_fields. Composio v3 requires credentials on the
// connected_account in the exact field shape declared by the auth_config.
async function buildComposioConnectionState(
  authConfigId: string,
  apiKey?: string | null,
): Promise<{ authScheme: string; val: Record<string, string> } | null> {
  try {
    const res = await composioFetch(`/v3/auth_configs/${authConfigId}`)
    if (!res.ok) return null
    const ac = (await res.json()) as any
    const fields: any[] = ac?.expected_input_fields ?? ac?.deprecated_params?.expected_input_fields ?? []
    const scheme = ac?.auth_scheme ?? "API_KEY"
    // Use provided key, falling back to whatever is stored on the auth_config
    const key = apiKey ?? ac?.credentials?.api_key ?? ac?.credentials?.generic_api_key ?? null
    if (!key) return null
    const val: Record<string, string> = {}
    if (fields.length > 0) {
      // Populate every required string field with the same key
      for (const f of fields) {
        if (f?.required && f?.type === "string") val[f.name] = String(key)
      }
      if (Object.keys(val).length === 0) val[fields[0].name] = String(key)
    } else {
      val.generic_api_key = String(key)
    }
    return { authScheme: scheme, val }
  } catch {
    return null
  }
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

    // Source 1: fl-api local integrations table
    const flItems: any[] = []
    try {
      const res = await irisFetch(`/api/v1/users/${userId}/integrations`)
      if (res.ok) {
        const data = (await res.json()) as any
        for (const i of (data?.data ?? data ?? [])) flItems.push(i)
      }
    } catch {}

    // Source 2: Composio connected_accounts (source of truth for OAuth)
    const composioItems: any[] = []
    try {
      const cRes = await composioFetch(`/v3/connected_accounts?user_ids=user-${userId}`)
      if (cRes.ok) {
        const cData = (await cRes.json()) as any
        for (const c of (cData?.items ?? cData?.data ?? [])) composioItems.push(c)
      }
    } catch {}

    // Merge by toolkit slug — Composio takes precedence (it's the source of truth)
    const merged = new Map<string, any>()
    for (const i of flItems) {
      const key = String(i.type ?? i.name ?? "?").toLowerCase()
      merged.set(key, { source: "fl-api", type: key, status: i.status ?? "active", id: i.id })
    }
    for (const c of composioItems) {
      const key = String(c?.toolkit?.slug ?? "?").toLowerCase()
      merged.set(key, {
        source: "oauth",
        type: key,
        status: String(c.status ?? "?").toLowerCase(),
        id: c.id,
        auth_scheme: c.authScheme ?? c.auth_scheme,
      })
    }
    const items = Array.from(merged.values())

    if (args.json) {
      console.log(JSON.stringify(items, null, 2))
      prompts.outro("Done")
      return
    }

    if (items.length === 0) {
      prompts.log.warn("No integrations connected.")
      prompts.outro(dim("iris integrations list-available"))
      return
    }

    printDivider()
    for (const i of items) {
      const statusColor = i.status === "active" ? success(`[${i.status}]`) : dim(`[${i.status}]`)
      console.log(`  ${highlight(i.type)}  ${statusColor}`)
    }
    printDivider()
    prompts.outro(dim("iris integrations <type> <function> key=value …"))
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
    y
      .positional("type", { type: "string", demandOption: true })
      .option("print-url", { type: "boolean", default: false, describe: "print the OAuth URL instead of opening a browser" }),
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
      // API-key toolkit: prompt inline for the user's key, then create
      // auth_config + connected_account in one shot. No 3-step dump.
      const apiKeyToolkit = COMPOSIO_APIKEY_TOOLKITS[type]
      if (apiKeyToolkit) {
        spinner.stop("API key required")
      } else {
        spinner.stop("Failed", 1)
      }
      if (apiKeyToolkit) {
        const hints: Record<string, string> = {
          cloudflare: "https://dash.cloudflare.com/profile/api-tokens",
          openai: "https://platform.openai.com/api-keys",
          anthropic: "https://console.anthropic.com/settings/keys",
          perplexity: "https://www.perplexity.ai/settings/api",
        }
        console.log()
        console.log(`  ${dim(`Get your ${type} API key:`)} ${highlight(hints[type] ?? "")}`)
        console.log()

        const apiKey = await prompts.password({
          message: `Paste your ${type} API key:`,
          mask: "•",
        })
        if (prompts.isCancel(apiKey) || !apiKey) {
          prompts.outro("Cancelled")
          return
        }

        const sp2 = prompts.spinner()
        sp2.start("Creating auth config…")
        try {
          // 1. Create auth_config with the user's key
          const acRes = await composioFetch("/v3/auth_configs", {
            method: "POST",
            body: JSON.stringify({
              toolkit: { slug: apiKeyToolkit },
              auth_config: {
                name: `${apiKeyToolkit}-${Date.now()}`,
                type: "use_custom_auth",
                authScheme: "API_KEY",
                credentials: { api_key: String(apiKey) },
              },
            }),
          })
          const acText = await acRes.text()
          let acData: any = {}
          try { acData = JSON.parse(acText) } catch {}
          if (!acRes.ok) {
            sp2.stop("Failed", 1)
            prompts.log.error(`Auth config creation failed (HTTP ${acRes.status})`)
            console.log(dim(acText.slice(0, 400)))
            prompts.outro("Done")
            return
          }
          const authConfigId = acData?.auth_config?.id ?? acData?.id
          if (!authConfigId) {
            sp2.stop("Failed", 1)
            prompts.log.error("Integration provider returned no auth config id")
            prompts.outro("Done")
            return
          }

          // 2. Create connected_account for this user — credentials must
          // be passed in connection.state.val using the field names from
          // the auth_config's expected_input_fields.
          sp2.message("Connecting account…")
          const userId = `user-${(await requireUserId().catch(() => 0)) || "local"}`
          const state = await buildComposioConnectionState(authConfigId, String(apiKey))
          const caRes = await composioFetch("/v3/connected_accounts", {
            method: "POST",
            body: JSON.stringify({
              auth_config: { id: authConfigId },
              connection: state ? { user_id: userId, state } : { user_id: userId },
            }),
          })
          const caText = await caRes.text()
          let caData: any = {}
          try { caData = JSON.parse(caText) } catch {}
          if (!caRes.ok) {
            sp2.stop("Failed", 1)
            prompts.log.error(`Connection failed (HTTP ${caRes.status})`)
            console.log(dim(caText.slice(0, 400)))
            prompts.outro("Done")
            return
          }

          sp2.stop("Connected")
          console.log()
          console.log(`  ${success("✓")} ${type} is now connected.`)
          console.log(`  ${dim("Connected account:")} ${caData?.id ?? caData?.connected_account_id ?? "?"}`)
          prompts.outro("Done")
          return
        } catch (e) {
          sp2.stop("Failed", 1)
          prompts.log.error(e instanceof Error ? e.message : String(e))
          prompts.outro("Done")
          return
        }
      }

      // Detect "no auth_config" errors and surface the actual setup command
      if (composioError && /auth.?config|integration.*not.*found/i.test(composioError)) {
        prompts.log.error(`${type} is not yet configured.`)
        console.log()
        console.log(`  ${bold("Fix:")} An admin needs to register OAuth credentials for ${type}.`)
        console.log(`  ${dim("Or, if this is an API-key integration, run:")}`)
        console.log(`  ${highlight(`iris integrations setup ${type} --api-key <key>`)}`)
        prompts.outro("Done")
        return
      }

      prompts.log.error(`Could not generate OAuth URL for ${type}.`)
      if (composioError) {
        // Sanitize provider names from error messages before showing to users
        const sanitized = String(composioError)
          .replace(/composio/gi, "integration provider")
          .replace(/backend\.composio\.dev/gi, "iris.freelabel.net")
        console.log(`  ${dim("Reason:")} ${sanitized}`)
      } else {
        prompts.log.info("OAuth credentials may not be configured for this provider.")
      }
      console.log()
      console.log(`  ${dim("Try:")} ${highlight("iris integrations list")} to see available integrations.`)
      prompts.outro("Done")
      return
    }

    spinner.stop("Ready")
    console.log()
    if (args["print-url"]) {
      console.log(`  ${dim("Authorize at:")} ${url}`)
    } else {
      console.log(`  ${success("→")} Opening ${highlight(type)} in your browser to authorize…`)
      openBrowser(url)
    }
    console.log()
    if (!args["print-url"]) {
      console.log(`  ${dim("If the browser didn't open, run:")} ${dim(`iris integrations connect ${type} --print-url`)}`)
      console.log()
    }
    console.log(`  ${dim("After authorizing, verify with:")} ${highlight("iris integrations list-connected")}`)
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
  describe: "register an integration's API key (one-time per workspace)",
  builder: (y) =>
    y
      .positional("toolkit", { type: "string", demandOption: true, describe: "integration toolkit slug (e.g., cloudflare_api_key)" })
      .option("api-key", { type: "string", describe: "API key for API_KEY toolkits" })
      .option("managed", { type: "boolean", default: false, describe: "use platform-managed credentials" })
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
    spinner.start("Registering credentials…")
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
        const sanitized = text.replace(/composio/gi, "integration provider")
          .replace(/backend\.composio\.dev/gi, "iris.freelabel.net")
        console.log(sanitized)
        prompts.outro("Done")
        return
      }

      const ac = data.auth_config ?? data
      const id = ac?.id ?? data?.id
      spinner.stop("Credentials registered")
      console.log()
      console.log(`  ${bold("Toolkit:")}      ${highlight(toolkit)}`)
      console.log(`  ${bold("Auth scheme:")}  ${authScheme}`)
      console.log()
      console.log(`  ${bold("Next:")} ${highlight(`iris integrations connect-direct ${toolkit}`)}`)
      prompts.outro("Done")
    } catch (e) {
      spinner.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})

const ConnectComposioCommand = cmd({
  command: "connect-direct <toolkit>",
  aliases: ["connect-composio"],
  describe: "connect an integration using a registered API key (after `setup`)",
  builder: (y) =>
    y
      .positional("toolkit", { type: "string", demandOption: true })
      .option("auth-config", { type: "string", describe: "auth config id (ac_xxx); auto-discovered if omitted" })
      .option("user-id", { type: "string", describe: "user id (defaults to local user)" }),
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
      // Read expected_input_fields from the auth_config so credentials are
      // submitted in the exact shape Composio requires (e.g. generic_api_key).
      const state = await buildComposioConnectionState(authConfigId!)
      const res = await composioFetch("/v3/connected_accounts", {
        method: "POST",
        body: JSON.stringify({
          auth_config: { id: authConfigId },
          connection: state ? { user_id: userId, state } : { user_id: userId },
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
