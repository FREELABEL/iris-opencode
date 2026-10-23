import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, dim, bold, success, highlight, warn } from "./iris-api"
import { fetchAccounts, findBrand, connectedTargets } from "./platform-social"

/**
 * `iris post` — publish a post to social platforms through fl-api's unified,
 * failover-protected endpoint (upload-post primary → Buffer fallback).
 *
 *   iris post "gm ☀️" --to x --profile freelabelnet
 *   iris post --video https://cdn/clip.mp4 --caption "new drop" --to x --profile freelabelnet
 *   iris post --image https://cdn/a.png --image https://cdn/b.png --to x,instagram --profile freelabelnet
 *   iris post --video https://cdn/reel.mp4 --caption "…" --brand heyiris             # every connected account
 *   iris post --video https://cdn/reel.mp4 --caption "…" --brand heyiris --to instagram,x
 *
 * Backs the same POST /api/v1/social-media/publish the Review Studio "Publish"
 * button uses, so CLI + UI share one bulletproof path. (bug #165862)
 *
 * --brand (#188875): the server resolves each platform to that brand's own account and
 * reports the ones it could not (`skipped`). `--to all` — the default with --brand — is every
 * platform `iris social accounts` shows as connected for the brand.
 */

export interface PostInput {
  platforms: string[]
  brand?: string
  profile?: string
  text?: string
  caption?: string
  video?: string
  images?: string[]
  mediaType?: string
}

/** The request body, or an error saying what is missing. Video → photos → text, as the server detects it. */
export function buildPostBody(i: PostInput): { body: Record<string, unknown>; kind: string } | { error: string } {
  if (!i.platforms.length) return { error: "No platforms — pass --to x[,instagram,...] (or --to all with --brand)" }
  if (!i.profile && !i.brand) return { error: "No account — pass --brand <slug> (see: iris social accounts) or --profile <upload-post username>" }
  const body: Record<string, unknown> = { platforms: i.platforms }
  if (i.brand) body.brand = i.brand
  if (i.profile) body.user = i.profile
  if (i.mediaType) body.media_type = i.mediaType.toUpperCase()
  const images = i.images ?? []
  if (i.video) {
    body.video_url = i.video
    body.title = i.caption ?? i.text ?? ""
    return { body, kind: "video" }
  }
  if (images.length) {
    body.photo_urls = images
    body.title = i.caption ?? i.text ?? ""
    return { body, kind: images.length > 1 ? "carousel" : "image" }
  }
  if (i.text) {
    body.text = i.text
    return { body, kind: "text" }
  }
  return { error: "Nothing to post — pass text, --video <url>, or --image <url>" }
}

export interface PlatformRow {
  platform: string
  profile?: string
  status: "posted" | "submitted" | "failed" | "skipped"
  detail?: string
}

/**
 * A platform's own outcome. upload-post nests it — results.instagram is sometimes
 * `{ results: { instagram: {success:false, error_code, error} } }` — and the OUTER level
 * (and the response's top-level `success`, and its `summary`) can say success while the
 * inner one says failed (#188875, measured on a reauth-required account). Only the innermost
 * per-platform object is believed.
 */
function innermost(platform: string, r: any): any {
  let cur = r
  for (let i = 0; i < 4 && cur?.results?.[platform]; i++) cur = cur.results[platform]
  return cur
}

function outcome(platform: string, r: any, profile?: string): PlatformRow {
  const x = innermost(platform, r)
  const failed = x?.success === false || x?.status === "failed" || !!x?.error || !!x?.error_code || !!x?.error_message
  if (failed) {
    const msg = String(x?.error_message ?? x?.error ?? x?.message ?? "failed")
    return { platform, profile, status: "failed", detail: x?.error_code ? `${x.error_code}: ${msg}` : msg }
  }
  return { platform, profile, status: "posted", detail: x?.post_url ?? x?.url ?? undefined }
}

/**
 * One row per platform from the publish response, whichever shape it came back in:
 *   single profile  { success, results: {platform: {...}}, request_id?, skipped? }
 *   several         { success, by_profile: {profile: <single shape>}, skipped }
 *   background      { message, request_id, job_id, skipped }      → "submitted", resolve with statusRows
 * Platforms the server skipped (no enabled account for the brand) are rows too — never dropped.
 */
