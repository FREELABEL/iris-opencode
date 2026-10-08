import type { CommandModule } from "yargs"
import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { basename, extname, join, resolve } from "path"
import { irisFetch, requireAuth, requireUserId, handleApiError, printDivider, bold, dim, success, writeJson, isJsonMode } from "./iris-api"

/**
 * The artist's freelabel.net page (the Studio), from the CLI — Creator OS epic #187764.
 *
 *   iris freelabel profile <handle>                  what the page shows and what it is missing
 *   iris freelabel tracks  <handle>                  tracklist with audio status
 *   iris freelabel upload  <handle> <paths..>        give silent tracks their audio (dry run first)
 *
 * The page reads one public endpoint (/api/profile/{pk}/studio on freelabel.net). Audio goes to R2
 * through the existing cloud-files upload (FILESYSTEM_CLOUD=r2, no expiry), and is attached with the
 * existing content update — no new write path.
 */

const STUDIO_BASE = process.env.FREELABEL_STUDIO_BASE ?? "https://freelabel.net"
const AUDIO_EXT = new Set([".mp3", ".m4a", ".aac", ".ogg", ".wav"]) // .aif/.aiff do not play in browsers
const MAX_BYTES = 100 * 1024 * 1024 // the upload endpoint's limit

export interface StudioTrack {
  id: number
  title: string
  preview_url: string | null
  embed_url?: string | null
}

export type AudioStatus = "plays" | "soundcloud" | "spotify" | "no audio"

export function audioStatus(t: StudioTrack): AudioStatus {
  if (t.preview_url) return "plays"
  if (t.embed_url) return t.embed_url.includes("soundcloud") ? "soundcloud" : "spotify"
  return "no audio"
}

/**
 * A title as a match key: "I Cant f. @JohnnyBTheShooter" → "icant", "@SirAlexMayo - AMR Vol. 4" →
 * "amrvol4", "100M $ Convos" → "100mconvo". Drops the feature credit, brackets, the artist-handle
 * prefix, punctuation and a trailing plural "s".
 */
