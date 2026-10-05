import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, requireAuth, requireUserId, handleApiError, writeJson, isJsonMode, dim, bold, highlight, success } from "./iris-api"
import { firstArray } from "../../util/array"
import {
  type AccountState,
  type NextMove,
  recommendNext,
  normalizeSiteUrl,
  brandContextFromExtraction,
  contextHasBrand,
} from "./next-move"

// ============================================================================
// iris next — one recommended move (#187930)
// ============================================================================

/** Same one-line shape as iris-api's (#180540) JSON errors, plus a non-zero exit. */
function jsonFail(message: string, extra?: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ success: false, error: message, ...(extra ?? {}) }) + "\n")
  process.exitCode = 1
}

/** Read a JSON body, or null. Every probe is best-effort: a failure is "unknown", never a crash. */
async function probe(path: string): Promise<any | null> {
  try {
    const res = await irisFetch(path)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export async function readAccountState(userId: number, bloqOverride?: number): Promise<AccountState> {
  const [bloqsBody, integrationsBody, pagesBody] = await Promise.all([
    probe(`/api/v1/user/${userId}/bloqs?simplified=1&per_page=50`),
    probe(`/api/v1/users/${userId}/integrations`),
    probe(`/api/v1/pages?per_page=1`),
  ])

  const bloqs = bloqsBody ? firstArray(bloqsBody?.data, bloqsBody) : null
  const firstBloqId = bloqOverride ?? (bloqs && bloqs.length ? Number(bloqs[0].id) : null)

  let hasBrand: boolean | null = null
  let website: string | null = null
  if (firstBloqId) {
    const ctxBody = await probe(`/api/v1/bloqs/${firstBloqId}/business-context`)
    if (ctxBody) {
      const ctx = (ctxBody?.data ?? ctxBody)?.business_context ?? {}
      hasBrand = contextHasBrand(ctx)
      website = ctx?.brand?.source_url ?? ctx?.website ?? null
    }
  }

  const integrations = integrationsBody
    ? firstArray(integrationsBody?.connections, integrationsBody?.data, integrationsBody).length
    : null
  const pagesTotal = pagesBody?.meta?.total ?? pagesBody?.total
  const pages = pagesBody ? (typeof pagesTotal === "number" ? pagesTotal : firstArray(pagesBody?.data, pagesBody).length) : null

  return {
    bloqs: bloqs ? (bloqOverride ? Math.max(bloqs.length, 1) : bloqs.length) : null,
    firstBloqId,
    hasBrand,
    website,
    integrations,
    pages,
  }
}

/**
 * The "already have a site?" path: read the real site and store its brand as the
 * account's context — rather than rebuilding a page the user already owns.
 * Creates the workspace (bloq) first on a fresh account.
 */
async function onboardFromSite(userId: number, url: string, bloqId: number | null): Promise<{ bloqId: number; brandName: string } | null> {
  const quiet = isJsonMode()
  const sp = quiet ? null : prompts.spinner()
  sp?.start(`Reading ${url}…`)

  const res = await irisFetch("/api/v6/workspace/tools/execute", {
    method: "POST",
    body: JSON.stringify({ tool: "websiteBrandExtractor", params: { url } }),
  })
  if (!(await handleApiError(res, "Read site"))) { sp?.stop("Failed", 1); return null }
  const body = (await res.json()) as any
  const result = body?.result ? (typeof body.result === "string" ? JSON.parse(body.result) : body.result) : body
  if (!result?.success) {
    sp?.stop("Failed", 1)
    if (quiet) jsonFail(result?.error ?? "Could not read that site", { action: "next --site", url })
    else prompts.log.error(result?.error ?? "Could not read that site")
    return null
  }
  const brand = brandContextFromExtraction(result, url)
  const brandName = String(brand.name)

  if (!bloqId) {
    sp?.message(`Creating workspace “${brandName}”…`)
    const created = await irisFetch(`/api/v1/user/${userId}/bloqs`, {
      method: "POST",
      body: JSON.stringify({ name: brandName, description: brand.tagline ?? `Workspace for ${url}` }),
    })
    if (!(await handleApiError(created, "Create workspace"))) { sp?.stop("Failed", 1); return null }
    const cb = (await created.json()) as any
    bloqId = Number(cb?.data?.id ?? cb?.id)
    if (!bloqId) { sp?.stop("Failed", 1); return null }
  }

  sp?.message("Saving brand context…")
  for (const [path, value] of [["brand", brand], ["website", url]] as const) {
    const r = await irisFetch(`/api/v1/bloqs/${bloqId}/business-context/key`, {
      method: "PATCH",
      body: JSON.stringify({ path, value, action: "set" }),
    })
    if (!(await handleApiError(r, `Save ${path}`))) { sp?.stop("Failed", 1); return null }
  }
  sp?.stop(success(`${brandName} — brand and context saved to workspace #${bloqId}`))
  return { bloqId, brandName }
}

function printCard(move: NextMove) {
  console.log()
  console.log(`  ${dim("UP NEXT")}`)
  console.log(`  ${bold(move.title)}`)
  console.log(`  ${dim(`${move.who} · ~${move.minutes} min`)}`)
  console.log()
  console.log(`  ${highlight("$")} ${move.command}`)
  console.log()
  console.log(`  ${dim(move.why)}`)
  console.log()
}

export const PlatformNextCommand = cmd({
  command: "next",
  aliases: ["up-next"],
  describe: "the ONE next move for your account — who does it, how long, and the command to run",
  builder: (y) =>
    y
      .option("site", { type: "string", describe: "already have a site? paste the URL — IRIS reads it for brand + context" })
      .option("bloq", { type: "number", describe: "workspace (bloq) to check / save context to (default: your first)" })
      .option("user-id", { type: "number", describe: "user ID (or IRIS_USER_ID env)" })
      .option("json", { type: "boolean", default: false, describe: "print [ { id, title, command, who, minutes, why } ] — always exactly one" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const json = Boolean(args.json)
    const userId = await requireUserId(args["user-id"] as number | undefined)
    if (!userId) {
      if (json) jsonFail("Could not resolve your user ID.", { fix: "export IRIS_USER_ID=<id> or --user-id" })
      return
    }

    let state = await readAccountState(userId, args.bloq as number | undefined)
    let move = recommendNext(state)

    let site = normalizeSiteUrl(args.site as string | undefined)
    if (args.site && !site) {
      if (json) { jsonFail(`Not a site URL: ${args.site}`, { action: "next --site" }); return }
      prompts.log.error(`Not a site URL: ${args.site}`)
      return
    }

    // The question Agentica's onboarding asks first: in a terminal, offer it right on
    // the card instead of making a new user discover a flag.
    if (!site && !json && process.stdin.isTTY && (move.id === "brand-from-site" || move.id === "create-workspace")) {
      printCard(move)
      const answer = await prompts.text({ message: "Already have a site? Paste the URL (Enter to skip)", placeholder: "example.com" })
      if (!prompts.isCancel(answer)) site = normalizeSiteUrl(answer as string)
      if (!site) return
    }

    if (site) {
      const done = await onboardFromSite(userId, site, state.firstBloqId)
      if (!done) { process.exitCode = 1; return }
      state = await readAccountState(userId, done.bloqId)
      // The context write just succeeded; don't let a slow read-back re-recommend it.
      state.hasBrand = true
      state.website = state.website ?? site
      move = recommendNext(state)
    }

    if (json) {
      await writeJson([move])
      return
    }
    printCard(move)
  },
})
