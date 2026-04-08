import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  requireUserId,
  dim,
  bold,
  success,
  highlight,
  printDivider,
  printKV,
  FL_API,
  IRIS_API,
} from "./iris-api"
import { homedir } from "os"
import { join } from "path"
import { existsSync, readFileSync } from "fs"

// ============================================================================
// SDK env reader
//
// Mirrors the readSdkEnv() helper baked into iris-api.ts so this command can
// surface every key the CLI knows about (api key, user id, FL/IRIS URLs).
// We deliberately keep it local instead of exporting from iris-api so we can
// scrub secrets at the display layer without affecting auth flow.
// ============================================================================

function readSdkEnvSync(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const envPath = join(homedir(), ".iris", "sdk", ".env")
    if (!existsSync(envPath)) return out
    const text = readFileSync(envPath, "utf-8")
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq > 0) {
        out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
      }
    }
  } catch {}
  return out
}

function maskSecret(value: string | undefined): string {
  if (!value) return dim("(unset)")
  if (value.length <= 8) return "***"
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

interface ResolvedConfig {
  environment: string
  apiKey: string | undefined
  apiKeySource: string
  userId: string | undefined
  userIdSource: string
  flApi: string
  flApiSource: string
  irisApi: string
  irisApiSource: string
}

function resolveConfig(): ResolvedConfig {
  const sdkEnv = readSdkEnvSync()

  // API key — Auth.get("iris") happens at runtime in iris-api but for `config`
  // we only show the env-file / process-env paths since the keychain may not
  // be readable here. Andrew's case is always env-file or env-var.
  let apiKey: string | undefined
  let apiKeySource = "(unset)"
  if (process.env.IRIS_API_KEY) {
    apiKey = process.env.IRIS_API_KEY
    apiKeySource = "env: IRIS_API_KEY"
  } else if (sdkEnv["IRIS_API_KEY"]) {
    apiKey = sdkEnv["IRIS_API_KEY"]
    apiKeySource = "~/.iris/sdk/.env"
  } else if (sdkEnv["IRIS_LOCAL_API_KEY"]) {
    apiKey = sdkEnv["IRIS_LOCAL_API_KEY"]
    apiKeySource = "~/.iris/sdk/.env (local)"
  }

  let userId: string | undefined
  let userIdSource = "(unset)"
  if (process.env.IRIS_USER_ID) {
    userId = process.env.IRIS_USER_ID
    userIdSource = "env: IRIS_USER_ID"
  } else if (sdkEnv["IRIS_USER_ID"]) {
    userId = sdkEnv["IRIS_USER_ID"]
    userIdSource = "~/.iris/sdk/.env"
  }

  let flApi = FL_API
  let flApiSource = "default"
  if (process.env.IRIS_FL_API_URL) {
    flApi = process.env.IRIS_FL_API_URL
    flApiSource = "env: IRIS_FL_API_URL"
  } else if (sdkEnv["FL_API_URL"]) {
    flApi = sdkEnv["FL_API_URL"]
    flApiSource = "~/.iris/sdk/.env"
  } else if (sdkEnv["FL_API_LOCAL_URL"]) {
    flApi = sdkEnv["FL_API_LOCAL_URL"]
    flApiSource = "~/.iris/sdk/.env (local)"
  }

  let irisApi = IRIS_API
  let irisApiSource = "default"
  if (process.env.IRIS_API_URL) {
    irisApi = process.env.IRIS_API_URL
    irisApiSource = "env: IRIS_API_URL"
  } else if (sdkEnv["IRIS_API_URL"]) {
    irisApi = sdkEnv["IRIS_API_URL"]
    irisApiSource = "~/.iris/sdk/.env"
  } else if (sdkEnv["IRIS_LOCAL_URL"]) {
    irisApi = sdkEnv["IRIS_LOCAL_URL"]
    irisApiSource = "~/.iris/sdk/.env (local)"
  }

  // Detect environment
  const environment =
    sdkEnv["IRIS_ENV"] ??
    process.env.IRIS_ENV ??
    (flApi.includes("local") ? "local" : "production")

  return {
    environment,
    apiKey,
    apiKeySource,
    userId,
    userIdSource,
    flApi,
    flApiSource,
    irisApi,
    irisApiSource,
  }
}

function hasMinimumCredentials(c: ResolvedConfig): boolean {
  return Boolean(c.apiKey && c.userId)
}

// ============================================================================
// Subcommands
// ============================================================================

const ShowCommand = cmd({
  command: "show",
  aliases: ["status"],
  describe: "show current SDK configuration (loaded from .env / env vars)",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const config = resolveConfig()

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            environment: config.environment,
            api_key: maskSecret(config.apiKey),
            api_key_source: config.apiKeySource,
            user_id: config.userId ?? null,
            user_id_source: config.userIdSource,
            fl_api: config.flApi,
            fl_api_source: config.flApiSource,
            iris_api: config.irisApi,
            iris_api_source: config.irisApiSource,
            ready: hasMinimumCredentials(config),
          },
          null,
          2,
        ),
      )
      return
    }

    UI.empty()
    prompts.intro("◈  IRIS SDK Configuration")

    const envColor = config.environment === "production" ? UI.Style.TEXT_DANGER : UI.Style.TEXT_SUCCESS
    console.log(`  ${envColor}Environment: ${config.environment}${UI.Style.TEXT_NORMAL}`)
    console.log(`  ${dim("Loaded from ~/.iris/sdk/.env + process env")}`)
    console.log()

    printDivider()
    printKV("API Key", `${maskSecret(config.apiKey)}  ${dim("(" + config.apiKeySource + ")")}`)
    printKV("User ID", `${config.userId ?? dim("(unset)")}  ${dim("(" + config.userIdSource + ")")}`)
    printKV("FL API", `${config.flApi}  ${dim("(" + config.flApiSource + ")")}`)
    printKV("IRIS API", `${config.irisApi}  ${dim("(" + config.irisApiSource + ")")}`)
    printDivider()

    if (hasMinimumCredentials(config)) {
      console.log(`  ${success("✓")} ${bold("SDK is ready to use")}`)
      console.log(`  ${dim("Test:  iris config test")}`)
    } else {
      console.log(`  ${UI.Style.TEXT_DANGER}✗ SDK is not configured${UI.Style.TEXT_NORMAL}`)
      console.log()
      console.log(`  ${dim("Quick setup:")}`)
      console.log(`  ${dim("  1. Run:  iris auth login")}`)
      console.log(`  ${dim("  2. Or set env vars:  IRIS_API_KEY, IRIS_USER_ID")}`)
    }

    prompts.outro("Done")
  },
})

