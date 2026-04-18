import { Auth } from "../../auth"
import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { ModelsDev } from "../../provider/models"
import { map, pipe, sortBy, values } from "remeda"
import path from "path"
import os from "os"
import fs from "fs"
import { Config } from "../../config/config"
import { Global } from "../../global"
import { Plugin } from "../../plugin"
import { Instance } from "../../project/instance"
import type { Hooks } from "@opencode-ai/plugin"

type PluginAuth = NonNullable<Hooks["auth"]>

/**
 * Handle plugin-based authentication flow.
 * Returns true if auth was handled, false if it should fall through to default handling.
 */
async function handlePluginAuth(plugin: { auth: PluginAuth }, provider: string): Promise<boolean> {
  let index = 0
  if (plugin.auth.methods.length > 1) {
    const method = await prompts.select({
      message: "Login method",
      options: [
        ...plugin.auth.methods.map((x, index) => ({
          label: x.label,
          value: index.toString(),
        })),
      ],
    })
    if (prompts.isCancel(method)) throw new UI.CancelledError()
    index = parseInt(method)
  }
  const method = plugin.auth.methods[index]

  // Handle prompts for all auth types
  await Bun.sleep(10)
  const inputs: Record<string, string> = {}
  if (method.prompts) {
    for (const prompt of method.prompts) {
      if (prompt.condition && !prompt.condition(inputs)) {
        continue
      }
      if (prompt.type === "select") {
        const value = await prompts.select({
          message: prompt.message,
          options: prompt.options,
        })
        if (prompts.isCancel(value)) throw new UI.CancelledError()
        inputs[prompt.key] = value
      } else {
        const value = await prompts.text({
          message: prompt.message,
          placeholder: prompt.placeholder,
          validate: prompt.validate ? (v) => prompt.validate!(v ?? "") : undefined,
        })
        if (prompts.isCancel(value)) throw new UI.CancelledError()
        inputs[prompt.key] = value
      }
    }
  }

  if (method.type === "oauth") {
    const authorize = await method.authorize(inputs)

    if (authorize.url) {
      prompts.log.info("Go to: " + authorize.url)
    }

    if (authorize.method === "auto") {
      if (authorize.instructions) {
        prompts.log.info(authorize.instructions)
      }
      const spinner = prompts.spinner()
      spinner.start("Waiting for authorization...")
      const result = await authorize.callback()
      if (result.type === "failed") {
        spinner.stop("Failed to authorize", 1)
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          await Auth.set(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          await Auth.set(saveProvider, {
            type: "api",
            key: result.key,
          })
        }
        spinner.stop("Login successful")
      }
    }

    if (authorize.method === "code") {
      const code = await prompts.text({
        message: "Paste the authorization code here: ",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(code)) throw new UI.CancelledError()
      const result = await authorize.callback(code)
      if (result.type === "failed") {
        prompts.log.error("Failed to authorize")
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          await Auth.set(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          await Auth.set(saveProvider, {
            type: "api",
            key: result.key,
          })
        }
        prompts.log.success("Login successful")
      }
    }

    prompts.outro("Done")
    return true
  }

  if (method.type === "api") {
    if (method.authorize) {
      const result = await method.authorize(inputs)
      if (result.type === "failed") {
        prompts.log.error("Failed to authorize")
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        await Auth.set(saveProvider, {
          type: "api",
          key: result.key,
        })
        prompts.log.success("Login successful")
      }
      prompts.outro("Done")
      return true
    }
  }

  return false
}

export const AuthCommand = cmd({
  command: "auth",
  describe: "manage credentials",
  builder: (yargs) =>
    yargs.command(AuthLoginCommand).command(AuthLogoutCommand).command(AuthListCommand).demandCommand(),
  async handler() {},
})

export const AuthListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list providers",
  async handler() {
    UI.empty()
    const authPath = path.join(Global.Path.data, "auth.json")
    const homedir = os.homedir()
    const displayPath = authPath.startsWith(homedir) ? authPath.replace(homedir, "~") : authPath
    prompts.intro(`Credentials ${UI.Style.TEXT_DIM}${displayPath}`)
    const results = Object.entries(await Auth.all())
    const database = await ModelsDev.get()

    for (const [providerID, result] of results) {
      const name = database[providerID]?.name || providerID
      prompts.log.info(`${name} ${UI.Style.TEXT_DIM}${result.type}`)
    }

    prompts.outro(`${results.length} credentials`)

    // Environment variables section
    const activeEnvVars: Array<{ provider: string; envVar: string }> = []

    for (const [providerID, provider] of Object.entries(database)) {
      for (const envVar of provider.env) {
        if (process.env[envVar]) {
          activeEnvVars.push({
            provider: provider.name || providerID,
            envVar,
          })
        }
      }
    }

    if (activeEnvVars.length > 0) {
      UI.empty()
      prompts.intro("Environment")

      for (const { provider, envVar } of activeEnvVars) {
        prompts.log.info(`${provider} ${UI.Style.TEXT_DIM}${envVar}`)
      }

      prompts.outro(`${activeEnvVars.length} environment variable` + (activeEnvVars.length === 1 ? "" : "s"))
    }
  },
})

