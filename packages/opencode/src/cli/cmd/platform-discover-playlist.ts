import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, printDivider, bold, dim, highlight } from "./iris-api"
import { ensureYtDlp, which, downloadAudioMp3 } from "./download"
import { analyzeAudio } from "./audio-analysis"
import { existsSync, mkdirSync, statSync } from "fs"
import { join, basename } from "path"

interface PlaylistTrack {
  spotifyId: string
  title: string
  artist: string
  album?: string
  albumArt?: string | null
  isrc?: string | null
  durationMs?: number | null
  spotifyUrl?: string | null
}

interface PlaylistPayload {
  name: string
  description?: string | null
  image?: string | null
  owner?: string | null
  spotifyUrl?: string | null
  trackCount: number
  tracks: PlaylistTrack[]
}

/** Extract the playlist id from a URL, URI, or bare id. */
function parsePlaylistId(input: string): string | null {
  const s = input.trim()
  // spotify:playlist:<id>
  const uri = s.match(/^spotify:playlist:([A-Za-z0-9]+)$/)
  if (uri) return uri[1]
  // https://open.spotify.com/playlist/<id>?si=...
  const url = s.match(/playlist\/([A-Za-z0-9]+)/)
  if (url) return url[1]
  // bare id
  if (/^[A-Za-z0-9]{16,}$/.test(s)) return s
  return null
}

/** Filesystem-safe slug for folder/file names, preserving readability. */
function fsSlug(s: string, max = 80): string {
  const cleaned = s
    .normalize("NFKD")
    .replace(/[\/\\:*?"<>|]+/g, " ") // illegal path chars -> space
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim()
  return cleaned || "untitled"
}

/**
 * Publish one downloaded MP3 to FREELABEL as a playable audio content item.
 * Multiparts the file + Spotify metadata to fl-api, which stores it on durable
 * cloud storage and upserts a `feed` row with `trackmp3` set.
 */
async function uploadTrack(mp3Path: string, t: PlaylistTrack): Promise<{ ok: boolean; trackId?: number; error?: string }> {
  try {
    const form = new FormData()
    form.append("audio", Bun.file(mp3Path), basename(mp3Path))
    form.append("spotify_id", t.spotifyId)
    form.append("title", t.title)
    form.append("artist", t.artist)
    if (t.album) form.append("album", t.album)
    if (t.albumArt) form.append("album_art", t.albumArt)
    if (t.spotifyUrl) form.append("spotify_url", t.spotifyUrl)

    // Beatbox: compute BPM/key/Camelot/energy from the file and send with the import.
    const analysis = analyzeAudio(mp3Path)
    if (analysis) {
      form.append("bpm", String(analysis.bpm))
      form.append("musical_key", analysis.key)
      form.append("camelot", analysis.camelot)
      form.append("energy", String(analysis.energy))
    }

    const res = await irisFetch("/api/v1/spotify/tracks/import", { method: "POST", body: form })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 140)}` }
    }
    const body = (await res.json()) as any
    if (!body?.success) return { ok: false, error: body?.error || body?.message || "import failed" }
    return { ok: true, trackId: body?.data?.track_id }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/**
 * Publish a whole playlist as a Discover series (album-style Category of the imported
 * tracks) on FREELABEL. Idempotent per playlist so a series can be relaunched.
 */
async function publishSeries(
  playlistId: string,
  payload: PlaylistPayload,
  spotifyIds: string[],
): Promise<{ ok: boolean; seriesId?: number; attached?: number; error?: string }> {
  try {
    const res = await irisFetch("/api/v1/spotify/playlist/publish-series", {
      method: "POST",
      body: JSON.stringify({
        playlist_id: playlistId,
        name: payload.name,
        image: payload.image,
        spotify_url: payload.spotifyUrl,
        spotify_ids: spotifyIds,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 140)}` }
    }
    const body = (await res.json()) as any
    if (!body?.success) return { ok: false, error: body?.error || body?.message || "publish failed" }
    return { ok: true, seriesId: body?.data?.series_id, attached: body?.data?.attached }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/**
 * `iris discover playlist <url>` — ingest a Spotify playlist, match each track on
 * YouTube, and download tagged (ID3 + album art) MP3s into a local folder for DJ
 * sets and livestreams. Spotify metadata comes from fl-api (where the creds live);
 * the audio download runs locally via yt-dlp so files land on your machine.
 */