const TestCommand = cmd({
  command: "test",
  describe: "test API connection with current credentials",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const config = resolveConfig()

    if (!hasMinimumCredentials(config)) {
      const msg = "SDK not configured — run `iris config show` to see what's missing"
      if (args.json) {
        console.log(JSON.stringify({ ok: false, error: msg }))
      } else {
        prompts.log.error(msg)
      }
      process.exitCode = 1
      return
    }

    if (!args.json) {
      UI.empty()
      prompts.intro("◈  Test API Connection")
      console.log(`  ${dim("Environment:")} ${config.environment}`)
      console.log(`  ${dim("FL API:")}      ${config.flApi}`)
      console.log(`  ${dim("User ID:")}     ${config.userId}`)
      console.log()
    }

    const token = await requireAuth()
    if (!token) {
      process.exitCode = 1
      return
    }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Pinging /api/v1/users/{id}/bloqs/agents…")

    try {
      const res = await irisFetch(`/api/v1/users/${config.userId}/bloqs/agents`)

      if (!res.ok) {
        const text = await res.text()
        if (args.json) {
          console.log(JSON.stringify({ ok: false, status: res.status, error: text.slice(0, 200) }))
        } else {
          spinner?.stop("Failed", 1)
          prompts.log.error(`API returned HTTP ${res.status}`)
          console.log(`  ${dim(text.slice(0, 200))}`)
          prompts.outro("Done")
        }
        process.exitCode = 1
        return
      }

      const data = (await res.json()) as { data?: unknown[] }
      const agentCount = Array.isArray(data?.data) ? data.data.length : 0

      if (args.json) {
        console.log(JSON.stringify({ ok: true, agents: agentCount, environment: config.environment }))
        return
      }

      spinner?.stop(`${success("✓")} API connection successful`)
      printDivider()
      printKV("Agents", agentCount)
      printKV("Environment", config.environment)
      printKV("Status", success("READY"))
      printDivider()
      prompts.outro(dim("iris agents list  to see them"))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) {
        console.log(JSON.stringify({ ok: false, error: msg }))
      } else {
        spinner?.stop("Error", 1)
        prompts.log.error(`Connection failed: ${msg}`)
        prompts.outro("Done")
      }
      process.exitCode = 1
    }
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformConfigCommand = cmd({
  command: "config",
  describe: "view SDK configuration and test API connection",
  builder: (yargs) =>
    yargs
      .command(ShowCommand)
      .command(TestCommand)
      .demandCommand(0, 0)
      .strict(false),
  async handler(args) {
    // Default action: show
    if (!args._[1]) {
      const handler = (ShowCommand as any).handler
      await handler({ json: false } as any)
    }
  },
})
