import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  cancelCapture,
  currentLevel,
  inputCandidates,
  parseDshowAudioDevices,
  parseFfmpegDevices,
  peakAmplitude,
  recorderReadiness,
  startCapture,
  stopCapture,
} from "../../src/transcribe/capture"
import { TranscribeError } from "../../src/transcribe/local"

// ── Fixtures: ffmpeg's own words, as printed by real builds ─────────────────────────────────

/** ffmpeg 6.x/7.x (gyan.dev build, Windows 11 laptop): one line per device, kind in parens. */
const DSHOW_NEW = `[dshow @ 0000020c5e0e8a00] "Integrated Webcam" (video)
[dshow @ 0000020c5e0e8a00]   Alternative name "@device_pnp_\\\\?\\usb#vid_0c45&pid_6a10&mi_00#6&2b3c4d5e&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global"
[dshow @ 0000020c5e0e8a00] "OBS Virtual Camera" (none)
[dshow @ 0000020c5e0e8a00]   Alternative name "@device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}\\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}"
[dshow @ 0000020c5e0e8a00] "Microphone Array (Intel® Smart Sound Technology for Digital Microphones)" (audio)
[dshow @ 0000020c5e0e8a00]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{6B1E4D3A-1F8C-4E7B-9C1A-2D3E4F5A6B7C}"
[dshow @ 0000020c5e0e8a00] "Headset Microphone (Jabra Evolve2 65)" (audio)
[dshow @ 0000020c5e0e8a00]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9}"
[in#0 @ 0000020c5e0d1b40] Error opening input: Immediate exit requested
Error opening input file dummy.
`

/** ffmpeg 4.x: section headers, devices listed under them with no kind suffix. */
const DSHOW_OLD = `[dshow @ 000001f8a7c4e2c0] DirectShow video devices (some may be both video and audio devices)
[dshow @ 000001f8a7c4e2c0]  "USB2.0 HD UVC WebCam"
[dshow @ 000001f8a7c4e2c0]     Alternative name "@device_pnp_\\\\?\\usb#vid_13d3&pid_56a6&mi_00#6&1a2b3c4d&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global"
[dshow @ 000001f8a7c4e2c0] DirectShow audio devices
[dshow @ 000001f8a7c4e2c0]  "Microphone (Realtek(R) Audio)"
[dshow @ 000001f8a7c4e2c0]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{D5B2E1C4-3F6A-4B8D-9E0F-1A2B3C4D5E6F}"
dummy: Immediate exit requested
`

/** A machine with a camera and no microphone at all. */
const DSHOW_NO_AUDIO = `[dshow @ 000001d2c3e4f500] "Integrated Camera" (video)
[dshow @ 000001d2c3e4f500]   Alternative name "@device_pnp_\\\\?\\usb#vid_04f2&pid_b6d9"
[dshow @ 000001d2c3e4f500] Could not enumerate audio only devices (or none found).
[in#0 @ 000001d2c3e4f420] Error opening input: Immediate exit requested
Error opening input file dummy.
`

/** \`ffmpeg -hide_banner -devices\` from Ubuntu 24.04's ffmpeg 6.1. */
const DEVICES_LINUX = `Devices:
 D. = Demuxing supported
 .E = Muxing supported
 ---
 DE alsa            ALSA audio output
  E caca            caca (color ASCII art) output device
 DE fbdev           Linux framebuffer
 D  iec61883        libiec61883 (new DV1394) A/V input device
 D  jack            JACK Audio Connection Kit
 D  kmsgrab         KMS screen capture
 D  lavfi           Libavfilter virtual input device
 D  libcdio
 D  openal          OpenAL audio capture device
  E opengl          OpenGL output
 DE oss             OSS (Open Sound System) playback
 DE pulse           Pulse audio output
  E sdl,sdl2        SDL2 output device
 DE sndio           sndio audio playback
 DE video4linux2,v4l2 Video4Linux2 output device
 D  x11grab         X11 screen capture, using XCB
`

