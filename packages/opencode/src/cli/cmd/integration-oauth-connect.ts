/**
 * Interactive runner for CLI-native integration OAuth.
 *
 * Pairs with integration-oauth-local.ts (the pure protocol bits). Everything that
 * touches a terminal, a browser or the API lives here so the protocol layer stays
 * unit-testable.
 */

import { exec } from "child_process"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireUserId, handleApiError, printDivider, printKV, dim, bold, success, highlight, IRIS_API } from "./iris-api"
import {
  LOCAL_OAUTH_PROVIDERS,
  LocalOAuthError,
  awaitLoopbackCode,
  buildAuthorizeUrl,
  exchangeCode,
  generateState,
  loopbackRedirectUri,
  type LocalOAuthProvider,
} from "./integration-oauth-local"

export interface LocalConnectArgs {
  "client-id"?: string
  "client-secret"?: string
  port?: number
  paste?: boolean
  "print-url"?: boolean
  name?: string
  bloq?: number
  json?: boolean
  "user-id"?: number
}

function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  try {
    exec(`${opener} "${url}"`)
  } catch {
    // Non-fatal — the URL is always printed as well.
  }
}

function envKey(slug: string, suffix: string): string {
  return `${slug.toUpperCase().replace(/-/g, "_")}_${suffix}`
}

/**
 * Resolve the app credentials: explicit flag → environment → prompt.
 *
 * The secret is read with a masked prompt and never echoed back, printed in a
 * summary, or written to disk by this command.
 */
async function resolveAppCredentials(
  provider: LocalOAuthProvider,
  args: LocalConnectArgs,
): Promise<{ clientId: string; clientSecret: string } | null> {
  const idEnv = envKey(provider.slug, "CLIENT_ID")
  const secretEnv = envKey(provider.slug, "CLIENT_SECRET")

  let clientId = (args["client-id"] ?? process.env[idEnv] ?? "").trim()
  let clientSecret = (args["client-secret"] ?? process.env[secretEnv] ?? "").trim()

  const interactive = Boolean(process.stdin.isTTY) && !args.json

  if (!clientId) {
    if (!interactive) {
      prompts.log.error(`Missing client id. Pass --client-id or set ${idEnv}.`)
      return null
    }
    const v = await prompts.text({
      message: `${provider.label} Client ID`,
      validate: (s) => (!s || s.trim().length < 8 ? "Required" : undefined),
    })
    if (prompts.isCancel(v)) return null
    clientId = String(v).trim()
  }

  if (!clientSecret) {
    if (!interactive) {
      prompts.log.error(`Missing client secret. Pass --client-secret or set ${secretEnv}.`)
      return null
    }
    const v = await prompts.password({
      message: `${provider.label} Client Secret`,
      validate: (s) => (!s || s.trim().length < 8 ? "Required" : undefined),
    })
    if (prompts.isCancel(v)) return null
    clientSecret = String(v).trim()
  }

  return { clientId, clientSecret }
}

export function isLocalOAuthProvider(type: string): boolean {
  return Boolean(LOCAL_OAUTH_PROVIDERS[type])
}

