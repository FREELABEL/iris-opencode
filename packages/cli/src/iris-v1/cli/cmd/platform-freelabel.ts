import type { CommandModule } from "yargs"
import { spawnSync } from "child_process"
import { existsSync, readdirSync, writeFileSync, statSync, unlinkSync } from "fs"
import { join, basename, resolve } from "path"
import { homedir } from "os"
import { which, retagMp3, id3Key } from "./download"
import { analyzeAudio } from "./audio-analysis"
import { printDivider, bold, dim } from "./iris-api"

/** Seconds of audio in a file, via ffprobe. null when it cannot be read. */
function durationOf(ffprobe: string, path: string): number | null {
  const r = spawnSync(
    ffprobe,
    ["-v", "quiet", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
    { encoding: "utf8", timeout: 20_000 },
  )
  const n = parseFloat((r.stdout || "").trim())
  return Number.isFinite(n) ? n : null
}

/** Existing ID3 tags as a flat map. */
function tagsOf(ffprobe: string, path: string): Record<string, string> {
  const r = spawnSync(
    ffprobe,
    ["-v", "quiet", "-show_entries", "format_tags", "-of", "default=noprint_wrappers=1", path],
    { encoding: "utf8", timeout: 20_000 },
  )
  const out: Record<string, string> = {}
  for (const line of (r.stdout || "").split("\n")) {
    const i = line.indexOf("=")
    if (i > 0) out[line.slice(0, i).replace(/^TAG:/, "").toUpperCase()] = line.slice(i + 1)
  }
  return out
}

function mp3sIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".mp3"))
    .sort()
    .map((f) => join(dir, f))
}

/** Artist and title, preferring real tags and falling back to the "NN - Artist - Title" filename. */
function nameOf(tags: Record<string, string>, path: string): { artist: string; title: string } {
  const stem = basename(path).replace(/\.mp3$/i, "")
  const parts = stem.split(" - ")
  return {
    artist: tags.ARTIST || (parts.length >= 3 ? parts[1] : parts[0]) || "Unknown",
    title: tags.TITLE || (parts.length >= 3 ? parts.slice(2).join(" - ") : parts.slice(1).join(" - ")) || stem,
  }
}

const TagCommand: CommandModule = {
  command: "tag <dir>",
  describe: "write BPM and key into the MP3s as real ID3 frames, so any DJ app reads them",
  builder: (yargs) =>
    yargs
      .positional("dir", { describe: "folder of .mp3 files", type: "string", demandOption: true })
      .option("force", { describe: "re-tag files that already carry TBPM", type: "boolean", default: false }),
  handler: async (argv: any) => {
    const dir = resolve(argv.dir)
    const ffmpeg = which("ffmpeg")
    const ffprobe = which("ffprobe")
    if (!ffmpeg || !ffprobe) {
      console.log("ffmpeg and ffprobe are required (brew install ffmpeg)")
      process.exitCode = 1
      return
    }
    const files = mp3sIn(dir)
    if (!files.length) {
      console.log(`no .mp3 files in ${dir}`)
      process.exitCode = 1
      return
    }

    console.log(bold(`Tagging ${files.length} track(s)`))
    console.log(dim(`  ${dir}`))
    printDivider()

    let tagged = 0,
      skipped = 0,
      failed = 0
    for (const [i, f] of files.entries()) {
      const name = basename(f)
      const existing = tagsOf(ffprobe, f)
      if (existing.TBPM && !argv.force) {
        skipped++
        console.log(dim(`  [${i + 1}/${files.length}] ${name} — already tagged (${existing.TBPM} BPM)`))
        continue
      }
      // The analyser is the slow part; it is why this is a separate command and not
      // a step inside the ingest, which already has enough to do per track.
      const a = analyzeAudio(f)
      if (!a) {
        failed++
        console.log(`  [${i + 1}/${files.length}] ${name} — analysis FAILED`)
        continue
      }
      const ok = retagMp3(ffmpeg, f, { bpm: a.bpm, key: id3Key(a.key), camelot: a.camelot })
      if (ok) {
        tagged++
        console.log(`  [${i + 1}/${files.length}] ${name} — ${Math.round(a.bpm)} BPM, ${id3Key(a.key) ?? "?"}, ${a.camelot}`)
      } else {
        failed++
        console.log(`  [${i + 1}/${files.length}] ${name} — retag FAILED`)
      }
    }
    printDivider()
    console.log(`  tagged ${tagged}   skipped ${skipped}   failed ${failed}`)
    if (failed) process.exitCode = 1
  },
}