describe("parseDshowAudioDevices", () => {
  test("ffmpeg 6+: audio devices only, in order, with their alternative names", () => {
    expect(parseDshowAudioDevices(DSHOW_NEW)).toEqual([
      {
        name: "Microphone Array (Intel® Smart Sound Technology for Digital Microphones)",
        alternative: "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{6B1E4D3A-1F8C-4E7B-9C1A-2D3E4F5A6B7C}",
      },
      {
        name: "Headset Microphone (Jabra Evolve2 65)",
        alternative: "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9}",
      },
    ])
  })

  test("ffmpeg 4: devices under the audio section header", () => {
    expect(parseDshowAudioDevices(DSHOW_OLD)).toEqual([
      {
        name: "Microphone (Realtek(R) Audio)",
        alternative: "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{D5B2E1C4-3F6A-4B8D-9E0F-1A2B3C4D5E6F}",
      },
    ])
  })

  test("CRLF output parses the same", () => {
    expect(parseDshowAudioDevices(DSHOW_NEW.replace(/\n/g, "\r\n")).map((d) => d.name)).toEqual([
      "Microphone Array (Intel® Smart Sound Technology for Digital Microphones)",
      "Headset Microphone (Jabra Evolve2 65)",
    ])
  })

  test("a camera-only machine has no audio devices", () => {
    expect(parseDshowAudioDevices(DSHOW_NO_AUDIO)).toEqual([])
    expect(parseDshowAudioDevices("")).toEqual([])
  })

  test("a device that is both audio and video counts", () => {
    const text = `[dshow @ 01] "Elgato Cam Link 4K" (audio, video)\n[dshow @ 01]   Alternative name "@device_pnp_x"\n`
    expect(parseDshowAudioDevices(text)).toEqual([{ name: "Elgato Cam Link 4K", alternative: "@device_pnp_x" }])
  })
})

describe("parseFfmpegDevices", () => {
  test("lists only the input (demuxing) devices", () => {
    const inputs = parseFfmpegDevices(DEVICES_LINUX)
    expect(inputs).toContain("alsa")
    expect(inputs).toContain("pulse")
    expect(inputs).toContain("x11grab")
    expect(inputs).not.toContain("caca")
    expect(inputs).not.toContain("opengl")
    expect(inputs).toContain("video4linux2")
  })
})

// ── A fake ffmpeg, so the whole capture pipeline runs on any machine ────────────────────────

let dir: string
let fake: string
let pcm: string
const savedFfmpeg = process.env["IRIS_FFMPEG"]

/** 0.5 full-scale square wave: RMS exactly 0.5, so the level meter's number is checkable. */
function squarePcm(samples: number, amplitude = 0.5) {
  const out = new Uint8Array(samples * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, (i % 2 ? -1 : 1) * Math.round(amplitude * 0x7fff), true)
  return out
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "iris-fake-ffmpeg-"))
  pcm = join(dir, "voice.pcm")
  writeFileSync(pcm, squarePcm(16000)) // one second
  writeFileSync(join(dir, "dshow.txt"), DSHOW_NEW)
  writeFileSync(join(dir, "devices.txt"), DEVICES_LINUX)
  fake = join(dir, "ffmpeg")
  // Behaviour by argv: -devices and -list_devices print fixtures; alsa can be made to fail
  // (FAKE_ALSA=fail) the way an ALSA-less host does; any real capture streams PCM to stdout and
  // then waits to be stopped, recording its own argv for the test to inspect.
  writeFileSync(
    fake,
    `#!/bin/sh
case "$*" in
  *-devices*) cat "${dir}/devices.txt"; exit 0;;
  *-list_devices*) cat "${dir}/dshow.txt" >&2; exit 1;;
esac
echo "$*" >> "${dir}/argv.log"
case "$*" in
  *"-f alsa"*) if [ "$FAKE_ALSA" = "fail" ]; then echo "[alsa @ 0x5581] cannot open audio device default (No such file or directory)" >&2; echo "default: Input/output error" >&2; exit 1; fi;;
esac
cat "${pcm}"
exec sleep 30
`,
  )
  chmodSync(fake, 0o755)
  process.env["IRIS_FFMPEG"] = fake
})
afterEach(() => {
  cancelCapture()
  delete process.env["FAKE_ALSA"]
  rmSync(join(dir, "argv.log"), { force: true })
})
afterAll(() => {
  if (savedFfmpeg === undefined) delete process.env["IRIS_FFMPEG"]
  else process.env["IRIS_FFMPEG"] = savedFfmpeg
  rmSync(dir, { recursive: true, force: true })
})