export async function runLocalOAuthConnect(type: string, args: LocalConnectArgs): Promise<void> {
  const provider = LOCAL_OAUTH_PROVIDERS[type]
  if (!provider) {
    prompts.log.error(`No CLI-native OAuth flow for ${type}.`)
    process.exitCode = 1
    return
  }

  const userId = await requireUserId(args["user-id"])
  if (!userId) return

  const creds = await resolveAppCredentials(provider, args)
  if (!creds) {
    prompts.outro("Cancelled")
    return
  }

  const state = generateState()
  const usePaste = Boolean(args.paste) || !process.stdin.isTTY
  const port = Number(args.port ?? 8787)

  if (usePaste && !provider.oobRedirectUri) {
    prompts.log.error(`${provider.label} has no paste-mode redirect; re-run without --paste.`)
    process.exitCode = 1
    return
  }

  const redirectUri = usePaste ? provider.oobRedirectUri! : loopbackRedirectUri(port)
  const authorizeUrl = buildAuthorizeUrl(provider, { clientId: creds.clientId, redirectUri, state })

  console.log()
  console.log(`  ${dim("Redirect URI:")} ${highlight(redirectUri)}`)
  console.log(`  ${dim("This exact value must be registered on the app, or the browser shows an error.")}`)
  if (provider.note) console.log(`  ${dim(provider.note)}`)
  console.log()

  if (args["print-url"]) {
    console.log(`  ${dim("Authorize at:")} ${authorizeUrl}`)
    prompts.outro("Done")
    return
  }

  let code: string
  try {
    if (usePaste) {
      console.log(`  ${success("→")} Open this URL, approve, then paste the code shown:`)
      console.log(`  ${authorizeUrl}`)
      console.log()
      openBrowser(authorizeUrl)
      const pasted = await prompts.text({
        message: "Authorization code",
        validate: (s) => (!s || s.trim().length < 8 ? "Required" : undefined),
      })
      if (prompts.isCancel(pasted)) {
        prompts.outro("Cancelled")
        return
      }
      code = String(pasted).trim()
    } else {
      console.log(`  ${success("→")} Opening ${highlight(provider.label)} in your browser…`)
      console.log(`  ${dim("If it didn't open:")} ${authorizeUrl}`)
      console.log()
      const waiter = awaitLoopbackCode({ provider, port, state })
      openBrowser(authorizeUrl)
      const spin = prompts.spinner()
      spin.start(`Waiting for the callback on 127.0.0.1:${port}…`)
      try {
        code = await waiter
        spin.stop(`${success("✓")} Authorized`)
      } catch (err) {
        spin.stop("Authorization failed", 1)
        throw err
      }
    }
  } catch (err) {
    prompts.log.error(err instanceof LocalOAuthError ? err.message : err instanceof Error ? err.message : String(err))
    if (!usePaste) {
      console.log(`  ${dim("Port busy or blocked? Retry with:")} ${highlight(`iris integrations connect ${type} --paste`)}`)
    }
    process.exitCode = 1
    prompts.outro("Done")
    return
  }

  const spinner = prompts.spinner()
  spinner.start("Exchanging code for tokens…")

  let tokens
  try {
    tokens = await exchangeCode(provider, {
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      code,
      redirectUri,
    })
  } catch (err) {
    spinner.stop("Token exchange failed", 1)
    prompts.log.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
    prompts.outro("Done")
    return
  }

  spinner.stop(`${success("✓")} Tokens received`)

  const expiresIn = Number(tokens.expires_in ?? 3600)
  const payload: Record<string, unknown> = {
    type: provider.slug,
    status: "active",
    credentials: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? null,
      token_type: tokens.token_type ?? "Bearer",
      expires_in: expiresIn,
      // ISO8601 on purpose: the server-side service Carbon::parse()s this and
      // rewrites it in the same shape on refresh. A unix int throws there.
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    },
  }
  if (args.name) payload.name = args.name
  if (args.bloq) payload.bloq_id = args.bloq

  const saveSpinner = prompts.spinner()
  saveSpinner.start("Saving integration…")

  const res = await irisFetch(`/api/v1/users/${userId}/integrations`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
  const ok = await handleApiError(res, `Save ${provider.label} integration`)
  if (!ok) {
    saveSpinner.stop("Failed", 1)
    process.exitCode = 1
    prompts.outro("Done")
    return
  }

  const data = (await res.json()) as Record<string, any>
  const integration = data?.data ?? data

  if (args.json) {
    saveSpinner.stop("Saved")
    console.log(JSON.stringify(integration, null, 2))
    return
  }

  saveSpinner.stop(`${success("✓")} Connected: ${bold(provider.label)}`)
  printDivider()
  printKV("ID", integration?.id)
  printKV("Type", integration?.type ?? provider.slug)
  printKV("Status", integration?.status ?? "active")
  console.log()

  // The token we just minted expires. Refresh happens server-side and reads the
  // app credentials from the server's own environment — not from this row — so a
  // connection made purely from a laptop goes dead in an hour without this step.
  const idEnv = envKey(provider.slug, "CLIENT_ID")
  const secretEnv = envKey(provider.slug, "CLIENT_SECRET")
  console.log(`  ${bold("One more step:")} token refresh runs server-side and reads ${highlight(idEnv)} / ${highlight(secretEnv)}`)
  console.log(`  ${dim("from the API's environment. Without them this connection stops working when the token expires.")}`)
  console.log()
  console.log(`  ${dim("Verify:")} ${highlight(`iris integrations exec ${provider.slug} list_matters`)}`)
  prompts.outro("Done")
}

export { LOCAL_OAUTH_PROVIDERS, UI }