const ExportCommand: CommandModule = {
  command: "export <dir>",
  describe: "write a playlist file the DJ apps import (m3u8 today; rekordbox/serato later)",
  builder: (yargs) =>
    yargs
      .positional("dir", { describe: "folder of .mp3 files", type: "string", demandOption: true })
      .option("format", { describe: "playlist format", choices: ["m3u8"], default: "m3u8" })
      .option("out", { describe: "output file (default: <dir>/<folder>.m3u8)", type: "string" }),
  handler: async (argv: any) => {
    const dir = resolve(argv.dir)
    const ffprobe = which("ffprobe")
    if (!ffprobe) {
      console.log("ffprobe is required (brew install ffmpeg)")
      process.exitCode = 1
      return
    }
    const files = mp3sIn(dir)
    if (!files.length) {
      console.log(`no .mp3 files in ${dir}`)
      process.exitCode = 1
      return
    }
    const out = argv.out ? resolve(argv.out) : join(dir, `${basename(dir)}.m3u8`)

    // Absolute paths: a relative .m3u8 breaks the moment the file is opened from
    // anywhere but its own folder, and DJ apps import from all over the place.
    const lines = ["#EXTM3U"]
    for (const f of files) {
      const t = tagsOf(ffprobe, f)
      const { artist, title } = nameOf(t, f)
      const d = durationOf(ffprobe, f)
      lines.push(`#EXTINF:${d ? Math.round(d) : -1},${artist} - ${title}`)
      lines.push(f)
    }
    writeFileSync(out, lines.join("\n") + "\n", "utf8")

    console.log(bold("Exported"))
    console.log(`  format : ${argv.format}`)
    console.log(`  tracks : ${files.length}`)
    console.log(`  file   : ${out}`)
    printDivider()
    console.log(dim("  Mixxx    → right-click Playlists → Import Playlist → pick this file"))
    console.log(dim("  rekordbox/Serato also import .m3u8; native formats are not built yet"))
  },
}

const VerifyCommand: CommandModule = {
  command: "verify <dir>",
  describe: "audit a crate: wrong-length matches, leaked intermediates, missing BPM/key",
  builder: (yargs) =>
    yargs
      .positional("dir", { describe: "folder of .mp3 files", type: "string", demandOption: true })
      .option("min", { describe: "shortest plausible track, seconds", type: "number", default: 30 })
      .option("max", { describe: "longest plausible track, seconds", type: "number", default: 720 }),
  handler: async (argv: any) => {
    const dir = resolve(argv.dir)
    const ffprobe = which("ffprobe")
    if (!ffprobe) {
      console.log("ffprobe is required (brew install ffmpeg)")
      process.exitCode = 1
      return
    }
    const files = mp3sIn(dir)
    console.log(bold(`Auditing ${files.length} track(s)`))
    console.log(dim(`  ${dir}`))
    printDivider()

    // 1. Wrong match. A text search always returns SOMETHING; it cannot fail, only be
    // wrong. An 8-hour ambient loop once matched a 3-minute song and reached publish.
    let suspect = 0
    for (const f of files) {
      const d = durationOf(ffprobe, f)
      if (d === null) continue
      if (d < argv.min || d > argv.max) {
        suspect++
        console.log(`  SUSPECT  ${(d / 60).toFixed(1)} min  ${basename(f)}`)
      }
    }
    console.log(suspect ? `  ${suspect} duration outlier(s) — verify before publishing` : "  durations: clean")

    // 2. Leaked intermediates from a failed extraction.
    const junk = existsSync(dir)
      ? readdirSync(dir).filter((f) => /\.(webm|part|ytdl)$/i.test(f) || /\.retag\.mp3$/i.test(f))
      : []
    if (junk.length) {
      const bytes = junk.reduce((n, f) => n + (statSync(join(dir, f)).size || 0), 0)
      console.log(`  ${junk.length} orphaned intermediate(s), ${(bytes / 1048576).toFixed(0)} MB reclaimable`)
      for (const f of junk.slice(0, 5)) console.log(dim(`    ${f}`))
    } else {
      console.log("  intermediates: clean")
    }

    // 3. Harmonic tag coverage.
    let withBpm = 0,
      withKey = 0
    for (const f of files) {
      const t = tagsOf(ffprobe, f)
      if (t.TBPM) withBpm++
      if (t.TKEY) withKey++
    }
    console.log(`  BPM tagged: ${withBpm}/${files.length}   key tagged: ${withKey}/${files.length}`)
    if (withBpm < files.length) console.log(dim("    fix with: iris discover crate tag <dir>"))
    printDivider()
    if (suspect) process.exitCode = 1
  },
}

