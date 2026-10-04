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
  const profile = await loadProfile(handle)
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
  if (!(studio.links ?? []).length) g.push("no links — iris profile links <handle> --add --title … --url …")
  if (silent) g.push(`${silent} of ${tracks.length} tracks have no audio — iris freelabel upload <handle> <folder>`)
  if (!(studio.videos ?? []).length) g.push("no videos")
  if (!(studio.events ?? []).length) g.push("no tour dates")
  if (!(studio.memberships ?? []).length && !(studio.merch ?? []).length && !(studio.releases ?? []).length)
    g.push("nothing to buy or join — iris profile memberships <handle>")
  return g
}

const ProfileCmd: CommandModule = {
  command: "profile <handle>",
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

const TracksCmd: CommandModule = {
  command: "tracks <handle>",
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
  const form = new FormData()
  form.append("file", new Blob([new Uint8Array(readFileSync(path))]), basename(path))
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

const UploadCmd: CommandModule = {
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

export const FreelabelStudioCommands = [ProfileCmd, TracksCmd, UploadCmd]
