import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { IRIS_API, loadIrisSdkEnvSync, dim, bold, printDivider, writeJson } from "./iris-api"
import * as fs from "fs"
import { firstArray } from "../../util/array"

// ============================================================================
// Instagram feed seeding — the repeatable version of a one-off script.
//
// The Genesis InstagramFeed component reads /api/instagram/{handle}/feed on
// iris-api, which serves a CDN-backed cache. Populating that cache is the hard
// part, and it has one non-obvious constraint:
//
//   INSTAGRAM BLOCKS DATACENTRE IPs. The server cannot fetch its own feed from
//   Railway, so the scrape has to originate from a RESIDENTIAL connection —
//   i.e. the operator's machine, or a Hive node on a home line. The server then
//   mirrors the images to our CDN and caches them for 30 days.
//
// This was previously done by hand with a throwaway /tmp/ig-seed.js, which is
// why the moody-beauty feed cannot self-refresh and why nobody could repeat it.
// This command is that script, made repeatable and honest about its limits.
//
// SECOND GOTCHA, learned the hard way: sending a saved (flagged/limited) IG
// session returns a valid-looking {"status":"ok"} with NO user payload. Cookieless
// works. So this deliberately sends no cookies — see fetchProfile().
// ============================================================================

/** Instagram's own web client id. Sent unauthenticated; this is not a secret. */
const IG_APP_ID = "936619743392459"

function irisApiKey(): string | null {
  return process.env.IRIS_API_KEY || loadIrisSdkEnvSync()["IRIS_API_KEY"] || null
}

/**
 * Fetch a public profile's timeline, COOKIELESS.
 *
 * Deliberately sends no Cookie header: a flagged session yields {"status":"ok"}
 * with an empty payload, which is far worse than a hard failure because it looks
 * like the account simply has no posts.
 */
async function fetchProfile(handle: string): Promise<any> {
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`
  const res = await fetch(url, {
    headers: {
      "x-ig-app-id": IG_APP_ID,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(20000),
  })

  if (!res.ok) {
    // Report what Instagram ACTUALLY said. Guessing "rate limited" sent an earlier
    // investigation down the wrong path for a failure that was neither our IP nor our
    // request: their backend returns a deleted-schema error that no retry will fix.
    let igMessage = ""
    try { igMessage = ((await res.json()) as any)?.message ?? "" } catch { /* body not json */ }

    const hint =
      res.status === 401 || res.status === 403
        ? "Usually a datacentre IP — run from a residential connection."
        : res.status === 400 && igMessage.includes("has been deleted")
          ? "This is an INSTAGRAM-SIDE fault, not ours. web_profile_info is broken upstream; " +
            "use --from with browser-extracted data until it returns."
          : "Instagram rate-limits aggressively; retry shortly."

    throw new Error(`Instagram returned HTTP ${res.status}${igMessage ? ` — ${igMessage}` : ""}. ${hint}`)
  }

  const body: any = await res.json()
  const user = body?.data?.user
  if (!user) {
    // The exact failure the moody-beauty seeding hit. Name it rather than
    // reporting "0 posts", which reads as an empty account.
    throw new Error(
      "Instagram returned no user payload. That is the signature of a blocked or rate-limited " +
        "request (or a flagged session). Retry from a residential IP with no VPN.",
    )
  }
  return user
}

/** Shape the raw profile into the {stats, posts} contract the seed endpoint expects. */
function shapeFeed(user: any, handle: string, limit: number) {
  const media = user.edge_owner_to_timeline_media ?? {}
  const edges: any[] = firstArray(media.edges)

  const stats = {
    posts: media.count ?? 0,
    followers: user.edge_followed_by?.count ?? 0,
    following: user.edge_follow?.count ?? 0,
    full_name: user.full_name ?? handle,
    profile_pic: user.profile_pic_url_hd ?? user.profile_pic_url ?? null,
    is_private: user.is_private ?? false,
    username: handle,
  }

  const posts = edges.slice(0, limit).map((edge) => {
    const n = edge?.node ?? {}
    return {
      id: n.id ?? null,
      shortcode: n.shortcode ?? null,
      thumbnail_url: n.thumbnail_src ?? n.display_url ?? null,
      display_url: n.display_url ?? null,
      is_video: n.is_video ?? false,
      caption: n.edge_media_to_caption?.edges?.[0]?.node?.text ?? "",
      likes: n.edge_liked_by?.count ?? n.edge_media_preview_like?.count ?? 0,
      comments: n.edge_media_to_comment?.count ?? 0,
      timestamp: n.taken_at_timestamp ?? null,
      link: n.shortcode ? `https://instagram.com/p/${n.shortcode}/` : null,
    }
  })

  return { stats, posts, availableOnProfile: edges.length }
}