const MixxxCommand: CommandModule = {
  command: "mixxx <dir>",
  describe: "check whether Mixxx can see this crate, and say exactly what to do if not",
  builder: (yargs) =>
    yargs.positional("dir", { describe: "folder of .mp3 files", type: "string", demandOption: true }),
  handler: async (argv: any) => {
    const dir = resolve(argv.dir)
    const db = join(homedir(), "Library", "Application Support", "Mixxx", "mixxxdb.sqlite")

    console.log(bold("Mixxx"))
    if (!existsSync(db)) {
      console.log("  Mixxx library not found at the standard macOS location:")
      console.log(dim(`    ${db}`))
      console.log("  Install Mixxx and run it once, then re-run this.")
      process.exitCode = 1
      return
    }
    console.log(dim(`  library: ${db}`))

    // Read-only on purpose. Writing to a live mixxxdb.sqlite can corrupt someone's whole
    // collection, so this command reports and instructs rather than editing the database.
    const running = spawnSync("pgrep", ["-x", "Mixxx"], { encoding: "utf8" })
    const isRunning = (running.stdout || "").trim().length > 0
    const q = spawnSync("sqlite3", [db, "SELECT directory FROM directories;"], { encoding: "utf8", timeout: 15_000 })
    const dirs = (q.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean)

    const covered = dirs.find((d) => dir === d || dir.startsWith(d.endsWith("/") ? d : d + "/"))
    printDivider()
    if (covered) {
      console.log(`  ✓ this crate is inside a Mixxx music directory:`)
      console.log(dim(`      ${covered}`))
      console.log("  If tracks are missing, run: Library → Rescan Library in Mixxx.")
    } else {
      console.log("  ✗ Mixxx does not index this folder yet. Add it once:")
      console.log("      Mixxx → Preferences → Library → Music Directories → Add…")
      console.log(dim(`      ${dir}`))
      console.log("  Then Library → Rescan Library.")
      if (dirs.length) {
        console.log(dim(`  (currently indexed: ${dirs.slice(0, 3).join(", ")}${dirs.length > 3 ? " …" : ""})`))
      }
    }
    printDivider()
    console.log(dim(`  Mixxx is ${isRunning ? "RUNNING" : "not running"}.`))
    console.log(dim("  BPM/key come from the TBPM and TKEY ID3 frames — run `crate tag` first if they are missing."))
    console.log(dim("  Mixxx may still re-detect BPM itself; see Preferences → Analyzer."))
  },
}

export const CrateCommand: CommandModule = {
  command: "crate",
  describe: "prepare a downloaded playlist for a DJ app — tag, export, verify, and wire into Mixxx",
  builder: (yargs) =>
    yargs
      .command(TagCommand)
      .command(ExportCommand)
      .command(VerifyCommand)
      .command(MixxxCommand)
      .demandCommand(1, "Specify: tag, export, verify, mixxx"),
  handler: () => {},
}

/**
 * FREELABEL — brand-scoped tooling.
 *
 * Deliberately NOT a top-level `crate` command. Crate preparation is one brand's
 * product surface, not a generic capability of the CLI, and a top-level verb would
 * imply it works for anyone's library.
 */
export const FreelabelCommand: CommandModule = {
  command: "freelabel",
  describe: "FREELABEL brand tooling — DJ crate preparation for downloaded playlists",
  builder: (yargs) => yargs.command(CrateCommand).demandCommand(1, "Specify: crate"),
  handler: () => {},
}
