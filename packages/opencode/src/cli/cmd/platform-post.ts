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
 * One row per platform from the publish response, whichever shape it came back in:
 *   single profile  { success, results: {platform: {...}}, request_id?, skipped? }
 *   several         { success, by_profile: {profile: <single shape>}, skipped }
 * Platforms the server skipped (no enabled account for the brand) are rows too — never dropped.
 */
export function publishRows(data: any, requested: string[]): PlatformRow[] {
  const rows: PlatformRow[] = []
  const groups: [string | undefined, any][] = data?.by_profile
    ? Object.entries(data.by_profile as Record<string, any>)
    : [[undefined, data]]
  const seen = new Set<string>()
  for (const [profile, g] of groups) {
    const results = (g?.results ?? {}) as Record<string, any>
    for (const [platform, r] of Object.entries(results)) {
      seen.add(platform)
      const ok = r?.success !== false && !r?.error
      rows.push({ platform, profile, status: ok ? "posted" : "failed", detail: ok ? (r?.url ?? r?.post_url ?? undefined) : String(r?.error ?? r?.message ?? "failed") })
    }
  }
  // Async upload-post jobs answer with a request_id and no per-platform results yet, and the
  // by_profile shape does not say which platforms each group carried — so every requested
  // platform the server neither reported nor skipped takes the overall outcome.
  const ids = groups.map(([, g]) => g?.request_id).filter(Boolean)
  for (const platform of requested) {
    if (seen.has(platform) || data?.skipped?.[platform]) continue
    rows.push({
      platform,
      status: data?.success ? "submitted" : "failed",
      detail: data?.success ? (ids.length ? `request ${ids.join(", ")}` : undefined) : String(data?.error ?? data?.message ?? "failed"),
    })
  }
  for (const [platform, reason] of Object.entries((data?.skipped ?? {}) as Record<string, string>)) {
    rows.push({ platform, status: "skipped", detail: String(reason) })
  }
  return rows
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
      .option("media-type", { type: "string", choices: ["REELS", "STORIES"], describe: "Instagram/Facebook placement for a video" }),
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
      const rows = [...publishRows(data, platforms), ...preSkipped.map((s) => ({ platform: s.platform, status: "skipped" as const, detail: s.reason }))]

      if (!res.ok || !data?.success) {
        sp.stop("Failed", 1)
        prompts.log.error(`Publish failed (HTTP ${res.status}): ${data?.message ?? data?.error ?? "unknown error"}`)
        if (data?.primary_error) console.log(dim(`  primary: ${data.primary_error}`))
        if (data?.fallback_error) console.log(dim(`  fallback: ${data.fallback_error}`))
        for (const r of rows) printRow(r)
        prompts.outro("Done")
        return
      }

      sp.stop("Published")
      const provider = data.provider_used ?? Object.values(data.by_profile ?? {}).map((g: any) => g?.provider_used).filter(Boolean).join(", ") ?? "?"
      const viaFallback = data.fallback_used ? " (via Buffer fallback)" : ""
      console.log()
      console.log(`  ${success("✓")} ${bold(kind)} posted via ${highlight(provider || "?")}${viaFallback}`)
      for (const r of rows) printRow(r)
      if (data.request_id) console.log(`  ${dim("request_id:")} ${data.request_id}`)
      prompts.outro("Done")
    } catch (e) {
      sp.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})

function printRow(r: PlatformRow) {
  const mark = r.status === "posted" ? success("✓") : r.status === "submitted" ? highlight("…") : r.status === "skipped" ? warn("–") : warn("✗")
  const who = r.profile ? dim(` @${r.profile.replace(/^@+/, "")}`) : ""
  console.log(`  ${mark} ${r.platform.padEnd(10)} ${r.status}${who}${r.detail ? dim("  " + r.detail) : ""}`)
}
