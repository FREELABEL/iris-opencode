import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, printDivider, bold, dim, highlight } from "./iris-api"
import { ensureYtDlp, which, downloadAudioMp3 } from "./download"
import { existsSync, mkdirSync, statSync } from "fs"
import { join } from "path"

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

    // 3. Download each track as a tagged MP3.
    const done: { title: string; artist: string; path: string }[] = []
    const failed: { title: string; artist: string; error: string }[] = []

    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]
      const n = String(i + 1).padStart(2, "0")
      const label = `${t.title} — ${t.artist}`
      const outBase = join(outDir, fsSlug(`${n} - ${t.artist} - ${t.title}`))

      // Skip if already downloaded (idempotent re-runs / resumable series launches).
      if (existsSync(`${outBase}.mp3`)) {
        if (!json) prompts.log.info(`${dim(`[${n}/${tracks.length}]`)} ${label} ${dim("(already downloaded)")}`)
        done.push({ title: t.title, artist: t.artist, path: `${outBase}.mp3` })
        continue
      }

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
      } else {
        sp?.stop(`[${n}/${tracks.length}] ${label} — ${r.error}`, 1)
        failed.push({ title: t.title, artist: t.artist, error: r.error || "unknown" })
      }
    }

    // 4. Summary.
    if (json) {
      console.log(JSON.stringify({ playlist: payload.name, outDir, downloaded: done, failed }, null, 2))
      if (failed.length) process.exitCode = 1
      return
    }

    printDivider()
    console.log(`  ${bold("Playlist")}   ${payload.name}`)
    console.log(`  ${bold("Matched")}    ${done.length}/${tracks.length}`)
    console.log(`  ${bold("Folder")}     ${highlight(outDir)}`)
    if (failed.length) {
      console.log()
      console.log(`  ${dim("Unmatched:")}`)
      for (const f of failed) console.log(`    ${dim("·")} ${f.title} — ${f.artist} ${dim(`(${f.error})`)}`)
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