// ============================================================================
// IRIS Platform login — email → 6-digit code → SDK token
// Mirrors the bash iris-login flow but lives inside the CLI.
// ============================================================================

const IRIS_DIR = path.join(os.homedir(), ".iris")
const SDK_ENV_PATH = path.join(IRIS_DIR, "sdk", ".env")
const IRIS_AUTH_API = process.env.IRIS_AUTH_API_URL ?? "https://raichu.heyiris.io"

async function irisLoginStatus(): Promise<{ authenticated: boolean; token?: string; userId?: string }> {
  try {
    if (fs.existsSync(SDK_ENV_PATH)) {
      const text = fs.readFileSync(SDK_ENV_PATH, "utf-8")
      const token = text.match(/^IRIS_API_KEY=(.+)$/m)?.[1]?.trim()
      const userId = text.match(/^IRIS_USER_ID=(.+)$/m)?.[1]?.trim()
      if (token) return { authenticated: true, token, userId }
    }
  } catch {}
  return { authenticated: false }
}

async function irisLoginFlow(forceReauth: boolean): Promise<boolean> {
  // Check existing auth
  if (!forceReauth) {
    const status = await irisLoginStatus()
    if (status.authenticated) {
      prompts.log.success("Already authenticated with IRIS Platform")
      prompts.log.info(`Token: ${status.token!.slice(0, 12)}…`)
      prompts.log.info(`To re-authenticate: ${UI.Style.TEXT_HIGHLIGHT}iris auth login --force${UI.Style.TEXT_NORMAL}`)
      return true
    }
  }

  // Email input
  const email = await prompts.text({
    message: "Enter your email",
    placeholder: "you@example.com",
    validate: (v) => {
      if (!v || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "Enter a valid email"
    },
  })
  if (prompts.isCancel(email)) throw new UI.CancelledError()

  // Send verification code
  const spinner = prompts.spinner()
  spinner.start("Sending verification code…")
  try {
    const sendRes = await fetch(`${IRIS_AUTH_API}/api/v1/auth/send-login-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        email,
        method: "with_login_code",
        expiration_minutes: 30,
        auto_create: true,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const sendData = (await sendRes.json()) as any
    const ok = sendData?.success === true || sendData?.success === "True"
    if (!ok) {
      spinner.stop("Failed", 1)
      prompts.log.error("Could not send code. Sign up at: https://web.heyiris.io/login/register")
      return false
    }
    const isNew = sendData?.data?.new_account === true || sendData?.data?.new_account === "true"
    spinner.stop(isNew ? "Account created! Check your inbox." : "Code sent! Check your inbox.")
  } catch (e) {
    spinner.stop("Failed", 1)
    prompts.log.error(`Network error: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }

  // Code input
  const code = await prompts.text({
    message: "Enter the 6-digit code from your email",
    validate: (v) => {
      if (!v || !/^\d{4,8}$/.test(v.trim())) return "Enter the numeric code from your email"
    },
  })
  if (prompts.isCancel(code)) throw new UI.CancelledError()

  // Verify code and get SDK token
  const verifySpinner = prompts.spinner()
  verifySpinner.start("Verifying…")
  try {
    const loginRes = await fetch(`${IRIS_AUTH_API}/api/v1/auth/login-with-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        email,
        login_code: String(code).trim(),
        generate_sdk_token: true,
        sdk_token_name: "IRIS CLI",
        sdk_token_expires_days: 365,
        generate_dashboard_url: true,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const loginData = (await loginRes.json()) as any
    const loginOk = loginData?.success === true || loginData?.success === "True"
    if (!loginOk) {
      verifySpinner.stop("Failed", 1)
      prompts.log.error("Login failed — code may have expired. Try again.")
      return false
    }

    const sdkToken = loginData?.data?.sdk_token?.key
    const userId = loginData?.data?.user?.id
    const dashboard = loginData?.data?.dashboard_url

    if (!sdkToken || !userId) {
      verifySpinner.stop("Failed", 1)
      prompts.log.error("Auth succeeded but token wasn't generated. Try again or visit https://web.heyiris.io")
      return false
    }

    // Write ~/.iris/sdk/.env
    fs.mkdirSync(path.join(IRIS_DIR, "sdk"), { recursive: true })
    fs.writeFileSync(
      SDK_ENV_PATH,
      [
        "# IRIS SDK Configuration",
        "# Generated by IRIS CLI",
        `# Date: ${new Date().toISOString()}`,
        "",
        "IRIS_ENV=production",
        `IRIS_API_KEY=${sdkToken}`,
        `IRIS_USER_ID=${userId}`,
        "IRIS_DEFAULT_MODEL=gpt-4o-mini",
        "",
      ].join("\n"),
      { mode: 0o600 },
    )

    // Also store in the opencode auth system so resolveToken() finds it first
    await Auth.set("iris", { type: "api", key: sdkToken })

    verifySpinner.stop("Authenticated!")
    if (dashboard) {
      prompts.log.info(`Dashboard: ${UI.Style.TEXT_HIGHLIGHT}${dashboard}${UI.Style.TEXT_NORMAL}`)
    }
    return true
  } catch (e) {
    verifySpinner.stop("Failed", 1)
    prompts.log.error(`Network error: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

export const AuthLoginCommand = cmd({
  command: "login [url]",
  describe: "log in to IRIS Platform or an AI provider",
  builder: (yargs) =>
    yargs
      .positional("url", {
        describe: "opencode auth provider URL",
        type: "string",
      })
      .option("provider", {
        describe: "skip selection — go directly to AI provider login",
        type: "boolean",
        default: false,
      })
      .option("force", {
        describe: "re-authenticate even if already logged in",
        type: "boolean",
        default: false,
      }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()

        // If --provider flag or a URL is given, go straight to AI provider flow
        if (args.provider || args.url) {
          prompts.intro("Add AI provider credential")
          if (args.url) {
            const wellknown = await fetch(`${args.url}/.well-known/opencode`).then((x) => x.json() as any)
            prompts.log.info(`Running \`${wellknown.auth.command.join(" ")}\``)
            const proc = Bun.spawn({
              cmd: wellknown.auth.command,
              stdout: "pipe",
            })
            const exit = await proc.exited
            if (exit !== 0) {
              prompts.log.error("Failed")
              prompts.outro("Done")
              return
            }
            const token = await new Response(proc.stdout).text()
            await Auth.set(args.url, {
              type: "wellknown",
              key: wellknown.auth.env,
              token: token.trim(),
            })
            prompts.log.success("Logged into " + args.url)
            prompts.outro("Done")
            return
          }
          // Fall through to AI provider picker below
        } else {
          // Default: IRIS Platform login
          prompts.intro("IRIS Login")

          const choice = await prompts.select({
            message: "What would you like to log in to?",
            options: [
              { label: "IRIS Platform", value: "iris", hint: "email + code — for copycat, leads, agents, etc." },
              { label: "AI Provider", value: "ai", hint: "API key for OpenAI, Anthropic, etc." },
            ],
          })
          if (prompts.isCancel(choice)) throw new UI.CancelledError()

          if (choice === "iris") {
            const ok = await irisLoginFlow(!!args.force)
            prompts.outro("Done")
            return
          }
          // choice === "ai" — fall through to AI provider picker
        }

        // AI provider picker (original opencode flow)
        if (!args.url) prompts.intro("Add AI provider credential")
        await ModelsDev.refresh().catch(() => {})

        const config = await Config.get()

        const disabled = new Set(config.disabled_providers ?? [])
        const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

        const providers = await ModelsDev.get().then((x) => {
          const filtered: Record<string, (typeof x)[string]> = {}
          for (const [key, value] of Object.entries(x)) {
            if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
              filtered[key] = value
            }
          }
          return filtered
        })

        const priority: Record<string, number> = {
          opencode: 0,
          anthropic: 1,
          "github-copilot": 2,
          openai: 3,
          google: 4,
          openrouter: 5,
          vercel: 6,
        }
        let provider = await prompts.autocomplete({
          message: "Select provider",
          maxItems: 8,
          options: [
            ...pipe(
              providers,
              values(),
              sortBy(
                (x) => priority[x.id] ?? 99,
                (x) => x.name ?? x.id,
              ),
              map((x) => ({
                label: x.name,
                value: x.id,
                hint: {
                  opencode: "recommended",
                  anthropic: "Claude Max or API key",
                }[x.id],
              })),
            ),
            {
              value: "other",
              label: "Other",
            },
          ],
        })

        if (prompts.isCancel(provider)) throw new UI.CancelledError()

        const plugin = await Plugin.list().then((x) => x.find((x) => x.auth?.provider === provider))
        if (plugin && plugin.auth) {
          const handled = await handlePluginAuth({ auth: plugin.auth }, provider)
          if (handled) return
        }

        if (provider === "other") {
          provider = await prompts.text({
            message: "Enter provider id",
            validate: (x) => (x && x.match(/^[0-9a-z-]+$/) ? undefined : "a-z, 0-9 and hyphens only"),
          })
          if (prompts.isCancel(provider)) throw new UI.CancelledError()
          provider = provider.replace(/^@ai-sdk\//, "")
          if (prompts.isCancel(provider)) throw new UI.CancelledError()

          // Check if a plugin provides auth for this custom provider
          const customPlugin = await Plugin.list().then((x) => x.find((x) => x.auth?.provider === provider))
          if (customPlugin && customPlugin.auth) {
            const handled = await handlePluginAuth({ auth: customPlugin.auth }, provider)
            if (handled) return
          }

          prompts.log.warn(
            `This only stores a credential for ${provider} - you will need configure it in opencode.json, check the docs for examples.`,
          )
        }

        if (provider === "amazon-bedrock") {
          prompts.log.info(
            "Amazon Bedrock authentication priority:\n" +
              "  1. Bearer token (AWS_BEARER_TOKEN_BEDROCK or /connect)\n" +
              "  2. AWS credential chain (profile, access keys, IAM roles)\n\n" +
              "Configure via opencode.json options (profile, region, endpoint) or\n" +
              "AWS environment variables (AWS_PROFILE, AWS_REGION, AWS_ACCESS_KEY_ID).",
          )
          prompts.outro("Done")
          return
        }

        if (provider === "opencode") {
          prompts.log.info("Create an api key at https://opencode.ai/auth")
        }

        if (provider === "vercel") {
          prompts.log.info("You can create an api key at https://vercel.link/ai-gateway-token")
        }

        if (["cloudflare", "cloudflare-ai-gateway"].includes(provider)) {
          prompts.log.info(
            "Cloudflare AI Gateway can be configured with CLOUDFLARE_GATEWAY_ID, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN environment variables. Read more: https://opencode.ai/docs/providers/#cloudflare-ai-gateway",
          )
        }

        const key = await prompts.password({
          message: "Enter your API key",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(key)) throw new UI.CancelledError()
        await Auth.set(provider, {
          type: "api",
          key,
        })

        prompts.outro("Done")
      },
    })
  },
})

export const AuthLogoutCommand = cmd({
  command: "logout",
  describe: "log out from a configured provider",
  async handler() {
    UI.empty()
    const credentials = await Auth.all().then((x) => Object.entries(x))
    prompts.intro("Remove credential")
    if (credentials.length === 0) {
      prompts.log.error("No credentials found")
      return
    }
    const database = await ModelsDev.get()
    const providerID = await prompts.select({
      message: "Select provider",
      options: credentials.map(([key, value]) => ({
        label: (database[key]?.name || key) + UI.Style.TEXT_DIM + " (" + value.type + ")",
        value: key,
      })),
    })
    if (prompts.isCancel(providerID)) throw new UI.CancelledError()
    await Auth.remove(providerID)
    prompts.outro("Logout successful")
  },
})
