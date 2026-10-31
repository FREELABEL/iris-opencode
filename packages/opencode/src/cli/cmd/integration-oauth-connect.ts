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
import { irisFetch, requireUserId, handleApiError, printDivider, printKV, dim, bold, success, highlight, IRIS_API, FL_API, writeJson } from "./iris-api"
import {
  LOCAL_OAUTH_PROVIDERS,
  LocalOAuthError,
  awaitLoopbackCode,
  buildAuthorizeUrl,
  buildSavePayload,
  exchangeCode,
  generateState,
  parsePastedCallback,
  persistTokens,
  providerRedirectUri,
  resolveScopes,
  type LocalOAuthProvider,
} from "./integration-oauth-local"
import { openBrowser } from "../../util/browser"

export interface LocalConnectArgs {
  "client-id"?: string
  "client-secret"?: string
  port?: number
  paste?: boolean
  "print-url"?: boolean
  /** Request the provider's `org` scope set (LinkedIn company pages). */
  org?: boolean
  /** Request a named scope set (`default`, `org`, …). Wins over --org. */
  "scope-set"?: string
  name?: string
  bloq?: number
  json?: boolean
  "user-id"?: number
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

  let scopes: string[] | undefined
  try {
    scopes = resolveScopes(provider, args["scope-set"] ?? (args.org ? "org" : undefined))
  } catch (err) {
    prompts.log.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
    return
  }

  const state = generateState()
  const usePaste = Boolean(args.paste) || !process.stdin.isTTY
  // A provider that needs its redirect registered port-and-all has a FIXED default port,
  // so the URI the user registered once keeps matching. --port still overrides it.
  const port = Number(args.port ?? provider.defaultPort ?? 8787)

  // Paste mode: the provider's out-of-band page when it has one; otherwise the same
  // loopback redirect, and the user pastes the URL the browser lands on.
  const redirectUri = usePaste && provider.oobRedirectUri ? provider.oobRedirectUri : providerRedirectUri(provider, port)
  const authorizeUrl = buildAuthorizeUrl(provider, { clientId: creds.clientId, redirectUri, state, scopes })

  console.log()
  console.log(`  ${dim("Redirect URI:")} ${highlight(redirectUri)}`)
  console.log(`  ${dim("This exact value must be registered on the app, or the browser shows an error.")}`)
  if (scopes) console.log(`  ${dim("Scopes:")} ${scopes.join(" ")}`)
  for (const line of provider.setup ?? []) console.log(`  ${dim(line)}`)
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
      const oob = Boolean(provider.oobRedirectUri)
      console.log(
        `  ${success("→")} ${oob ? "Open this URL, approve, then paste the code shown:" : "Open this URL and approve. The browser then fails to load the redirect page — that is expected; paste the full URL from its address bar:"}`,
      )
      console.log(`  ${authorizeUrl}`)
      console.log()
      openBrowser(authorizeUrl)
      const pasted = await prompts.text({
        message: oob ? "Authorization code" : "Redirect URL (or the code)",
        validate: (s) => (!s || s.trim().length < 8 ? "Required" : undefined),
      })
      if (prompts.isCancel(pasted)) {
        prompts.outro("Cancelled")
        return
      }
      code = parsePastedCallback(String(pasted), state)
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

  const payload = buildSavePayload(provider, tokens, {
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    name: args.name,
    bloq: args.bloq,
  })

  const saveSpinner = prompts.spinner()
  saveSpinner.start("Saving integration…")

  // Clio's service lives in fl-api; LinkedIn's in fl-iris-api. Each provider says which.
  const res = await persistTokens(
    (path, init, target) => irisFetch(path, init, target === "iris" ? IRIS_API : FL_API),
    provider,
    userId,
    payload,
  )
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
    await writeJson(integration)
    return
  }

  saveSpinner.stop(`${success("✓")} Connected: ${bold(provider.label)}`)
  printDivider()
  printKV("ID", integration?.id)
  printKV("Type", integration?.type ?? provider.slug)
  printKV("Status", integration?.status ?? "active")
  console.log()

  if (provider.storeAppCredentialsForRefresh) {
    // The app id/secret travel with the refresh token (encrypted server-side), so refresh
    // needs nothing from the server's environment. No refresh token → nothing to refresh.
    if (tokens.refresh_token) {
      console.log(`  ${dim(`${provider.label} issued a refresh token; IRIS will renew the access token itself.`)}`)
    } else {
      const days = Math.round(Number(tokens.expires_in ?? 0) / 86400)
      console.log(
        `  ${dim(`${provider.label} issued no refresh token (normal unless the app is a LinkedIn partner app).`)}`,
      )
      console.log(
        `  ${dim(`This sign-in lasts ${days > 0 ? `about ${days} days` : "until the token expires"}; run the same connect command again when IRIS asks.`)}`,
      )
    }
  } else {
    // The token we just minted expires. Refresh happens server-side and reads the
    // app credentials from the server's own environment — not from this row — so a
    // connection made purely from a laptop goes dead in an hour without this step.
    const idEnv = envKey(provider.slug, "CLIENT_ID")
    const secretEnv = envKey(provider.slug, "CLIENT_SECRET")
    console.log(`  ${bold("One more step:")} token refresh runs server-side and reads ${highlight(idEnv)} / ${highlight(secretEnv)}`)
    console.log(`  ${dim("from the API's environment. Without them this connection stops working when the token expires.")}`)
  }
  console.log()
  console.log(`  ${dim("Verify:")} ${highlight(provider.verifyCommand ?? `iris integrations exec ${provider.slug}`)}`)
  prompts.outro("Done")
}

export { LOCAL_OAUTH_PROVIDERS, UI }