export function publishRows(data: any, requested: string[]): PlatformRow[] {
  const rows: PlatformRow[] = []
  const groups: [string | undefined, any][] = data?.by_profile
    ? Object.entries(data.by_profile as Record<string, any>)
    : [[undefined, data]]
  const seen = new Set<string>()
  for (const [profile, g] of groups) {
    const results = g?.results
    if (results && typeof results === "object" && !Array.isArray(results)) {
      for (const [platform, r] of Object.entries(results as Record<string, any>)) {
        seen.add(platform)
        rows.push(outcome(platform, r, profile))
      }
    }
  }
  // A background upload answers with a request_id and no per-platform results yet, and the
  // by_profile shape does not say which platforms each group carried — so every requested
  // platform the server neither reported nor skipped is "submitted" (resolved by polling) or,
  // when the request itself failed, "failed".
  const ids = requestIds(data)
  const accepted = data?.success !== false && (data?.success || ids.length > 0)
  for (const platform of requested) {
    if (seen.has(platform) || data?.skipped?.[platform]) continue
    rows.push({
      platform,
      status: accepted ? "submitted" : "failed",
      detail: accepted ? (ids.length ? `request ${ids.join(", ")}` : undefined) : String(data?.error ?? data?.message ?? "failed"),
    })
  }
  for (const [platform, reason] of Object.entries((data?.skipped ?? {}) as Record<string, string>)) {
    rows.push({ platform, status: "skipped", detail: String(reason) })
  }
  return rows
}

export function requestIds(data: any): string[] {
  const groups = data?.by_profile ? Object.values(data.by_profile as Record<string, any>) : [data]
  return groups.map((g: any) => g?.request_id).filter(Boolean).map(String)
}

/**
 * GET /api/v1/social-media/status/{request_id} → { status, results: [{platform, success, post_url, error_message, error_code}] }.
 * Returns null while the job is still running.
 */
export function statusRows(data: any): PlatformRow[] | null {
  // An unknown id (or a vendor error) comes back HTTP 200 + {success:false, error} with no status.
  if (data?.success === false && !data?.status) return [{ platform: "?", status: "failed", detail: String(data?.error ?? data?.message ?? "status lookup failed").split("\n")[0] }]
  const st = String(data?.status ?? "").toLowerCase()
  const list = Array.isArray(data?.results) ? data.results : []
  if (!["completed", "complete", "failed", "error", "done", "finished"].includes(st)) return null
  if (!list.length) return st === "failed" || st === "error" ? [{ platform: "?", status: "failed", detail: String(data?.error ?? data?.message ?? st) }] : []
  return list.map((r: any) => outcome(String(r?.platform ?? "?"), r))
}

