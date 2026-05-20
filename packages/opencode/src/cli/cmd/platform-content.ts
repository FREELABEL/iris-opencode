import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  requireUserId,
  handleApiError,
  dim,
  bold,
  success,
  FL_API,
} from "./iris-api"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join } from "path"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SYNC_DIR = "content"

function resolveSyncDir(): string {
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "fl-docker-dev"))) return join(dir, SYNC_DIR)
    const parent = join(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return join(process.cwd(), SYNC_DIR)
}

function contentFilename(type: string, id: number | string): string {
  return `${type}-${id}.json`
}

function findLocalFile(dir: string, type: string, id: number | string): string | undefined {
  const name = contentFilename(type, id)
  const full = join(dir, name)
  return existsSync(full) ? full : undefined
}

function detectContentType(url: string): { type: string; mediaId?: string } {
  if (/youtube\.com|youtu\.be/.test(url)) {
    const id = url.match(/(?:v=|\/live\/|youtu\.be\/|\/shorts\/|\/embed\/)([^?&#]+)/)?.[1]
    return { type: "video", mediaId: id }
  }
  if (/spotify\.com\/track/.test(url)) return { type: "track" }
  if (/soundcloud\.com/.test(url)) return { type: "track" }
  if (/instagram\.com\/reel/.test(url)) return { type: "video" }
  if (/tiktok\.com/.test(url)) return { type: "video" }
  if (/\.(mp4|mov|avi|webm)$/i.test(url)) return { type: "video" }
  if (/\.(mp3|wav|flac|ogg)$/i.test(url)) return { type: "track" }
  return { type: "unknown" }
}

async function resolveProfileId(
  nameOrPk: string,
  userId: number,
): Promise<{ pk: number; name: string } | null> {
  // Numeric = exact pk
  if (/^\d+$/.test(nameOrPk)) {
    return { pk: Number(nameOrPk), name: `Profile #${nameOrPk}` }
  }
  // Search by name
  const params = new URLSearchParams({ search: nameOrPk })
  const res = await irisFetch(`/api/v1/my/profiles?${params}`)
  if (!res.ok) return null
  const body = (await res.json()) as any
  const profiles = body?.data ?? body
  if (!Array.isArray(profiles) || profiles.length === 0) return null
  if (profiles.length === 1) return { pk: profiles[0].pk, name: profiles[0].name }

  // Multiple matches — pick interactively or first in non-interactive
  const isTTY = process.stdout.isTTY
  if (!isTTY) return { pk: profiles[0].pk, name: profiles[0].name }

  const choice = await prompts.select({
    message: "Multiple profiles match. Pick one:",
    options: profiles.slice(0, 5).map((p: any) => ({
      value: String(p.pk),
      label: `${p.name} (pk=${p.pk}) ${p.instagram ?? ""}`,
    })),
  })
  if (prompts.isCancel(choice)) return null
  const picked = profiles.find((p: any) => String(p.pk) === choice)
  return picked ? { pk: picked.pk, name: picked.name } : null
}

async function verifyUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" })
    return res.ok
  } catch {
    return false
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s
}

const commonOpts = (yargs: any) =>
  yargs
    .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
    .option("json", { describe: "output raw JSON", type: "boolean", default: false })

// ---------------------------------------------------------------------------
// Subcommands: Profiles
// ---------------------------------------------------------------------------

const ProfilesListCommand = cmd({
  command: "list",
  describe: "list YOUR content profiles (user-scoped)",
  builder: (y: any) =>
    commonOpts(y).option("search", { alias: "s", describe: "filter by name", type: "string" }),
  async handler(args: any) {
    UI.empty()
    prompts.intro(`${bold("content profiles list")}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading profiles...")
    try {
      const params = new URLSearchParams()
      if (args.search) params.set("search", args.search)
      const res = await irisFetch(`/api/v1/my/profiles?${params}`)
      const ok = await handleApiError(res, "my/profiles")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const profiles = body?.data ?? body
      spinner.stop(`${profiles.length} profile(s)`)

      if (args.json) {
        console.log(JSON.stringify(profiles, null, 2))
      } else {
        if (!Array.isArray(profiles) || profiles.length === 0) {
          prompts.log.info("No profiles found.")
        } else {
          console.log()
          console.log(
            `  ${dim("pk".padEnd(8))}${dim("name".padEnd(25))}${dim("city".padEnd(15))}${dim("ig".padEnd(18))}${dim("vid")}  ${dim("art")}  ${dim("trk")}`,
          )
          for (const p of profiles) {
            const pk = String(p.pk).padEnd(8)
            const name = truncate(p.name ?? "", 23).padEnd(25)
            const city = truncate(p.city ?? "", 13).padEnd(15)
            const ig = truncate(p.instagram ?? "", 16).padEnd(18)
            const vid = String(p.videos_count ?? 0).padStart(3)
            const art = String(p.articles_count ?? 0).padStart(3)
            const trk = String(p.tracks_count ?? 0).padStart(3)
            console.log(`  ${bold(pk)}${name}${city}${ig}${vid}  ${art}  ${trk}`)
          }
        }
      }
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const ProfilesGetCommand = cmd({
  command: "get <name>",
  describe: "show profile detail + content counts",
  builder: (y: any) => commonOpts(y).positional("name", { type: "string", demandOption: true }),
  async handler(args: any) {
    UI.empty()
    prompts.intro(`${bold("content profiles get")}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Resolving profile...")
    const profile = await resolveProfileId(args.name, userId)
    if (!profile) {
      spinner.stop("Not found", 1)
      prompts.log.error(`No profile matching '${args.name}'. Run: iris content profiles list`)
      prompts.outro("Done")
      return
    }

    // Fetch full profile detail
    const res = await irisFetch(`/api/v1/profile/${profile.pk}`)
    const ok = await handleApiError(res, "profile get")
    if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
    const body = (await res.json()) as any
    const p = body?.data ?? body
    spinner.stop("Done")

    if (args.json) {
      console.log(JSON.stringify(p, null, 2))
    } else {
      console.log()
      console.log(`  ${dim("pk:")} ${bold(String(p.pk))}`)
      console.log(`  ${dim("name:")} ${p.name}`)
      console.log(`  ${dim("bio:")} ${truncate(p.bio ?? "", 200)}`)
      console.log(`  ${dim("city:")} ${p.city ?? ""} ${p.state ?? ""}`)
      console.log(`  ${dim("instagram:")} ${p.instagram ?? ""}`)
      console.log(`  ${dim("twitter:")} ${p.twitter ?? ""}`)
      console.log(`  ${dim("photo:")} ${p.photo ?? ""}`)
      const publicUrl = p.public_url ?? p.getPublicURL?.() ?? ""
      if (publicUrl) {
        const urlOk = await verifyUrl(publicUrl)
        console.log(`  ${dim("public_url:")} ${publicUrl} ${urlOk ? success("200 OK") : "\x1b[31m! unreachable\x1b[0m"}`)
      }
    }
    prompts.outro("Done")
  },
})

const ProfilesCommand = cmd({
  command: "profiles",
  describe: "manage content creator profiles",
  builder: (yargs: any) =>
    yargs
      .command(ProfilesListCommand)
      .command(ProfilesGetCommand)
      .demandCommand(),
  async handler() {},
})

// ---------------------------------------------------------------------------
// Subcommands: Upload
// ---------------------------------------------------------------------------

const UploadCommand = cmd({
  command: "upload <url>",
  describe: "smart upload (auto-detect type + metadata from URL)",
  builder: (y: any) =>
    commonOpts(y)
      .positional("url", { type: "string", demandOption: true })
      .option("profile", { alias: "p", describe: "profile name or pk", type: "string", demandOption: true })
      .option("type", { describe: "force content type", type: "string", choices: ["video", "article", "track"] })
      .option("title", { describe: "override title", type: "string" })
      .option("description", { describe: "override description", type: "string" })
      .option("draft", { describe: "create as draft (status=0)", type: "boolean", default: false })
      .option("publish", { describe: "also publish to social (comma-separated: ig,tiktok,x)", type: "string" }),
  async handler(args: any) {
    UI.empty()
    prompts.intro(`${bold("content upload")}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    // Guard: profile is required
    if (!args.profile) {
      prompts.log.error("--profile is required. Specify a profile name or pk.")
      prompts.outro("Done")
      return
    }

    // 1. Detect content type
    const detected = detectContentType(args.url)
    const contentType = args.type ?? detected.type
    if (contentType === "unknown") {
      prompts.log.error("Could not detect content type from URL. Use --type video|article|track")
      prompts.outro("Done")
      return
    }

    // 2. Resolve profile
    const spinner = prompts.spinner()
    spinner.start("Resolving profile...")
    const profile = await resolveProfileId(args.profile, userId)
    if (!profile) {
      spinner.stop("Not found", 1)
      prompts.log.error(`No profile matching '${args.profile}'. Run: iris content profiles list`)
      prompts.outro("Done")
      return
    }
    spinner.stop(`Profile: ${profile.name} (pk=${profile.pk})`)

    // 3. Fetch metadata (YouTube auto-populate)
    let title = args.title ?? ""
    let description = args.description ?? ""
    const mediaId = detected.mediaId ?? ""

    if (contentType === "video" && detected.mediaId && !args.title) {
      const metaSpinner = prompts.spinner()
      metaSpinner.start("Fetching YouTube metadata...")
      try {
        // The API expects media_url (full URL), not just the video ID
        const ytUrl = `https://www.youtube.com/watch?v=${detected.mediaId}`
        const ytRes = await irisFetch(`/api/youtube/get-video-data?media_url=${encodeURIComponent(ytUrl)}`)
        if (ytRes.ok) {
          const ytBody = (await ytRes.json()) as any
          const ytData = ytBody?.data?.video ?? ytBody?.data ?? ytBody
          title = title || ytData?.title || ""
          description = description || ytData?.description || ytData?.channelTitle || ""
          metaSpinner.stop(title ? `"${truncate(title, 60)}"` : "No metadata")
        } else {
          metaSpinner.stop("No YouTube metadata", 1)
        }
      } catch {
        metaSpinner.stop("Metadata fetch failed", 1)
      }
    }

    if (!title) {
      prompts.log.error("Title is required. Use --title or provide a YouTube URL for auto-detection.")
      prompts.outro("Done")
      return
    }

    // 4. Duplicate check
    if (contentType === "video" && mediaId) {
      const dupSpinner = prompts.spinner()
      dupSpinner.start("Checking for duplicates...")
      const dupRes = await irisFetch(`/api/v1/videos?profile_id=${profile.pk}&per_page=100`)
      if (dupRes.ok) {
        const dupBody = (await dupRes.json()) as any
        const videos = dupBody?.data?.data ?? dupBody?.data ?? []
        const existing = Array.isArray(videos) ? videos.find((v: any) => v.media_id === mediaId) : null
        if (existing) {
          dupSpinner.stop("Duplicate found")
          prompts.log.warn(`Video already exists: #${existing.id} "${existing.title}"`)
          prompts.log.info(`public_url: ${existing.public_url ?? `https://web.freelabel.net/content/video/${existing.id}`}`)
          prompts.outro("Done")
          return
        }
      }
      dupSpinner.stop("No duplicates")
    }

    // 5. Create record
    const createSpinner = prompts.spinner()
    createSpinner.start("Creating content record...")
    try {
      let createRes: Response
      if (contentType === "video") {
        createRes = await irisFetch("/api/v1/videos", {
          method: "POST",
          body: JSON.stringify({
            profile_id: profile.pk,
            title,
            description,
            media_id: mediaId,
            thumbnail_url: mediaId ? `https://i.ytimg.com/vi/${mediaId}/maxresdefault.jpg` : undefined,
            status: args.draft ? 0 : 1,
          }),
        })
      } else {
        // For tracks/articles, use generic content endpoint
        createRes = await irisFetch(`/api/v1/${contentType}s`, {
          method: "POST",
          body: JSON.stringify({
            profile_id: profile.pk,
            title,
            description,
            media_id: mediaId || args.url,
            status: args.draft ? 0 : 1,
          }),
        })
      }

      const createOk = await handleApiError(createRes, "create content")
      if (!createOk) { createSpinner.stop("Failed", 1); prompts.outro("Done"); return }
      const createBody = (await createRes.json()) as any
      const created = createBody?.data?.data ?? createBody?.data ?? createBody
      createSpinner.stop("Created")

      if (args.json) {
        console.log(JSON.stringify(created, null, 2))
      } else {
        console.log()
        console.log(`  ${dim("id:")} ${bold(String(created.id))}`)
        console.log(`  ${dim("title:")} ${created.title}`)
        console.log(`  ${dim("type:")} ${contentType}`)
        console.log(`  ${dim("profile:")} ${profile.name} (pk=${profile.pk})`)
        console.log(`  ${dim("status:")} ${args.draft ? "draft" : "published"}`)

        const publicUrl = `https://web.freelabel.net/content/${contentType}/${created.id}`
        const urlOk = await verifyUrl(publicUrl)
        console.log(`  ${dim("public_url:")} ${publicUrl} ${urlOk ? success("200 OK") : "\x1b[31m! unreachable\x1b[0m"}`)
      }

      // 6. Social publish bridge
      if (args.publish) {
        const platforms = args.publish.split(",").map((s: string) => s.trim())
        const pubSpinner = prompts.spinner()
        pubSpinner.start(`Publishing to ${platforms.join(", ")}...`)
        try {
          const pubRes = await irisFetch(`/api/v1/users/${userId}/integrations/execute`, {
            method: "POST",
            body: JSON.stringify({
              integration: "copycat-ai",
              action: "publish_to_social_media",
              parameters: {
                video_url: args.url,
                platforms,
                caption: title,
              },
            }),
          })
          const pubOk = await handleApiError(pubRes, "social publish")
          pubSpinner.stop(pubOk ? "Queued" : "Failed", pubOk ? 0 : 1)
        } catch {
          pubSpinner.stop("Publish failed", 1)
        }
      }

      prompts.outro("Done")
    } catch (err) {
      createSpinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ---------------------------------------------------------------------------
// Subcommands: List / Get / Delete / Search
// ---------------------------------------------------------------------------

const ListCommand = cmd({
  command: "list",
  describe: "list content (videos by default)",
  builder: (y: any) =>
    commonOpts(y)
      .option("type", { alias: "t", describe: "content type", type: "string", default: "video", choices: ["video", "article", "track"] })
      .option("profile", { alias: "p", describe: "filter by profile name or pk", type: "string" })
      .option("search", { alias: "s", describe: "search query", type: "string" }),
  async handler(args: any) {
    UI.empty()
    prompts.intro(`${bold("content list")}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    const params = new URLSearchParams({ per_page: "20" })

    // Resolve profile if provided
    if (args.profile) {
      spinner.start("Resolving profile...")
      const profile = await resolveProfileId(args.profile, userId)
      if (!profile) {
        spinner.stop("Not found", 1)
        prompts.log.error(`No profile matching '${args.profile}'.`)
        prompts.outro("Done")
        return
      }
      params.set("profile_id", String(profile.pk))
      spinner.stop(`Profile: ${profile.name}`)
    }

    const listSpinner = prompts.spinner()
    listSpinner.start("Loading...")
    try {
      const typeSlug = args.type === "video" ? "videos" : args.type === "track" ? "tracks" : "articles"
      const res = await irisFetch(`/api/v1/${typeSlug}?${params}`)
      const ok = await handleApiError(res, "list content")
      if (!ok) { listSpinner.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const items = body?.data?.data ?? body?.data ?? []
      const total = body?.data?.meta?.total ?? items.length
      listSpinner.stop(`${total} ${args.type}(s)`)

      if (args.json) {
        console.log(JSON.stringify(items, null, 2))
      } else if (!Array.isArray(items) || items.length === 0) {
        prompts.log.info(`No ${args.type}s found.`)
      } else {
        console.log()
        console.log(`  ${dim("id".padEnd(8))}${dim("title".padEnd(45))}${dim("views".padStart(8))}  ${dim("status")}`)
        for (const item of items) {
          const id = String(item.id).padEnd(8)
          const t = truncate(item.title ?? "", 43).padEnd(45)
          const views = String(item.views ?? 0).padStart(8)
          const status = item.status === 0 ? dim("(draft)") : ""
          console.log(`  ${bold(id)}${t}${views}  ${status}`)
        }
      }
      prompts.outro("Done")
    } catch (err) {
      listSpinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const GetCommand = cmd({
  command: "get <id>",
  describe: "show content detail + verified public_url",
  builder: (y: any) =>
    commonOpts(y)
      .positional("id", { type: "number", demandOption: true })
      .option("type", { alias: "t", describe: "content type", type: "string", default: "video", choices: ["video", "article", "track"] }),
  async handler(args: any) {
    UI.empty()
    prompts.intro(`${bold("content get")}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading...")
    const typeSlug = args.type === "video" ? "videos" : args.type === "track" ? "tracks" : "articles"
    const res = await irisFetch(`/api/v1/${typeSlug}/${args.id}`)
    const ok = await handleApiError(res, "get content")
    if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
    const body = (await res.json()) as any
    const item = body?.data?.data ?? body?.data ?? body
    spinner.stop("Done")

    if (args.json) {
      console.log(JSON.stringify(item, null, 2))
    } else {
      console.log()
      console.log(`  ${dim("id:")} ${bold(String(item.id))}`)
      console.log(`  ${dim("title:")} ${item.title}`)
      console.log(`  ${dim("type:")} ${args.type}`)
      console.log(`  ${dim("description:")} ${truncate(item.description ?? "", 200)}`)
      console.log(`  ${dim("profile_id:")} ${item.profile_id}`)
      console.log(`  ${dim("views:")} ${item.views ?? 0}`)
      console.log(`  ${dim("status:")} ${item.status === 0 ? "draft" : "published"}`)
      console.log(`  ${dim("created_at:")} ${item.created_at}`)
      if (item.thumbnail_url) console.log(`  ${dim("thumbnail:")} ${item.thumbnail_url}`)
      if (item.media_id) console.log(`  ${dim("media_id:")} ${item.media_id}`)

      const publicUrl = item.public_url ?? `https://web.freelabel.net/content/${args.type}/${item.id}`
      const urlOk = await verifyUrl(publicUrl)
      console.log(`  ${dim("public_url:")} ${publicUrl} ${urlOk ? success("200 OK") : "\x1b[31m! unreachable\x1b[0m"}`)
    }
    prompts.outro("Done")
  },
})

const DeleteCommand = cmd({
  command: "delete <id>",
  describe: "delete a content record",
  builder: (y: any) =>
    commonOpts(y)
      .positional("id", { type: "number", demandOption: true })
      .option("type", { alias: "t", type: "string", default: "video", choices: ["video", "article", "track"] })
      .option("force", { describe: "skip confirmation", type: "boolean", default: false }),
  async handler(args: any) {
    UI.empty()
    prompts.intro(`${bold("content delete")}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    if (!args.force) {
      const confirmed = await prompts.confirm({ message: `Delete ${args.type} #${args.id}?` })
      if (prompts.isCancel(confirmed) || !confirmed) {
        prompts.outro("Cancelled")
        return
      }
    }

    const spinner = prompts.spinner()
    spinner.start("Deleting...")
    const typeSlug = args.type === "video" ? "videos" : args.type === "track" ? "tracks" : "articles"
    const res = await irisFetch(`/api/v1/${typeSlug}/${args.id}`, { method: "DELETE" })
    const ok = await handleApiError(res, "delete")
    spinner.stop(ok ? "Deleted" : "Failed", ok ? 0 : 1)
    prompts.outro("Done")
  },
})

const SearchCommand = cmd({
  command: "search <query>",
  describe: "full-text search across all content types",
  builder: (y: any) =>
    commonOpts(y).positional("query", { type: "string", demandOption: true }),
  async handler(args: any) {
    UI.empty()
    prompts.intro(`${bold("content search")}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start(`Searching "${args.query}"...`)
    const params = new URLSearchParams({ q: args.query, types: "videos,articles,tracks" })
    const res = await irisFetch(`/api/v1/content/search?${params}`)
    if (!res.ok) {
      // Fall back to individual type searches
      spinner.stop("Searching per type...")
      const results: any[] = []
      for (const type of ["videos", "articles", "tracks"]) {
        const r = await irisFetch(`/api/v1/${type}?search=${encodeURIComponent(args.query)}&per_page=5`)
        if (r.ok) {
          const b = (await r.json()) as any
          const items = b?.data?.data ?? b?.data ?? []
          if (Array.isArray(items)) {
            for (const item of items) results.push({ ...item, _type: type.slice(0, -1) })
          }
        }
      }
      if (args.json) {
        console.log(JSON.stringify(results, null, 2))
      } else if (results.length === 0) {
        prompts.log.info("No results.")
      } else {
        console.log()
        for (const item of results) {
          console.log(`  ${dim(`[${item._type}]`)} ${bold(`#${item.id}`)} ${truncate(item.title ?? "", 60)}`)
        }
      }
    } else {
      const body = (await res.json()) as any
      spinner.stop("Done")
      if (args.json) {
        console.log(JSON.stringify(body, null, 2))
      } else {
        const items = body?.data ?? body
        if (!Array.isArray(items) || items.length === 0) {
          prompts.log.info("No results.")
        } else {
          console.log()
          for (const item of items) {
            console.log(`  ${dim(`[${item.type ?? "?"}]`)} ${bold(`#${item.id}`)} ${truncate(item.title ?? "", 60)}`)
          }
        }
      }
    }
    prompts.outro("Done")
  },
})

// ---------------------------------------------------------------------------
// Subcommands: Pull / Push / Diff
// ---------------------------------------------------------------------------

const PullCommand = cmd({
  command: "pull <id>",
  describe: "download content JSON to local ./content/",
  builder: (y: any) =>
    commonOpts(y)
      .positional("id", { type: "number", demandOption: true })
      .option("type", { alias: "t", type: "string", default: "video", choices: ["video", "article", "track"] }),
  async handler(args: any) {
    UI.empty()
    prompts.intro(`${bold("content pull")}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching...")
    const typeSlug = args.type === "video" ? "videos" : args.type === "track" ? "tracks" : "articles"
    const res = await irisFetch(`/api/v1/${typeSlug}/${args.id}`)
    const ok = await handleApiError(res, "pull")
    if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
    const body = (await res.json()) as any
    const item = body?.data?.data ?? body?.data ?? body
    spinner.stop("Fetched")

    const dir = resolveSyncDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const filename = contentFilename(args.type, args.id)
    const filepath = join(dir, filename)
    writeFileSync(filepath, JSON.stringify(item, null, 2) + "\n")
    prompts.log.success(`Written to ${filepath}`)
    prompts.outro("Done")
  },
})

const PushCommand = cmd({
  command: "push <id>",
  describe: "upload local JSON changes to API",
  builder: (y: any) =>
    commonOpts(y)
      .positional("id", { type: "number", demandOption: true })
      .option("type", { alias: "t", type: "string", default: "video", choices: ["video", "article", "track"] }),
  async handler(args: any) {
    UI.empty()
    prompts.intro(`${bold("content push")}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const dir = resolveSyncDir()
    const filepath = findLocalFile(dir, args.type, args.id)
    if (!filepath) {
      prompts.log.error(`No local file found. Run: iris content pull ${args.id} --type ${args.type}`)
      prompts.outro("Done")
      return
    }

    const local = JSON.parse(readFileSync(filepath, "utf8"))
    const spinner = prompts.spinner()
    spinner.start("Pushing...")
    const typeSlug = args.type === "video" ? "videos" : args.type === "track" ? "tracks" : "articles"
    const res = await irisFetch(`/api/v1/${typeSlug}/${args.id}`, {
      method: "PUT",
      body: JSON.stringify({
        title: local.title,
        description: local.description,
        thumbnail_url: local.thumbnail_url,
        twitter: local.twitter,
        instagram: local.instagram,
        status: local.status,
      }),
    })
    const ok = await handleApiError(res, "push")
    spinner.stop(ok ? "Updated" : "Failed", ok ? 0 : 1)
    prompts.outro("Done")
  },
})

const DiffCommand = cmd({
  command: "diff <id>",
  describe: "compare local vs remote content",
  builder: (y: any) =>
    commonOpts(y)
      .positional("id", { type: "number", demandOption: true })
      .option("type", { alias: "t", type: "string", default: "video", choices: ["video", "article", "track"] }),
  async handler(args: any) {
    UI.empty()
    prompts.intro(`${bold("content diff")}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const dir = resolveSyncDir()
    const filepath = findLocalFile(dir, args.type, args.id)
    if (!filepath) {
      prompts.log.error(`No local file found. Run: iris content pull ${args.id} --type ${args.type}`)
      prompts.outro("Done")
      return
    }

    const local = JSON.parse(readFileSync(filepath, "utf8"))

    const spinner = prompts.spinner()
    spinner.start("Fetching remote...")
    const typeSlug = args.type === "video" ? "videos" : args.type === "track" ? "tracks" : "articles"
    const res = await irisFetch(`/api/v1/${typeSlug}/${args.id}`)
    const ok = await handleApiError(res, "diff")
    if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
    const body = (await res.json()) as any
    const remote = body?.data?.data ?? body?.data ?? body
    spinner.stop("Comparing")

    const compareFields = ["title", "description", "thumbnail_url", "twitter", "instagram", "status"]
    let hasDiff = false
    console.log()
    for (const field of compareFields) {
      const l = String(local[field] ?? "")
      const r = String(remote[field] ?? "")
      if (l !== r) {
        hasDiff = true
        console.log(`  ${bold(field)}:`)
        console.log(`    ${dim("local:")}  ${truncate(l, 120)}`)
        console.log(`    ${dim("remote:")} ${truncate(r, 120)}`)
      }
    }
    if (!hasDiff) {
      prompts.log.success("No differences.")
    }
    prompts.outro("Done")
  },
})

// ---------------------------------------------------------------------------
// Root Command
// ---------------------------------------------------------------------------

export const PlatformContentCommand = cmd({
  command: "content",
  aliases: ["ct"],
  describe: "Content management -- profiles, upload, list, pull/push/diff",
  builder: (yargs: any) =>
    yargs
      .command(ProfilesCommand)
      .command(UploadCommand)
      .command(ListCommand)
      .command(GetCommand)
      .command(DeleteCommand)
      .command(SearchCommand)
      .command(PullCommand)
      .command(PushCommand)
      .command(DiffCommand)
      .demandCommand(),
  async handler() {},
})