export function titleKey(raw: string): string {
  let s = raw.replace(/\.[a-z0-9]{2,4}$/i, "")
  s = s.replace(/^@\w+\s*-\s*/, "")
  s = s.split(/\s(?:f\.|ft\.?|feat\.?|prod\.?)\s/i)[0]
  s = s.replace(/[\[(].*$/, "")
  s = s.toLowerCase().replace(/[^a-z0-9]/g, "")
  return s.length > 3 ? s.replace(/s$/, "") : s
}

/** A file's keys: its whole name, and each " - " segment ("She - JohnnyB theShooter" → she, johnnybtheshooter). */
export function fileKeys(name: string): string[] {
  const base = name.replace(/\.[a-z0-9]{2,4}$/i, "")
  const keys = new Set([titleKey(base)])
  for (const seg of base.replace(/^@\w+\s*-\s*/, "").split(/\s-\s/)) keys.add(titleKey(seg))
  keys.delete("")
  return [...keys]
}

/** Lower is better: the plain mix beats alternates, mp3 beats wav. */
export function variantPenalty(name: string): number {
  let p = 0
  if (/\b(vox|acapella|a cappella|instrumental|inst|stems?)\b/i.test(name)) p += 4
  if (/\b(v\d+(\.\d+)?|remaster(ed)?|full|demo|unfinished)\b/i.test(name)) p += 2
  if (/_\d+\.[a-z0-9]+$/i.test(name)) p += 2
  if (/\.wav$/i.test(name)) p += 1
  return p
}

export interface Match {
  track: StudioTrack
  file: string | null
  alternatives: string[]
}

/** Pair each silent track with its best file. A track with no candidate keeps file: null. */
export function matchTracks(tracks: StudioTrack[], files: string[]): Match[] {
  const index = files.map((f) => ({ f, name: basename(f), keys: fileKeys(basename(f)) }))
  return tracks.map((track) => {
    const key = titleKey(track.title)
    const hits = index
      .filter((x) => x.keys.includes(key))
      .map((x) => ({ ...x, score: (x.keys[0] === key ? 0 : 1) + variantPenalty(x.name) }))
      .sort((a, b) => a.score - b.score || a.name.length - b.name.length)
    return { track, file: hits[0]?.f ?? null, alternatives: hits.slice(1).map((h) => h.f) }
  })
}

export function collectAudio(paths: string[]): string[] {
  const out: string[] = []
  const walk = (p: string, depth: number) => {
    if (!existsSync(p)) return
    const st = statSync(p)
    if (st.isFile()) {
      if (AUDIO_EXT.has(extname(p).toLowerCase())) out.push(p)
      return
    }
    if (depth > 3) return
    for (const n of readdirSync(p)) if (!n.startsWith(".")) walk(join(p, n), depth + 1)
  }
  for (const p of paths) walk(resolve(p), 0)
  return out
}

async function loadProfile(handle: string): Promise<any | null> {
  const res = await irisFetch(`/api/v1/profile/${encodeURIComponent(handle.replace(/^@/, ""))}`)
  if (!(await handleApiError(res, "Load profile"))) return null
  const body = (await res.json()) as any
  return body?.data ?? body
}

async function loadStudio(pk: number): Promise<any | null> {
  const res = await fetch(`${STUDIO_BASE}/api/profile/${pk}/studio`, { headers: { Accept: "application/json" } })
  if (!res.ok) {
    console.error(`  Could not read the page data (${res.status}). Is the profile active?`)
    return null
  }
  return res.json()
}

async function resolve2(handle: string): Promise<{ profile: any; studio: any } | null> {
  // The owner's Studio API first: it names the profile and is not behind the general profile
  // read's tight rate limit (which answered "Too Many Attempts" mid-session). Anyone else's page
  // falls back to the public profile read.
  const own = await irisFetch(`/api/v1/studio/${encodeURIComponent(handle.replace(/^@/, ""))}`)
  let profile: any = null
  if (own.ok) {
    const b = (await own.json()) as any
    const p = (b?.data ?? b)?.profile
    if (p?.pk) profile = { pk: p.pk, id: p.handle, name: p.name }
  }
  profile ??= await loadProfile(handle)
  if (!profile?.pk) {
    console.error(`  No profile "${handle}".`)
    return null
  }
  const studio = await loadStudio(Number(profile.pk))
  return studio ? { profile, studio } : null
}

const pageUrl = (profile: any) => `${STUDIO_BASE}/${profile.id}`

// ── profile ──────────────────────────────────────────────────────────────────────

/** What the page is missing — each line names the command that fixes it. */
export function gaps(studio: any): string[] {
  const g: string[] = []
  const tracks: StudioTrack[] = studio.tracks ?? []
  const silent = tracks.filter((t) => audioStatus(t) === "no audio").length
  if (!studio.profile?.photo) g.push("no photo — iris profile set <handle> photo <url>")
  if (!studio.profile?.bio) g.push("no bio — iris profile set <handle> bio \"…\"")
  if (!(studio.links ?? []).length) g.push("no links — iris freelabel links <handle> --add --title … --url …")
  if (silent) g.push(`${silent} of ${tracks.length} tracks have no audio — iris freelabel tracks upload <handle> <folder>`)
  if (!studio.profile?.spotify) g.push("no Spotify artist — iris freelabel claim spotify <handle> <artist link>")
  if (!(studio.videos ?? []).length) g.push("no videos")
  if (!(studio.events ?? []).length) g.push("no tour dates")
  if (!(studio.memberships ?? []).length && !(studio.merch ?? []).length && !(studio.releases ?? []).length)
    g.push("nothing to buy or join — iris profile memberships <handle>")
  return g
}

const PageCmd: CommandModule = {
  command: "page <handle>",
  describe: "the artist's freelabel.net page — what it shows and what it is missing",
  builder: (y) => y.positional("handle", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
  handler: async (args: any) => {
    if (!(await requireAuth())) return
    const r = await resolve2(String(args.handle))
    if (!r) return process.exit(1)
    const { profile, studio } = r
    const tracks: StudioTrack[] = studio.tracks ?? []
    const counts = {
      videos: (studio.videos ?? []).length,
      tracks: tracks.length,
      tracks_with_audio: tracks.filter((t) => audioStatus(t) !== "no audio").length,
      links: (studio.links ?? []).length,
      shop: (studio.merch ?? []).length + (studio.releases ?? []).length,
      tour: (studio.events ?? []).length,
      memberships: (studio.memberships ?? []).length,
      related: (studio.related ?? []).length,
    }
    const missing = gaps(studio)
    if (args.json || isJsonMode()) return writeJson({ pk: profile.pk, handle: profile.id, url: pageUrl(profile), counts, missing })

    console.log("")
    console.log(`  ${bold(studio.profile?.name ?? profile.name)}  ${dim(`pk ${profile.pk}`)}`)
    console.log(`  ${pageUrl(profile)}`)
    printDivider()
    console.log(`  videos       ${counts.videos}`)
    console.log(`  music        ${counts.tracks} tracks · ${counts.tracks_with_audio} play`)
    console.log(`  links        ${counts.links}`)
    console.log(`  shop         ${counts.shop}`)
    console.log(`  tour         ${counts.tour}`)
    console.log(`  community    ${counts.memberships}`)
    console.log(`  related      ${counts.related}`)
    printDivider()
    if (!missing.length) console.log(`  ${success("Nothing missing.")}`)
    else for (const m of missing) console.log(`  ${dim("missing")}  ${m}`)
    console.log("")
  },
}

// ── tracks ───────────────────────────────────────────────────────────────────────

const TracksListCmd: CommandModule = {
  command: "list <handle>",
  describe: "the page's tracklist with audio status (plays · soundcloud · spotify · no audio)",
  builder: (y) => y.positional("handle", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
  handler: async (args: any) => {
    if (!(await requireAuth())) return
    const r = await resolve2(String(args.handle))
    if (!r) return process.exit(1)
    const tracks: StudioTrack[] = r.studio.tracks ?? []
    if (args.json || isJsonMode()) return writeJson(tracks.map((t) => ({ id: t.id, title: t.title, audio: audioStatus(t) })))
    console.log("")
    for (const t of tracks) console.log(`  ${String(t.id).padEnd(7)} ${audioStatus(t).padEnd(10)} ${t.title}`)
    console.log(dim(`\n  ${tracks.length} tracks · ${tracks.filter((t) => audioStatus(t) === "no audio").length} without audio\n`))
  },
}

// ── upload ───────────────────────────────────────────────────────────────────────

async function uploadAudio(path: string, userId: number): Promise<string | null> {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch (e: any) {
    // A cloud-synced file that cannot be fetched (Drive with a full disk times out) skips this
    // track — it must not end the run for every track after it.
    console.error(`    could not read ${basename(path)} (${e?.code ?? e?.message ?? e}) — skipped`)
    return null
  }
  const form = new FormData()
  form.append("file", new Blob([new Uint8Array(bytes)]), basename(path))
  form.append("type", "digital_product")
  form.append("title", basename(path))
  form.append("user_id", String(userId))
  // No expires_days: an artist's catalogue is kept, not swept by cloud:cleanup-expired.
  const res = await irisFetch("/api/v1/cloud-files/upload", { method: "POST", body: form })
  if (!res.ok) {
    console.error(`    upload failed (${res.status}): ${(await res.text()).slice(0, 160)}`)
    return null
  }
  const b = (await res.json()) as any
  const d = b?.data ?? b
  return d?.url ?? d?.cdn_url ?? d?.file_url ?? null
}

async function attach(trackId: number, url: string): Promise<boolean> {
  const res = await irisFetch(`/api/v1/content/track/${trackId}`, { method: "PUT", body: JSON.stringify({ trackmp3: url }) })
  if (!res.ok) console.error(`    attach failed (${res.status}): ${(await res.text()).slice(0, 160)}`)
  return res.ok
}

export const UploadCmd: CommandModule = {
  command: "upload <handle> <paths..>",
  describe: "give the page's silent tracks their audio — matches files to tracks by title; dry run unless --apply",
  builder: (y) =>
    y
      .positional("handle", { type: "string", demandOption: true })
      .positional("paths", { type: "string", array: true, describe: "audio files or folders (searched 3 levels deep)" })
      .option("track", { type: "number", describe: "attach ONE file to this track id (skips matching)" })
      .option("only", { type: "number", array: true, describe: "limit to these track ids" })
      .option("limit", { type: "number", describe: "attach at most N tracks this run — do a few, listen, then the rest" })
      .option("all", { type: "boolean", default: false, describe: "also replace audio on tracks that already play" })
      .option("apply", { type: "boolean", default: false, describe: "upload and attach (default is a dry run)" })
      .option("json", { type: "boolean", default: false }),
  handler: async (args: any) => {
    if (!(await requireAuth())) return
    const r = await resolve2(String(args.handle))
    if (!r) return process.exit(1)
    const files = collectAudio(args.paths ?? [])
    let tracks: StudioTrack[] = r.studio.tracks ?? []

    let plan: Match[]
    if (args.track) {
      const t = tracks.find((x) => x.id === args.track)
      if (!t) return void console.error(`  Track ${args.track} is not on ${r.profile.id}'s page.`)
      if (files.length !== 1) return void console.error(`  --track takes exactly one audio file (got ${files.length}).`)
      plan = [{ track: t, file: files[0], alternatives: [] }]
    } else {
      if (!args.all) tracks = tracks.filter((t) => audioStatus(t) === "no audio")
      if (args.only?.length) tracks = tracks.filter((t) => args.only.includes(t.id))
      plan = matchTracks(tracks, files)
    }

    const matched = plan.filter((m) => m.file)
    const todo = args.limit ? matched.slice(0, args.limit) : matched
    if (args.json || isJsonMode()) {
      if (!args.apply)
        return writeJson({ apply: false, files: files.length, plan: plan.map((m) => ({ id: m.track.id, title: m.track.title, file: m.file, alternatives: m.alternatives })) })
    } else {
      console.log("")
      console.log(`  ${bold(args.apply ? "APPLY" : "DRY RUN")} — ${r.profile.id} · ${files.length} audio files · ${plan.length} tracks to fill`)
      printDivider()
      for (const m of plan) {
        const alt = m.alternatives.length ? dim(`  (+${m.alternatives.length} other version${m.alternatives.length > 1 ? "s" : ""})`) : ""
        console.log(`  ${String(m.track.id).padEnd(7)} ${m.track.title}`)
        console.log(`          ${m.file ? "← " + basename(m.file) + alt : dim("no file found")}`)
      }
      printDivider()
    }
    if (!args.apply) {
      if (!isJsonMode() && !args.json) {
        console.log(`  ${matched.length} would be attached${args.limit ? ` (${todo.length} this run, --limit)` : ""}. Nothing was uploaded.`)
        console.log(dim(`  Re-run with --apply. A wrong pick: --only <id> to skip, or --track <id> <file> to choose.\n`))
      }
      return
    }

    const userId = await requireUserId()
    if (!userId) return
    const uploaded = new Map<string, string>() // one file can serve two duplicate track rows
    const done: { id: number; title: string; url: string }[] = []
    for (const m of todo) {
      const file = m.file!
      if (statSync(file).size > MAX_BYTES) {
        console.error(`  skip ${m.track.title} — ${basename(file)} is over 100 MB`)
        continue
      }
      let url = uploaded.get(file)
      if (!url) {
        process.stdout.write(`  uploading ${basename(file)} … `)
        url = (await uploadAudio(file, userId)) ?? undefined
        if (!url) continue
        uploaded.set(file, url)
        console.log(success("ok"))
      }
      if (await attach(m.track.id, url)) {
        done.push({ id: m.track.id, title: m.track.title, url })
        console.log(`  ${success("attached")} ${m.track.id} ${m.track.title}`)
      }
    }

    // Verify against the PAGE, not our own writes: the page must now report these as playing.
    const after = await loadStudio(Number(r.profile.pk))
    const playing = new Set(((after?.tracks ?? []) as StudioTrack[]).filter((t) => t.preview_url).map((t) => t.id))
    const confirmed = done.filter((d) => playing.has(d.id))
    if (args.json || isJsonMode()) return writeJson({ apply: true, attached: done, confirmed_on_page: confirmed.map((d) => d.id) })
    console.log("")
    console.log(`  ${confirmed.length} of ${done.length} attached tracks now play on ${pageUrl(r.profile)}`)
    if (confirmed.length < done.length) console.log(dim("  The page caches briefly — re-check with: iris freelabel tracks " + r.profile.id))
    console.log("")
  },
}


// ── one owner-checked API for every surface: fl-api /api/v1/studio (#187886) ─────────

async function studioApi(path: string, method = "GET", body?: unknown): Promise<any | null> {
  const res = await irisFetch(`/api/v1/studio/${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
  if (res.status === 403) {
    const m = ((await res.json().catch(() => null)) as any)?.message
    console.error(`  ${m || "You can only manage your own page."}`)
    return null
  }
  if (!(await handleApiError(res, `Studio ${method}`))) return null
  const b = (await res.json()) as any
  return b?.data ?? b
}

const handleOf = (h: string) => h.replace(/^@/, "")

function itemVerb(type: "video" | "track", verb: string, describe: string, body: (id: number) => unknown, after?: string): CommandModule {
  return {
    command: `${verb} <handle> <id>`,
    describe,
    builder: (y) => y.positional("handle", { type: "string", demandOption: true }).positional("id", { type: "number", demandOption: true }),
    handler: async (args: any) => {
      if (!(await requireAuth())) return
      const r = await studioApi(`${handleOf(args.handle)}/${type}/${args.id}`, "PUT", body(Number(args.id)))
      if (!r) return process.exit(1)
      console.log(`  ${success("Saved")} ${type} ${args.id}${after ? " — " + after : ""}`)
    },
  }
}

function settingsVerb(command: string, describe: string, body: (args: any) => unknown, done: (args: any) => string): CommandModule {
  return {
    command,
    describe,
    builder: (y) => y.positional("handle", { type: "string", demandOption: true }).positional("id", { type: "number" }),
    handler: async (args: any) => {
      if (!(await requireAuth())) return
      const r = await studioApi(`${handleOf(args.handle)}/settings`, "PUT", body(args))
      if (!r) return process.exit(1)
      console.log(`  ${success("Saved")} ${done(args)}`)
    },
  }
}

const TrackUpdateCmd: CommandModule = {
  command: "update <handle> <id>",
  describe: "change a track's title, audio URL or artwork URL",
  builder: (y) =>
    y
      .positional("handle", { type: "string", demandOption: true })
      .positional("id", { type: "number", demandOption: true })
      .option("title", { type: "string" })
      .option("audio", { type: "string", describe: "https URL of the audio (or use `tracks upload --track`)" })
      .option("artwork", { type: "string", describe: "https URL of the cover art" }),
  handler: async (args: any) => {
    if (!(await requireAuth())) return
    const body: Record<string, unknown> = {}
    if (args.title) body.title = args.title
    if (args.audio) body.audio_url = args.audio
    if (args.artwork) body.artwork_url = args.artwork
    if (!Object.keys(body).length) return void console.error("  Nothing to change — pass --title, --audio or --artwork.")
    const r = await studioApi(`${handleOf(args.handle)}/track/${args.id}`, "PUT", body)
    if (!r) return process.exit(1)
    console.log(`  ${success("Saved")} track ${args.id}: ${(r.changed ?? []).join(", ")}`)
  },
}

export const TracksCmd: CommandModule = {
  command: "tracks",
  aliases: ["music"],
  describe: "the Music tab — list, upload audio, update, hide/show, pin",
  builder: (y) =>
    y
      .command(TracksListCmd)
      .command(UploadCmd)
      .command(TrackUpdateCmd)
      .command(itemVerb("track", "hide", "take a track off the page (kept, not deleted)", () => ({ visible: false })))
      .command(itemVerb("track", "show", "put a hidden track back on the page", () => ({ visible: true })))
      .command(settingsVerb("pin <handle> <id>", "put this track first", (a) => ({ pinned_track_id: a.id }), (a) => `track ${a.id} pinned first`))
      .command(settingsVerb("unpin <handle>", "no pinned track", () => ({ pinned_track_id: null }), () => "no pinned track"))
      .demandCommand(1, "Specify: list, upload, update, hide, show, pin, unpin"),
  handler: () => {},
}

const VideosListCmd: CommandModule = {
  command: "list <handle>",
  describe: "the Videos tab — own vs picks, pinned, hidden",
  builder: (y) => y.positional("handle", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
  handler: async (args: any) => {
    if (!(await requireAuth())) return
    const owner = await studioApi(handleOf(args.handle))
    if (!owner) return process.exit(1)
    const page = await loadStudio(Number(owner.profile.pk))
    const shown = new Map<number, any>(((page?.videos ?? []) as any[]).map((v) => [v.id, v]))
    const pinned = owner.settings?.pinned_video_id
    const rows = (owner.items?.videos ?? []).map((v: any) => ({
      id: v.id,
      title: v.title,
      visible: v.visible,
      kind: shown.get(v.id)?.kind ?? (v.visible ? "—" : "hidden"),
      set_by_artist: owner.settings?.video_kind?.[String(v.id)] ? true : false,
      pinned: v.id === pinned,
    }))
    if (args.json || isJsonMode()) return writeJson(rows)
    console.log("")
    for (const r of rows)
      console.log(`  ${String(r.id).padEnd(7)} ${(r.pinned ? "★ " : "  ") + String(r.visible ? r.kind : "hidden").padEnd(7)}${r.set_by_artist ? "" : dim("~")} ${r.title}`)
    console.log(dim(`\n  ★ pinned · ~ own/pick is the automatic guess — set it with: videos own|pick <handle> <id>\n`))
  },
}

const VideoAddCmd: CommandModule = {
  command: "add <handle> <url>",
  describe: "add a video to the page from a YouTube (or Instagram/TikTok) link",
  builder: (y) =>
    y
      .positional("handle", { type: "string", demandOption: true })
      .positional("url", { type: "string", demandOption: true })
      .option("title", { type: "string" })
      .option("pick", { type: "boolean", default: false, describe: "someone else's video you are featuring" }),
  handler: async (args: any) => {
    // Same path as `iris content upload` — no second way to create a video.
    const { UploadCommand } = await import("./platform-content")
    await (UploadCommand as any).handler({ ...args, profile: handleOf(args.handle), type: "video" })
    if (args.pick) console.log(dim("  Mark it as a pick once it appears: iris freelabel videos pick " + handleOf(args.handle) + " <id>"))
  },
}

export const VideosCmd: CommandModule = {
  command: "videos",
  describe: "the Videos tab — list, add, update, hide/show, pin, own/pick",
  builder: (y) =>
    y
      .command(VideosListCmd)
      .command(VideoAddCmd)
      .command({
        command: "update <handle> <id>",
        describe: "change a video's title",
        builder: (yy) => yy.positional("handle", { type: "string", demandOption: true }).positional("id", { type: "number", demandOption: true }).option("title", { type: "string", demandOption: true }),
        handler: async (args: any) => {
          if (!(await requireAuth())) return
          const r = await studioApi(`${handleOf(args.handle)}/video/${args.id}`, "PUT", { title: args.title })
          if (!r) return process.exit(1)
          console.log(`  ${success("Saved")} video ${args.id}`)
        },
      })
      .command(itemVerb("video", "hide", "take a video off the page (kept, not deleted)", () => ({ visible: false })))
      .command(itemVerb("video", "show", "put a hidden video back on the page", () => ({ visible: true })))
      .command(settingsVerb("pin <handle> <id>", "put this video first — what Watch plays", (a) => ({ pinned_video_id: a.id }), (a) => `video ${a.id} pinned first`))
      .command(settingsVerb("unpin <handle>", "no pinned video", () => ({ pinned_video_id: null }), () => "no pinned video"))
      .command(settingsVerb("own <handle> <id>", "this is the artist's own work", (a) => ({ video_kind: { [a.id]: "own" } }), (a) => `video ${a.id} is your own`))
      .command(settingsVerb("pick <handle> <id>", "someone else's video the artist features", (a) => ({ video_kind: { [a.id]: "pick" } }), (a) => `video ${a.id} is a pick`))
      .command(settingsVerb("auto <handle> <id>", "let the page guess own/pick again", (a) => ({ video_kind: { [a.id]: null } }), (a) => `video ${a.id} back to automatic`))
      .demandCommand(1, "Specify: list, add, update, hide, show, pin, unpin, own, pick, auto"),
  handler: () => {},
}

/** freelabel.net/<handle>, optionally opened on one video or track — what the page's share links read. */
export function shareUrl(handle: string, opts: { video?: number; track?: number } = {}): string {
  const base = `${STUDIO_BASE}/${encodeURIComponent(handleOf(handle))}`
  if (opts.video) return `${base}?v=${opts.video}`
  if (opts.track) return `${base}?t=${opts.track}`
  return base
}

const ShareCmd: CommandModule = {
  command: "share <handle>",
  describe: "a link to the page, or to one video/track on it — ready to post",
  builder: (y) => y.positional("handle", { type: "string", demandOption: true }).option("video", { type: "number" }).option("track", { type: "number" }),
  handler: async (args: any) => {
    const url = shareUrl(args.handle, { video: args.video, track: args.track })
    if (isJsonMode()) return writeJson({ url })
    console.log(url)
  },
}

// ── Spotify identity: claimed by the artist, approved by an admin (FL-CO-30/31) ─────────
// spotify_id decides which page owns a Spotify artist's tracks, so nobody sets it on their own
// page: the artist files a claim, an admin checks it, and approval files the catalogue.

/** The 22-char artist id from a link, a spotify:artist: URI or the bare id — same rule as fl-api. */
export function spotifyArtistId(ref: string | undefined | null): string | null {
  const s = String(ref ?? "").trim()
  const m = s.match(/(?:open\.spotify\.com\/(?:intl-[a-z]{2}\/)?artist\/|spotify:artist:)([0-9A-Za-z]{22})/)
  if (m) return m[1]
  return /^[0-9A-Za-z]{22}$/.test(s) ? s : null
}

function printPreview(p: any) {
  if (!p) return
  console.log(`  ${dim("tracks it files")}   ${p.tracks_to_file ?? 0}`)
  if (p.tracks_already_on_page) console.log(`  ${dim("already on page")}   ${p.tracks_already_on_page}`)
  if (p.conflict_profile) console.log(`  ${dim("conflict")}          page ${p.conflict_profile} already holds this artist — an admin resolves it first`)
}

const ClaimSpotifyCmd: CommandModule = {
  command: "spotify <handle> <link>",
  describe: "claim your Spotify artist — an admin approves, then your catalogue lands on the page",
  builder: (y) => y.positional("handle", { type: "string", demandOption: true }).positional("link", { type: "string", demandOption: true, describe: "https://open.spotify.com/artist/…" }),
  handler: async (args: any) => {
    const id = spotifyArtistId(args.link)
    if (!id) {
      console.error("  That is not a Spotify artist link — open your artist page on Spotify and copy its link (…/artist/…).")
      return process.exit(1)
    }
    if (!(await requireAuth())) return
    const r = await studioApi(`${handleOf(args.handle)}/spotify-claim`, "POST", { spotify: args.link })
    if (!r) return process.exit(1)
    if (args.json || isJsonMode()) return writeJson(r)
    if (!r.claim) return console.log(`  ${success("Already yours")} this page carries Spotify artist ${id}`)
    console.log(`  ${success("Claim sent")} Spotify artist ${id} — an admin confirms it, usually within a day`)
    printPreview(r.preview)
  },
}

const ClaimStatusCmd: CommandModule = {
  command: "status <handle>",
  describe: "the page's Spotify claim, if any",
  builder: (y) => y.positional("handle", { type: "string", demandOption: true }),
  handler: async (args: any) => {
    if (!(await requireAuth())) return
    const r = await studioApi(handleOf(args.handle))
    if (!r) return process.exit(1)
    const c = r.settings?.spotify_claim
    if (args.json || isJsonMode()) return writeJson(c ?? null)
    if (!c) return console.log(`  ${dim("No Spotify claim on this page.")}`)
    console.log(`  ${bold(String(c.status))}  Spotify artist ${c.spotify_artist_id}  ${dim(String(c.requested_at ?? ""))}`)
    if (c.status === "approved") console.log(`  ${dim("tracks filed")} ${c.tracks_filed ?? 0}`)
  },
}

const ClaimWithdrawCmd: CommandModule = {
  command: "withdraw <handle>",
  describe: "withdraw the pending claim (an admin doing this rejects it)",
  builder: (y) => y.positional("handle", { type: "string", demandOption: true }),
  handler: async (args: any) => {
    if (!(await requireAuth())) return
    const r = await studioApi(`${handleOf(args.handle)}/spotify-claim`, "DELETE")
    if (!r) return process.exit(1)
    console.log(`  ${success("Closed")} the Spotify claim`)
  },
}

const ClaimListCmd: CommandModule = {
  command: "list",
  describe: "admin: every pending Spotify claim",
  handler: async (args: any) => {
    if (!(await requireAuth())) return
    const r = await studioApi("spotify-claims")
    if (!r) return process.exit(1)
    const claims: any[] = r.claims ?? []
    if (args.json || isJsonMode()) return writeJson(claims)
    if (!claims.length) return console.log(`  ${dim("No pending claims.")}`)
    for (const c of claims)
      console.log(`  ${bold(c.handle)}  ${dim("pk " + c.profile)}  → Spotify ${c.claim?.spotify_artist_id}  ${dim("open.spotify.com/artist/" + c.claim?.spotify_artist_id)}`)
    printDivider()
    console.log(`  ${dim("check each artist, then: iris freelabel claim approve <handle> --apply")}`)
  },
}

const ClaimApproveCmd: CommandModule = {
  command: "approve <handle>",
  describe: "admin: approve a Spotify claim and file the catalogue — dry run unless --apply",
  builder: (y) => y.positional("handle", { type: "string", demandOption: true }).option("apply", { type: "boolean", default: false }),
  handler: async (args: any) => {
    if (!(await requireAuth())) return
    const path = `${handleOf(args.handle)}/spotify-claim/approve${args.apply ? "" : "?dry_run=1"}`
    const r = await studioApi(path, "POST")
    if (!r) return process.exit(1)
    if (args.json || isJsonMode()) return writeJson(r)
    if (!args.apply) {
      console.log(`  ${bold("DRY RUN")} — Spotify artist ${r.claim?.spotify_artist_id} for ${args.handle}`)
      printPreview(r.preview)
      return console.log(`  ${dim("re-run with --apply to approve")}`)
    }
    console.log(`  ${success("Approved")} ${r.result?.tracks_filed ?? 0} tracks filed under ${args.handle}`)
  },
}

export const ClaimCmd: CommandModule = {
  command: "claim",
  describe: "your Spotify artist identity — claim it, check it, (admins) approve it",
  builder: (y) => y.command(ClaimSpotifyCmd).command(ClaimStatusCmd).command(ClaimWithdrawCmd).command(ClaimListCmd).command(ClaimApproveCmd).demandCommand(1),
  handler: () => {},
}

export const FreelabelStudioCommands = [PageCmd, TracksCmd, VideosCmd, ShareCmd, ClaimCmd, { ...UploadCmd, describe: "shortcut for: tracks upload" }]