/** Replace "submitted" rows with what the status endpoint says, polling until done or out of time. */
export async function resolveSubmitted(
  rows: PlatformRow[],
  ids: string[],
  get: (id: string) => Promise<any>,
  opts: { timeoutMs: number; intervalMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<{ rows: PlatformRow[]; pending: string[] }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const done = new Map<string, PlatformRow[]>()
  const deadline = Date.now() + opts.timeoutMs
  while (done.size < ids.length) {
    for (const id of ids) {
      if (done.has(id)) continue
      const resp = await get(id).catch(() => null)
      // A lookup error mid-upload is not the job's outcome — keep asking until the deadline.
      if (!resp || (resp.success === false && !resp.status)) continue
      const r = statusRows(resp)
      if (r) done.set(id, r)
    }
    if (done.size === ids.length || Date.now() >= deadline) break
    await sleep(opts.intervalMs)
  }
  const resolved = [...done.values()].flat()
  const byPlatform = new Map(resolved.map((r) => [r.platform, r]))
  const out = rows.map((r) => (r.status === "submitted" && byPlatform.has(r.platform) ? { ...byPlatform.get(r.platform)!, profile: r.profile } : r))
  // A platform the job reported that the request did not list (rare) is still shown.
  for (const r of resolved) if (!out.some((o) => o.platform === r.platform)) out.push(r)
  return { rows: out, pending: ids.filter((id) => !done.has(id)) }
}

/** 0 = every requested platform posted (skips are reported, not failures) · 1 = one failed · 3 = still running at the timeout. */
export function exitCodeFor(rows: PlatformRow[]): number {
  if (rows.some((r) => r.status === "failed")) return 1
  if (rows.some((r) => r.status === "submitted")) return 3
  return 0
}

export const PlatformPostCommand = cmd({
  command: "post [text]",
  describe: "publish a post to social platforms (upload-post primary, Buffer fallback)",
  builder: (y) =>
    y
      .positional("text", { type: "string", describe: "post text / caption" })
      .option("to", { type: "string", describe: "comma-separated platforms (x, instagram, threads, tiktok, youtube, linkedin), or 'all' with --brand. Default: x; with --brand: all" })
      .option("brand", { type: "string", describe: "post as this brand's accounts (slug, e.g. heyiris) — see: iris social accounts" })
      .option("profile", { type: "string", describe: "upload-post profile username (e.g. freelabelnet)", default: process.env.IRIS_SOCIAL_PROFILE })
      .option("video", { type: "string", describe: "video URL to publish" })
      .option("image", { type: "array", describe: "image URL(s) to publish (repeatable)", string: true })
      .option("caption", { type: "string", describe: "caption for video/image (overrides text)" })
      .option("media-type", { type: "string", choices: ["REELS", "STORIES"], describe: "Instagram/Facebook placement for a video" })
      .option("wait", { type: "number", default: 300, describe: "seconds to wait for a background upload's per-platform result (0 = don't wait)" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Post")

    const brand = args.brand ? String(args.brand) : undefined
    // --brand names the accounts, so a stray IRIS_SOCIAL_PROFILE must not override them.
    const profile = args.profile && !(brand && args.profile === process.env.IRIS_SOCIAL_PROFILE) ? String(args.profile) : undefined
    const to = String(args.to ?? (brand ? "all" : "x")).trim().toLowerCase()

    let platforms: string[]
    const preSkipped: { platform: string; reason: string }[] = []
    if (to === "all") {
      if (!brand) {
        prompts.log.error("--to all needs --brand <slug> — it means every account connected for that brand")
        prompts.outro("Done")
        return
      }
      try {
        const b = findBrand(await fetchAccounts(), brand)
        if (!b) {
          prompts.log.error(`No accounts for brand '${brand}' — see: iris social accounts`)
          prompts.outro("Done")
          return
        }
        const t = connectedTargets(b)
        platforms = t.platforms
        preSkipped.push(...t.skipped)
      } catch (e) {
        prompts.log.error(e instanceof Error ? e.message : String(e))
        prompts.outro("Done")
        return
      }
      if (!platforms.length) {
        prompts.log.error(`Brand '${brand}' has no connected account to post to.`)
        for (const s of preSkipped) console.log(`  ${dim(s.platform.padEnd(10))} ${s.reason}`)
        prompts.outro("Done")
        return
      }
    } else {
      platforms = to.split(",").map((p) => p.trim()).filter(Boolean)
    }

    const built = buildPostBody({
      platforms,
      brand,
      profile,
      text: args.text ? String(args.text) : undefined,
      caption: args.caption ? String(args.caption) : undefined,
      video: args.video ? String(args.video) : undefined,
      images: Array.isArray(args.image) ? (args.image as string[]).map(String) : [],
      mediaType: args.mediaType ? String(args.mediaType) : undefined,
    })
    if ("error" in built) {
      prompts.log.error(built.error)
      prompts.outro("Done")
      return
    }
    const { body, kind } = built

    const as = brand ? `brand ${brand}` : `@${profile}`
    const sp = prompts.spinner()
    sp.start(`Publishing ${kind} to ${platforms.join(", ")} as ${as}…`)

    try {
      const res = await irisFetch("/api/v1/social-media/publish", {
        method: "POST",
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => ({}))) as any
      let rows: PlatformRow[] = [...publishRows(data, platforms), ...preSkipped.map((s) => ({ platform: s.platform, status: "skipped" as const, detail: s.reason }))]

      // The top-level `success` is not the outcome — a platform can fail inside a "successful"
      // response — so the rows decide, and a background job is followed to its end.
      const ids = requestIds(data)
      const waitS = Number(args.wait ?? 300)
      let pending: string[] = []
      if (res.ok && ids.length && rows.some((r) => r.status === "submitted") && waitS > 0) {
        sp.message(`Uploading in the background — waiting up to ${waitS}s for each platform…`)
        const r = await resolveSubmitted(rows, ids, async (id) => {
          const s = await irisFetch(`/api/v1/social-media/status/${encodeURIComponent(id)}`)
          return s.json()
        }, { timeoutMs: waitS * 1000, intervalMs: 5000 })
        rows = r.rows
        pending = r.pending
      }

      const code = !res.ok ? 1 : exitCodeFor(rows)
      sp.stop(code === 0 ? "Published" : code === 3 ? "Still uploading" : "Failed", code === 0 ? 0 : 1)
      if (!res.ok) {
        prompts.log.error(`Publish failed (HTTP ${res.status}): ${data?.message ?? data?.error ?? "unknown error"}`)
        if (data?.primary_error) console.log(dim(`  primary: ${data.primary_error}`))
        if (data?.fallback_error) console.log(dim(`  fallback: ${data.fallback_error}`))
      } else {
        const provider = data.provider_used ?? Object.values(data.by_profile ?? {}).map((g: any) => g?.provider_used).filter(Boolean).join(", ")
        const viaFallback = data.fallback_used ? " (via Buffer fallback)" : ""
        console.log()
        console.log(`  ${bold(kind)}${provider ? ` via ${highlight(provider)}` : ""}${viaFallback}`)
      }
      for (const r of rows) printRow(r)
      for (const id of pending) console.log(`  ${dim("still running — check:")} iris social status ${id}`)
      process.exitCode = code
      prompts.outro("Done")
    } catch (e) {
      sp.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      process.exitCode = 1
      prompts.outro("Done")
    }
  },
})

export function printRow(r: PlatformRow) {
  const mark = r.status === "posted" ? success("✓") : r.status === "submitted" ? highlight("…") : r.status === "skipped" ? warn("–") : warn("✗")
  const who = r.profile ? dim(` @${r.profile.replace(/^@+/, "")}`) : ""
  console.log(`  ${mark} ${r.platform.padEnd(10)} ${r.status}${who}${r.detail ? dim("  " + r.detail) : ""}`)
}
