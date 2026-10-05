import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, dim, bold, success, highlight } from "./iris-api"

/**
 * `iris post` — publish a post to social platforms through fl-api's unified,
 * failover-protected endpoint (upload-post primary → Buffer fallback).
 *
 *   iris post "gm ☀️" --to x --profile freelabelnet
 *   iris post --video https://cdn/clip.mp4 --caption "new drop" --to x --profile freelabelnet
 *   iris post --image https://cdn/a.png --image https://cdn/b.png --to x,instagram --profile freelabelnet
 *
 * Backs the same POST /api/v1/social-media/publish the Review Studio "Publish"
 * button uses, so CLI + UI share one bulletproof path. (bug #165862)
 */
export const PlatformPostCommand = cmd({
  command: "post [text]",
  describe: "publish a post to social platforms (upload-post primary, Buffer fallback)",
  builder: (y) =>
    y
      .positional("text", { type: "string", describe: "post text / caption" })
      .option("to", { type: "string", describe: "comma-separated platforms (x, instagram, threads, tiktok, youtube, linkedin)", default: "x" })
      .option("profile", { type: "string", describe: "upload-post profile username (e.g. freelabelnet)", default: process.env.IRIS_SOCIAL_PROFILE })
      .option("video", { type: "string", describe: "video URL to publish" })
      .option("image", { type: "array", describe: "image URL(s) to publish (repeatable)", string: true })
      .option("caption", { type: "string", describe: "caption for video/image (overrides text)" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Post")

    const platforms = String(args.to ?? "x")
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean)
    const profile = args.profile ? String(args.profile) : undefined
    const text = args.text ? String(args.text) : undefined
    const caption = args.caption ? String(args.caption) : undefined
    const video = args.video ? String(args.video) : undefined
    const images = Array.isArray(args.image) ? (args.image as string[]).map(String) : []

    if (!platforms.length) {
      prompts.log.error("No platforms — pass --to x[,instagram,...]")
      prompts.outro("Done")
      return
    }
    if (!profile) {
      prompts.log.error("No profile — pass --profile <upload-post username> (or set IRIS_SOCIAL_PROFILE)")
      prompts.outro("Done")
      return
    }

    // Build the body: video → photos → text (mirrors the server's detection).
    const body: Record<string, unknown> = { user: profile, platforms }
    let kind: string
    if (video) {
      body.video_url = video
      body.title = caption ?? text ?? ""
      kind = "video"
    } else if (images.length) {
      body.photo_urls = images
      body.title = caption ?? text ?? ""
      kind = images.length > 1 ? "carousel" : "image"
    } else if (text) {
      body.text = text
      kind = "text"
    } else {
      prompts.log.error("Nothing to post — pass text, --video <url>, or --image <url>")
      prompts.outro("Done")
      return
    }

    const sp = prompts.spinner()
    sp.start(`Publishing ${kind} to ${platforms.join(", ")} as @${profile}…`)

    try {
      const res = await irisFetch("/api/v1/social-media/publish", {
        method: "POST",
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => ({}))) as any

      if (!res.ok || !data?.success) {
        sp.stop("Failed", 1)
        prompts.log.error(`Publish failed (HTTP ${res.status}): ${data?.message ?? data?.error ?? "unknown error"}`)
        if (data?.primary_error) console.log(dim(`  primary: ${data.primary_error}`))
        if (data?.fallback_error) console.log(dim(`  fallback: ${data.fallback_error}`))
        prompts.outro("Done")
        return
      }

      sp.stop("Published")
      const provider = data.provider_used ?? "?"
      const viaFallback = data.fallback_used ? " (via Buffer fallback)" : ""
      console.log()
      console.log(`  ${success("✓")} ${bold(kind)} posted via ${highlight(provider)}${viaFallback}`)

      // Surface each platform's post URL when present.
      const results = (data.results ?? {}) as Record<string, any>
      for (const [plat, r] of Object.entries(results)) {
        if (r?.url) console.log(`  ${dim(plat + ":")} ${r.url}`)
      }
      if (data.request_id) console.log(`  ${dim("request_id:")} ${data.request_id}`)
      prompts.outro("Done")
    } catch (e) {
      sp.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})