const FeedSeedCommand = cmd({
  command: "seed <handle>",
  aliases: ["refresh"],
  describe: "scrape a public IG profile from THIS machine and cache it for the Genesis feed",
  builder: (y) =>
    y
      .positional("handle", { type: "string", demandOption: true, describe: "IG handle, with or without @" })
      .option("limit", { type: "number", default: 12, describe: "max posts to cache" })
      .option("from", {
        type: "string",
        describe: "seed from a JSON file of already-extracted posts instead of calling Instagram " +
          "(use when the public API is down — see docs/instagram-feed.md)",
      })
      .option("out", { type: "string", describe: "also write the raw payload to a file" })
      .option("dry-run", { type: "boolean", default: false, describe: "scrape and report, cache nothing" })
      .option("json", { type: "boolean", default: false })
      .example("$0 instagram feed seed _aisquared --limit 19", "cache AIAI Holdings' posts"),
  async handler(args) {
    UI.empty()
    const handle = String(args.handle).replace(/^@/, "")
    prompts.intro(`◈  Instagram feed seed: @${handle}`)

    let stats: any
    let posts: any[]
    let availableOnProfile: number

    if (args.from) {
      // Offline path: a payload extracted by a browser (the only method that works while
      // Instagram's public profile API is returning a server-side schema error).
      if (!fs.existsSync(String(args.from))) {
        prompts.log.error(`File not found: ${args.from}`)
        prompts.outro("Done")
        return
      }
      const raw = JSON.parse(fs.readFileSync(String(args.from), "utf8"))
      const payload = raw?.instagram ?? raw
      stats = payload?.stats
      posts = (payload?.posts ?? []).slice(0, Number(args.limit))
      availableOnProfile = payload?.posts?.length ?? posts.length

      if (!stats || !Array.isArray(posts) || posts.length === 0) {
        prompts.log.error("File must contain {stats, posts:[...]} (or {instagram:{stats, posts}}).")
        prompts.outro("Done")
        return
      }
      console.log(`  ${dim(`Source: ${args.from} (browser-extracted, not a live scrape)`)}`)
    } else {
      let user: any
      try {
        user = await fetchProfile(handle)
      } catch (e: any) {
        prompts.log.error(e.message)
        prompts.outro("Done")
        return
      }
      ;({ stats, posts, availableOnProfile } = shapeFeed(user, handle, Number(args.limit)))
    }

    printDivider()
    console.log(`  ${bold("Account")}   ${stats.full_name} ${dim("@" + handle)}`)
    console.log(`  ${bold("Profile")}   ${stats.posts} posts · ${stats.followers} followers`)
    console.log(`  ${bold("Fetched")}   ${posts.length} of ${availableOnProfile} returned by Instagram`)

    // Instagram's web endpoint returns a page of recent media, not the whole
    // history. Say so, rather than letting a partial cache look complete.
    if (stats.posts > availableOnProfile) {
      console.log(
        `  ${dim(`NOTE: the profile has ${stats.posts} posts; this endpoint returned ${availableOnProfile}. ` +
          `Older posts need pagination and are not cached.`)}`,
      )
    }
    printDivider()

    for (const p of posts.slice(0, 5)) {
      const when = p.timestamp ? new Date(p.timestamp * 1000).toISOString().slice(0, 10) : "?"
      const caption = (p.caption || "").replace(/\s+/g, " ").slice(0, 62)
      console.log(`  ${dim(when)}  ${p.is_video ? "video" : "image"}  ${caption}${caption.length >= 62 ? "…" : ""}`)
    }
    if (posts.length > 5) console.log(`  ${dim(`… ${posts.length - 5} more`)}`)

    if (args.out) {
      fs.writeFileSync(String(args.out), JSON.stringify({ stats, posts }, null, 2))
      console.log(`\n  ${bold("Wrote")}     ${args.out}`)
    }

    if (args["dry-run"]) {
      printDivider()
      console.log(`  ${dim("Dry run — nothing cached.")}`)
      prompts.outro("Done")
      return
    }

    const key = irisApiKey()
    if (!key) {
      prompts.log.error("No IRIS_API_KEY (env or ~/.iris/sdk/.env) — required to write the feed cache.")
      prompts.outro("Done")
      return
    }

    const res = await fetch(`${IRIS_API}/api/instagram/${encodeURIComponent(handle)}/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Api-Key": key },
      body: JSON.stringify({ instagram: { stats, posts } }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      prompts.log.error(`Seed failed: HTTP ${res.status} ${text.slice(0, 200)}`)
      prompts.outro("Done")
      return
    }

    const body: any = await res.json()
    if (args.json) {
      await writeJson(body)
      prompts.outro("Done")
      return
    }

    printDivider()
    console.log(`  ${bold("Cached")}    ${body?.posts_cached ?? "?"} post(s), images mirrored to our CDN`)
    console.log(`  ${bold("TTL")}       30 days`)
    // The feed cannot refresh itself: the server is blocked from Instagram, which
    // is the whole reason this command runs locally. Stale data looks identical to
    // fresh data, so the expiry is stated rather than left to be discovered.
    console.log(`  ${dim("The server CANNOT refresh this itself (datacentre IPs are blocked).")}`)
    console.log(`  ${dim("Re-run this from a residential connection to keep the feed current.")}`)
    printDivider()
    prompts.outro("Done")
  },
})

const FeedShowCommand = cmd({
  command: "show <handle>",
  aliases: ["get"],
  describe: "read back the cached feed the Genesis component will render",
  builder: (y) =>
    y.positional("handle", { type: "string", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const handle = String(args.handle).replace(/^@/, "")
    prompts.intro(`◈  Cached feed: @${handle}`)

    const res = await fetch(`${IRIS_API}/api/instagram/${encodeURIComponent(handle)}/feed`, {
      headers: { Accept: "application/json" },
    })
    if (!res.ok) {
      prompts.log.error(`HTTP ${res.status} — nothing cached yet? Try: iris instagram feed seed ${handle}`)
      prompts.outro("Done")
      return
    }

    const body: any = await res.json()
    if (args.json) { await writeJson(body); prompts.outro("Done"); return }

    const data = body?.instagram ?? body?.data ?? body
    const posts: any[] = firstArray(data?.posts)

    printDivider()
    console.log(`  ${bold("Posts cached")}  ${posts.length}`)
    if (posts.length === 0) {
      console.log(`  ${dim("Empty — the component will render nothing. Seed it from a residential connection.")}`)
    }
    for (const p of posts.slice(0, 8)) {
      const onCdn = String(p.thumbnail_url ?? "").includes("cdn.heyiris.io")
      const when = p.timestamp ? new Date(p.timestamp * 1000).toISOString().slice(0, 10) : "?"
      // An image still pointing at Instagram's CDN will rot when the signed URL
      // expires, so surface where each thumbnail actually lives.
      console.log(`  ${dim(when)}  ${onCdn ? "cdn" : bold("ig")}  ${(p.caption || "").replace(/\s+/g, " ").slice(0, 56)}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

export const PlatformInstagramFeedCommand = cmd({
  command: "instagram:feed",
  aliases: ["ig-feed"],
  describe: "Cache a public IG profile for the Genesis InstagramFeed component",
  builder: (y) => y.command(FeedSeedCommand).command(FeedShowCommand).demandCommand(),
  async handler() {},
})