describe("inputCandidates — what each platform records from", () => {
  test("Windows records from the first DirectShow microphone, by its stable alternative name", () => {
    const inputs = inputCandidates("win32", fake)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]!.args).toEqual([
      "-f",
      "dshow",
      "-audio_buffer_size",
      "50",
      "-i",
      "audio=@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{6B1E4D3A-1F8C-4E7B-9C1A-2D3E4F5A6B7C}",
    ])
    expect(inputs[0]!.label).toContain("Microphone Array")
  })

  test("Windows honours a named device", () => {
    const inputs = inputCandidates("win32", fake, "Headset Microphone (Jabra Evolve2 65)")
    expect(inputs[0]!.label).toBe("Headset Microphone (Jabra Evolve2 65)")
  })

  test("Windows with no microphone says so in Windows terms — no brew, no apt", () => {
    writeFileSync(join(dir, "dshow.txt"), DSHOW_NO_AUDIO)
    try {
      const err = (() => {
        try {
          inputCandidates("win32", fake)
        } catch (e) {
          return e as Error
        }
      })()
      expect(err).toBeInstanceOf(TranscribeError)
      expect(err!.message).toContain("No microphone")
      expect(err!.message).toContain("Windows")
      expect(err!.message).not.toMatch(/brew|apt|System Settings ›/)
    } finally {
      writeFileSync(join(dir, "dshow.txt"), DSHOW_NEW)
    }
  })

  test("Linux tries ALSA, then PulseAudio", () => {
    expect(inputCandidates("linux", fake).map((i) => i.args)).toEqual([
      ["-f", "alsa", "-i", "default"],
      ["-f", "pulse", "-i", "default"],
    ])
  })

  test("macOS records from the system default input", () => {
    expect(inputCandidates("darwin", fake).map((i) => i.args)).toEqual([["-f", "avfoundation", "-i", ":default"]])
  })
})

describe("recorderReadiness — can the sidecar record here, and if not, why", () => {
  test("ready where ffmpeg and an input exist", () => {
    expect(recorderReadiness("win32", fake)).toEqual({ sidecar: true })
    expect(recorderReadiness("linux", fake)).toEqual({ sidecar: true })
    expect(recorderReadiness("darwin", fake)).toEqual({ sidecar: true })
  })

  test("no ffmpeg on Windows: a winget remedy, never brew or apt", () => {
    const r = recorderReadiness("win32", null)
    expect(r.sidecar).toBe(false)
    expect(r.reason).toContain("winget install Gyan.FFmpeg")
    expect(r.reason).not.toMatch(/brew|apt/)
  })

  test("no ffmpeg on Linux: an apt remedy, never brew", () => {
    const r = recorderReadiness("linux", null)
    expect(r.sidecar).toBe(false)
    expect(r.reason).toContain("apt install ffmpeg")
    expect(r.reason).not.toMatch(/brew|winget|System Settings ›/)
  })

  test("no ffmpeg on macOS: brew", () => {
    expect(recorderReadiness("darwin", null).reason).toContain("brew install ffmpeg")
  })

  test("Windows with no microphone is not ready, and says so", () => {
    writeFileSync(join(dir, "dshow.txt"), DSHOW_NO_AUDIO)
    try {
      const r = recorderReadiness("win32", fake)
      expect(r.sidecar).toBe(false)
      expect(r.reason).toContain("No microphone")
    } finally {
      writeFileSync(join(dir, "dshow.txt"), DSHOW_NEW)
    }
  })

  test("an unsupported platform is not ready", () => {
    expect(recorderReadiness("freebsd", fake).sidecar).toBe(false)
  })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const linuxOnly = process.platform === "linux" ? test : test.skip

describe("capture pipeline (fake ffmpeg)", () => {
  test("level is zero when nothing is recording", () => {
    expect(currentLevel()).toEqual({ level: 0, seconds: 0 })
  })

  linuxOnly("streams PCM from ffmpeg's stdout: a live level while recording, a WAV at stop", async () => {
    startCapture()
    await sleep(300)
    const live = currentLevel()
    expect(live.level).toBeCloseTo(0.5, 2)
    expect(live.seconds).toBeGreaterThan(0)
    const { audio, input } = await stopCapture()
    expect(input).toBe("alsa")
    expect(audio.length).toBe(44 + 32000)
    expect(peakAmplitude(audio)).toBeCloseTo(0.5, 2)
    expect(currentLevel()).toEqual({ level: 0, seconds: 0 })
  })

  linuxOnly("output goes to stdout, not a file: 16 kHz mono s16le, capped at five minutes", async () => {
    startCapture()
    await sleep(200)
    await stopCapture()
    const argv = await Bun.file(join(dir, "argv.log")).text()
    expect(argv).toContain("-ar 16000")
    expect(argv).toContain("-f s16le")
    expect(argv).toContain("-t 300")
    expect(argv.trim().endsWith("pipe:1")).toBe(true)
  })

  linuxOnly("falls back from ALSA to PulseAudio when ALSA cannot open", async () => {
    process.env["FAKE_ALSA"] = "fail"
    startCapture()
    await sleep(400)
    expect(currentLevel().level).toBeCloseTo(0.5, 2)
    const { audio, input } = await stopCapture()
    expect(input).toBe("pulse")
    expect(audio.length).toBe(44 + 32000)
    const argv = await Bun.file(join(dir, "argv.log")).text()
    expect(argv).toContain("-f alsa")
    expect(argv).toContain("-f pulse")
  })
})