const PlaylistCommand = cmd({
  command: "playlist <url>",
  describe: "download a Spotify playlist as tagged MP3s (matched on YouTube) for DJ sets",
  builder: (y) =>
    y
      .positional("url", {
        type: "string",
        demandOption: true,
        describe: "Spotify playlist URL, URI, or id",
      })
      .option("out", {
        type: "string",
        alias: "o",
        describe: "Output directory (default: ./sets/<playlist-slug>/)",
      })
      .option("limit", {
        type: "number",
        describe: "Only process the first N tracks",
      })
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "List tracks and planned YouTube matches without downloading",
      })
      .option("upload", {
        type: "boolean",
        default: false,
        describe: "Also publish each track to FREELABEL as a playable audio content item (private library)",
      })
      .option("publish-series", {
        type: "boolean",
        default: false,
        describe: "Publish the whole playlist as a series on the Discover page (implies --upload)",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "JSON output (implies no interactive spinners)",
      }),
  async handler(args) {
    const json = !!args.json
    if (!json) {
      UI.empty()
      prompts.intro("  Discover · Playlist")
    }

    const playlistId = parsePlaylistId(String(args.url))
    if (!playlistId) {
      prompts.log.error("Could not parse a Spotify playlist id from that input.")
      prompts.log.info("Expected e.g. https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M")
      process.exitCode = 1
      return
    }

    // Spotify creds live in fl-api — auth required to read the playlist.
    const token = await requireAuth()
    if (!token) {
      process.exitCode = 1
      return
    }

    // 1. Fetch normalized playlist + tracks from fl-api.
    let payload: PlaylistPayload
    {
      const sp = json ? null : prompts.spinner()
      sp?.start("Reading playlist from Spotify…")
      const res = await irisFetch(`/api/v1/spotify/playlist/${playlistId}`)
      if (!res.ok) {
        sp?.stop("Failed", 1)
        const body = await res.text().catch(() => "")
        prompts.log.error(`Playlist fetch failed (HTTP ${res.status}). ${body.slice(0, 200)}`)
        process.exitCode = 1
        return
      }
      const body = (await res.json()) as any
      payload = body?.data as PlaylistPayload
      if (!payload || !Array.isArray(payload.tracks)) {
        sp?.stop("Failed", 1)
        prompts.log.error("Unexpected response shape from playlist endpoint.")
        process.exitCode = 1
        return
      }
      sp?.stop(`${bold(payload.name)} — ${payload.trackCount} track${payload.trackCount === 1 ? "" : "s"}`)
    }

    let tracks = payload.tracks
    if (args.limit && args.limit > 0) tracks = tracks.slice(0, args.limit)

    const outDir = args.out
      ? String(args.out)
      : join(process.cwd(), "sets", fsSlug(payload.name))

    // Search term used to find each track on YouTube.
    const searchTermFor = (t: PlaylistTrack) => `ytsearch1:${t.artist} ${t.title}`.trim()

    // --dry-run: show what WOULD be matched/downloaded, then stop.
    if (args["dry-run"]) {
      if (json) {
        console.log(
          JSON.stringify(
            {
              playlist: payload.name,
              outDir,
              tracks: tracks.map((t) => ({ ...t, search: searchTermFor(t) })),
            },
            null,
            2,
          ),
        )
        return
      }
      printDivider()
      tracks.forEach((t, i) => {
        console.log(`  ${dim(String(i + 1).padStart(2, "0"))}  ${bold(t.title)} ${dim("—")} ${t.artist}`)
        console.log(`      ${dim(searchTermFor(t))}`)
      })
      printDivider()
      prompts.outro(`Dry run — ${tracks.length} track(s) would download to ${highlight(outDir)}`)
      return
    }

    // 2. Ensure the download toolchain (yt-dlp + ffmpeg for mp3 conversion).
    const ytdlp = ensureYtDlp()
    if (!ytdlp) {
      process.exitCode = 1
      prompts.outro("Aborted — yt-dlp unavailable")
      return
    }
    if (!which("ffmpeg")) {
      prompts.log.error("ffmpeg not found — required to extract MP3. Install: brew install ffmpeg")
      process.exitCode = 1
      prompts.outro("Aborted")
      return
    }

    mkdirSync(outDir, { recursive: true })

    // 3. Download each track as a tagged MP3 (and optionally publish it).
    const wantSeries = !!args["publish-series"]
    const wantUpload = !!args.upload || wantSeries // a series needs the tracks uploaded first
    const done: { title: string; artist: string; path: string }[] = []
    const failed: { title: string; artist: string; error: string }[] = []
    const uploaded: { title: string; artist: string; trackId?: number }[] = []
    const uploadFailed: { title: string; artist: string; error: string }[] = []
    const uploadedIds: string[] = [] // spotify ids of uploaded tracks, in playlist order (for the series)

    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]
      const n = String(i + 1).padStart(2, "0")
      const label = `${t.title} — ${t.artist}`
      const outBase = join(outDir, fsSlug(`${n} - ${t.artist} - ${t.title}`))
      const mp3Path = `${outBase}.mp3`
      let ready = false

      // Skip download if already present (idempotent re-runs / resumable series launches).
      if (existsSync(mp3Path)) {
        if (!json) prompts.log.info(`${dim(`[${n}/${tracks.length}]`)} ${label} ${dim("(already downloaded)")}`)
        done.push({ title: t.title, artist: t.artist, path: mp3Path })
        ready = true
      } else {
        const sp = json ? null : prompts.spinner()
        sp?.start(`[${n}/${tracks.length}] ${label}`)

        const r = await downloadAudioMp3(ytdlp, searchTermFor(t), outBase, {
          title: t.title,
          artist: t.artist,
          album: t.album,
        })

        if (r.ok && r.path) {
          const size = (statSync(r.path).size / 1024 / 1024).toFixed(1)
          sp?.stop(`[${n}/${tracks.length}] ${label} ${dim(`(${size} MB)`)}`)
          done.push({ title: t.title, artist: t.artist, path: r.path })
          ready = true
        } else {
          sp?.stop(`[${n}/${tracks.length}] ${label} — ${r.error}`, 1)
          failed.push({ title: t.title, artist: t.artist, error: r.error || "unknown" })
        }
      }

      // Publish to FREELABEL as a playable audio content item.
      if (ready && wantUpload) {
        const sp = json ? null : prompts.spinner()
        sp?.start(`   ↑ publishing ${label}`)
        const u = await uploadTrack(mp3Path, t)
        if (u.ok) {
          sp?.stop(`   ↑ published ${label} ${dim(u.trackId ? `(#${u.trackId})` : "")}`)
          uploaded.push({ title: t.title, artist: t.artist, trackId: u.trackId })
          uploadedIds.push(t.spotifyId)
        } else {
          sp?.stop(`   ↑ publish failed ${label} — ${u.error}`, 1)
          uploadFailed.push({ title: t.title, artist: t.artist, error: u.error || "unknown" })
        }
      }
    }

    // 3b. Publish the whole playlist as a Discover series (album-style Category).
    let series: { ok: boolean; seriesId?: number; attached?: number; error?: string } | null = null
    if (wantSeries && uploadedIds.length > 0) {
      const sp = json ? null : prompts.spinner()
      sp?.start("Publishing series to Discover…")
      series = await publishSeries(playlistId, payload, uploadedIds)
      if (series.ok) {
        sp?.stop(`Series live on Discover — ${series.attached} track(s) ${dim(series.seriesId ? `(#${series.seriesId})` : "")}`)
      } else {
        sp?.stop(`Series publish failed — ${series.error}`, 1)
      }
    } else if (wantSeries) {
      if (!json) prompts.log.warn("No tracks were uploaded — skipping series publish")
    }

    // 4. Summary.
    if (json) {
      console.log(
        JSON.stringify(
          { playlist: payload.name, outDir, downloaded: done, failed, uploaded, uploadFailed, series },
          null,
          2,
        ),
      )
      if (failed.length || uploadFailed.length || (series && !series.ok)) process.exitCode = 1
      return
    }

    printDivider()
    console.log(`  ${bold("Playlist")}   ${payload.name}`)
    console.log(`  ${bold("Matched")}    ${done.length}/${tracks.length}`)
    console.log(`  ${bold("Folder")}     ${highlight(outDir)}`)
    if (wantUpload) console.log(`  ${bold("Published")}  ${uploaded.length}/${done.length} to FREELABEL`)
    if (wantSeries) {
      console.log(
        `  ${bold("Series")}     ${series?.ok ? `live on Discover (#${series.seriesId})` : dim(series?.error || "not published")}`,
      )
    }
    if (failed.length) {
      console.log()
      console.log(`  ${dim("Unmatched:")}`)
      for (const f of failed) console.log(`    ${dim("·")} ${f.title} — ${f.artist} ${dim(`(${f.error})`)}`)
    }
    if (uploadFailed.length) {
      console.log()
      console.log(`  ${dim("Publish failures:")}`)
      for (const f of uploadFailed) console.log(`    ${dim("·")} ${f.title} — ${f.artist} ${dim(`(${f.error})`)}`)
    }
    printDivider()

    if (done.length === 0) {
      process.exitCode = 1
      prompts.outro("No tracks downloaded — see errors above (re-run with --print-logs for yt-dlp detail)")
    } else {
      prompts.outro(`${done.length} track${done.length === 1 ? "" : "s"} ready for your set 🎧`)
    }
  },
})

export { PlaylistCommand }
