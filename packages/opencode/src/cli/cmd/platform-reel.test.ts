import { describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import { existsSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  assTime,
  buildAss,
  buildSrt,
  cutFilter,
  defaultCoverGap,
  groupWords,
  laplacianVariance,
  normaliseNoise,
  parseDuration,
  parseSilences,
  parseVideoSize,
  pickBestTake,
  pickSpreadFrames,
  scriptCoverage,
  speechSegments,
  srtTime,
  takeScore,
  takeStats,
  words,
  wrapTitle,
  type TakeStats,
} from "./platform-reel"
import { parseWhisperWords, type TranscriptWord } from "../lib/transcription"

/**
 * `iris reel` (Atlas #191299). Every decision the command makes — where the speech is, which
 * take wins, how words become caption lines, which frames become covers — is a pure function,
 * tested here without ffmpeg or a model. The last block runs `reel cut` end to end on a clip
 * ffmpeg synthesises, and skips itself on a machine without ffmpeg.
 */

// A real silencedetect log, trimmed: one interior pause, and a trailing silence that never ends.
const SILENCE_LOG = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'take.mp4':
  Duration: 00:00:06.02, start: 0.000000, bitrate: 151 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1080x1920 [SAR 1:1 DAR 9:16], 30 fps
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s
[silencedetect @ 0x5f] silence_start: 1.5
[silencedetect @ 0x5f] silence_end: 2.5 | silence_duration: 1
[silencedetect @ 0x5f] silence_start: 5.2
`

describe("ffmpeg banner parsing", () => {
  test("duration, size and streams come out of the banner", () => {
    expect(parseDuration(SILENCE_LOG)).toBeCloseTo(6.02, 5)
    expect(parseDuration("Duration: 01:02:03.50,")).toBeCloseTo(3723.5, 5)
    expect(parseDuration("no banner")).toBe(0)
    expect(parseVideoSize(SILENCE_LOG)).toEqual({ width: 1080, height: 1920 })
    expect(parseVideoSize("Stream #0:0: Audio: aac")).toBeNull()
  })
})

describe("silences → speech segments", () => {
  test("an unterminated silence runs to the end of the file", () => {
    expect(parseSilences(SILENCE_LOG, 6.02)).toEqual([
      { start: 1.5, end: 2.5 },
      { start: 5.2, end: 6.02 },
    ])
  })

  test("a silence that ends before any start was logged began at 0", () => {
    expect(parseSilences("silence_end: 0.8 | silence_duration: 0.8", 5)).toEqual([{ start: 0, end: 0.8 }])
  })

  test("speech is the complement, padded so words are not clipped", () => {
    const segs = speechSegments(parseSilences(SILENCE_LOG, 6.02), 6.02, 0.08)
    expect(segs).toEqual([
      { start: 0, end: 1.58 },
      { start: 2.42, end: 5.28 },
    ])
  })

  test("padding that makes neighbours touch merges them", () => {
    const segs = speechSegments([{ start: 1, end: 1.1 }], 3, 0.08)
    expect(segs).toEqual([{ start: 0, end: 3 }])
  })

  test("a click shorter than minSpeech is not speech", () => {
    const segs = speechSegments(
      [
        { start: 0, end: 1 },
        { start: 1.05, end: 3 },
      ],
      3,
      0.05,
      0.1,
    )
    expect(segs).toEqual([])
  })

  test("all-silence and no-silence files", () => {
    expect(speechSegments([{ start: 0, end: 4 }], 4)).toEqual([])
    expect(speechSegments([], 4)).toEqual([{ start: 0, end: 4 }])
  })

  test("cutFilter trims and concatenates audio and video together", () => {
    const f = cutFilter([
      { start: 0, end: 1.58 },
      { start: 2.42, end: 5.28 },
    ])
    expect(f).toContain("[0:v]trim=start=0:end=1.58,setpts=PTS-STARTPTS[v0]")
    expect(f).toContain("[0:a]atrim=start=2.42:end=5.28,asetpts=PTS-STARTPTS")
    expect(f).toEndWith("[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]")
  })

  test("--noise accepts a bare magnitude, since '-35dB' cannot be typed as a value", () => {
    expect(normaliseNoise("35")).toBe("-35dB")
    expect(normaliseNoise("35dB")).toBe("-35dB")
    expect(normaliseNoise("-40dB")).toBe("-40dB")
    expect(normaliseNoise("0.01")).toBe("0.01")
    expect(normaliseNoise(undefined)).toBe("-35dB")
  })
})

describe("take scoring", () => {
  const stats = (file: string, speech: number, longPauses: number, duration = 30): TakeStats => ({
    file,
    duration,
    speech,
    pauses: longPauses,
    longPauses,
    segments: [],
  })

  test("takeStats counts interior pauses only, and long ones separately", () => {
    const silences = [
      { start: 0, end: 0.9 }, // lead-in: not hesitation
      { start: 3, end: 3.4 },
      { start: 6, end: 7.5 }, // long
      { start: 9.5, end: 10 }, // tail: not hesitation
    ]
    const t = takeStats("a.mp4", silences, 10, speechSegments(silences, 10, 0))
    expect(t.pauses).toBe(2)
    expect(t.longPauses).toBe(1)
    expect(t.speech).toBeCloseTo(10 - 0.9 - 0.4 - 1.5 - 0.5, 3)
  })

  test("score is speech minus one second per long pause", () => {
    expect(takeScore({ speech: 20, longPauses: 3 })).toBe(17)
  })

  test("without a script, most speech net of long pauses wins and says why", () => {
    const takes = [stats("a.mp4", 20, 0), stats("b.mp4", 22, 4), stats("c.mp4", 19, 0)]
    const v = pickBestTake(takes)
    expect(v.index).toBe(0)
    expect(v.reason).toContain("20.0s")
    expect(v.reason).toContain("c.mp4") // b has more speech but 4 long pauses: 22 − 4 = 18 < 19
  })

  test("a score tie goes to the shorter take", () => {
    expect(pickBestTake([stats("long.mp4", 20, 0, 40), stats("short.mp4", 20, 0, 25)]).index).toBe(1)
  })

  test("with a script, coverage beats speech", () => {
    const takes = [stats("a.mp4", 30, 0), stats("b.mp4", 10, 2)]
    const v = pickBestTake(takes, [0.6, 0.95])
    expect(v.index).toBe(1)
    expect(v.reason).toContain("95%")
  })

  test("equal coverage falls back to the speech score", () => {
    const v = pickBestTake([stats("a.mp4", 10, 0), stats("b.mp4", 12, 0)], [0.9, 0.9])
    expect(v.index).toBe(1)
    expect(v.reason).toContain("ties on script coverage")
  })

  test("one take wins by default", () => {
    expect(pickBestTake([stats("only.mp4", 5, 0)])).toEqual({ index: 0, reason: "only one take" })
  })
})

describe("script coverage", () => {
  test("tokenises case-, punctuation- and apostrophe-safely", () => {
    expect(words("Don't STOP — believin’!")).toEqual(["don't", "stop", "believin"])
  })

  test("share of the script's words the transcript says", () => {
    expect(scriptCoverage("one two three four", "one two three four")).toBe(1)
    expect(scriptCoverage("one two three four", "uh one two, um, four")).toBe(0.75)
    expect(scriptCoverage("", "anything")).toBe(0)
  })

  test("repeats must be said as many times as written", () => {
    expect(scriptCoverage("the cat and the hat", "the cat and hat")).toBe(0.8)
  })
})

describe("words → caption lines → ASS / SRT", () => {
  const w = (word: string, t0: number, t1: number): TranscriptWord => ({ word, t0, t1 })
  const sample = [
    w("Anthropic", 0, 0.49),
    w("said", 0.49, 0.66),
    w("you", 0.66, 0.81),
    w("might", 0.81, 1.06),
    w("not.", 1.06, 1.21),
    w("Then", 2.5, 2.7), // after a 1.29s gap
    w("this", 2.7, 2.9),
  ]

  test("lines of N words, broken early at sentence ends and pauses", () => {
    const lines = groupWords(sample, 3)
    expect(lines.map((l) => l.words.map((x) => x.word).join(" "))).toEqual([
      "Anthropic said you",
      "might not.",
      "Then this",
    ])
  })

  test("a line is held a moment past its last word, never into the next", () => {
    const lines = groupWords(sample, 3)
    expect(lines[0].end).toBe(0.81) // the next line starts at 0.81: no hold possible
    expect(lines[1].end).toBeCloseTo(1.46, 5) // 1.21 + 0.25
  })

  test("whisper rows become words; punctuation-only rows join the word before", () => {
    const raw = {
      transcription: [
        { offsets: { from: 0, to: 0 }, text: "" },
        { offsets: { from: 0, to: 490 }, text: " Hello" },
        { offsets: { from: 490, to: 520 }, text: "," },
        { offsets: { from: 520, to: 900 }, text: " world" },
        { offsets: { from: 900, to: 1500 }, text: " [BLANK_AUDIO]" },
      ],
    }
    expect(parseWhisperWords(raw)).toEqual([
      { word: "Hello,", t0: 0, t1: 0.52 },
      { word: "world", t0: 0.52, t1: 0.9 },
    ])
  })

  test("time formats", () => {
    expect(assTime(0)).toBe("0:00:00.00")
    expect(assTime(75.286)).toBe("0:01:15.29")
    expect(srtTime(3723.5)).toBe("01:02:03,500")
  })

  const lines = groupWords(sample, 3)

  test("pop: one event per word, the spoken word highlighted, the rest plain", () => {
    const ass = buildAss(lines, { width: 1080, height: 1920, style: "pop" })
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"))
    expect(events.length).toBe(sample.length)
    expect(events[1]).toBe(
      "Dialogue: 0,0:00:00.49,0:00:00.66,Reel,,0,0,0,,Anthropic {\\c&H0000D4FF&\\fscx108\\fscy108}said{\\r} you",
    )
  })

  test("plain: one event per line", () => {
    const ass = buildAss(lines, { width: 1080, height: 1920, style: "plain" })
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"))
    expect(events).toEqual([
      "Dialogue: 0,0:00:00.00,0:00:00.81,Reel,,0,0,0,,Anthropic said you",
      "Dialogue: 0,0:00:00.81,0:00:01.46,Reel,,0,0,0,,might not.",
      "Dialogue: 0,0:00:02.50,0:00:03.15,Reel,,0,0,0,,Then this",
    ])
  })

  test("lower sits above the bottom 20% UI zone; center is centred", () => {
    const lower = buildAss(lines, { width: 1080, height: 1920, position: "lower" })
    const style = lower.split("\n").find((l) => l.startsWith("Style: Reel"))!.split(",")
    expect(lower).toContain("PlayResY: 1920")
    expect(style[18]).toBe("2") // bottom-centre
    expect(Number(style[21])).toBeGreaterThanOrEqual(1920 * 0.2) // MarginV
    const center = buildAss(lines, { width: 1080, height: 1920, position: "center" })
    expect(center.split("\n").find((l) => l.startsWith("Style: Reel"))!.split(",")[18]).toBe("5")
  })

  test("ASS override characters in speech cannot inject tags", () => {
    const ass = buildAss([{ start: 0, end: 1, words: [w("{\\b1}x", 0, 1)] }], { width: 1080, height: 1920, style: "plain" })
    expect(ass).toContain(",,(\\\\b1)x")
  })

  test("SRT has one numbered cue per line", () => {
    expect(buildSrt(lines.slice(0, 1))).toBe("1\n00:00:00,000 --> 00:00:00,810\nAnthropic said you\n")
  })
})

describe("covers", () => {
  test("a sharp checkerboard outscores a flat grey; black frames score 0", () => {
    const W = 16
    const H = 16
    const checker = new Uint8Array(W * H).map((_, i) => ((i % W) + Math.floor(i / W)) % 2 ? 200 : 60)
    const flat = new Uint8Array(W * H).fill(128)
    const black = new Uint8Array(W * H).fill(5)
    expect(laplacianVariance(checker, W, H)).toBeGreaterThan(laplacianVariance(flat, W, H))
    expect(laplacianVariance(flat, W, H)).toBe(0)
    expect(laplacianVariance(black, W, H)).toBe(0)
  })

  test("picks the sharpest frames but never two from the same moment", () => {
    const frames = [
      { t: 0, score: 10 },
      { t: 0.5, score: 99 },
      { t: 1.0, score: 98 }, // adjacent to the best: skipped
      { t: 1.5, score: 97 }, // still too close
      { t: 5, score: 50 },
      { t: 9, score: 40 },
    ]
    expect(pickSpreadFrames(frames, 3, 2).map((f) => f.t)).toEqual([0.5, 5, 9])
  })

  test("returns fewer than asked when the clip is too short to spread them", () => {
    expect(pickSpreadFrames([{ t: 0, score: 1 }, { t: 0.5, score: 2 }], 3, 2)).toHaveLength(1)
  })

  test("default gap scales with duration and has a floor", () => {
    expect(defaultCoverGap(75, 3)).toBeCloseTo(8.333, 3)
    expect(defaultCoverGap(2, 3)).toBe(1)
  })

  test("titles wrap on word boundaries", () => {
    expect(wrapTitle("Stop building agents: one agent + a playbook", 14)).toEqual([
      "Stop building",
      "agents: one",
      "agent + a",
      "playbook",
    ])
    expect(wrapTitle("  ", 14)).toEqual([])
  })
})

// ----------------------------------------------------------------------------
// End to end: a synthetic take with two 1s gaps → `iris reel cut` → a shorter, in-sync mp4.
// ----------------------------------------------------------------------------

const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0

describe.skipIf(!ffmpeg)("reel cut, end to end (needs ffmpeg)", () => {
  test(
    "removes the gaps and keeps audio and video the same length",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "iris-reel-test-"))
      try {
        const take = join(dir, "take.mp4")
        const out = join(dir, "cut.mp4")
        // 6s of tone with silence at 1.5–2.5 and 4.0–5.0, over a test pattern.
        const gen = spawnSync(
          "ffmpeg",
          [
            "-v", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=size=270x480:rate=30:duration=6",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=6,volume='if(between(t,1.5,2.5)+between(t,4,5),0,1)':eval=frame",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", take,
          ],
          { encoding: "utf8" },
        )
        expect(gen.status).toBe(0)

        const run = spawnSync(
          process.execPath,
          ["run", join(import.meta.dir, "..", "..", "index.ts"), "reel", "cut", take, "--out", out, "--json"],
          { encoding: "utf8", timeout: 120_000, env: { ...process.env, NO_COLOR: "1" } },
        )
        expect(run.status).toBe(0)
        const report = JSON.parse(run.stdout.slice(run.stdout.indexOf("{")))
        expect(report.ok).toBe(true)
        expect(report.takes[0].pauses).toBe(2)
        expect(existsSync(out)).toBe(true)

        // 6s minus two 1s gaps, plus 0.08s of padding either side of each gap.
        expect(report.before).toBeCloseTo(6, 1)
        expect(report.after).toBeGreaterThan(4.1)
        expect(report.after).toBeLessThan(4.6)

        const probe = spawnSync(
          "ffprobe",
          ["-v", "error", "-show_entries", "stream=codec_name,codec_type,duration", "-of", "json", out],
          { encoding: "utf8" },
        )
        const streams = JSON.parse(probe.stdout).streams as Array<{ codec_name: string; codec_type: string; duration: string }>
        const v = streams.find((s) => s.codec_type === "video")!
        const a = streams.find((s) => s.codec_type === "audio")!
        expect(v.codec_name).toBe("h264")
        expect(a.codec_name).toBe("aac")
        expect(Math.abs(Number(v.duration) - Number(a.duration))).toBeLessThan(0.1)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    180_000,
  )
})
