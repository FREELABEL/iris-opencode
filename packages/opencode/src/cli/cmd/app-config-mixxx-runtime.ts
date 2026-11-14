/**
 * The parts of `iris app-config apply mixxx` that touch the real machine (#193298): what MIDI and
 * audio devices macOS can see, quitting Mixxx, starting it, and reading its log until it shows
 * the setup working. Kept apart from app-config-mixxx.ts so no test can reach any of it.
 *
 * Devices are read through bun:ffi straight from CoreMIDI and CoreAudio — no Xcode, no Python,
 * nothing a fresh Mac does not already have. (JXA can read CoreMIDI names but segfaults passing
 * CoreAudio's property-address struct; measured 2026-11-11.)
 */

import { dlopen, FFIType as T, ptr } from "bun:ffi"
import { execFileSync } from "child_process"
import { existsSync, readFileSync, statSync } from "fs"
import { join } from "path"
import type { AppRuntime, AudioDevice, Bundle, Host, PlanContext, Problem } from "./app-config-engine"
import { planMixxx } from "./app-config-mixxx"

const UTF8 = 0x08000100 // kCFStringEncodingUTF8

const fourcc = (s: string) => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0

let ffi: any = null
function lib() {
  if (ffi) return ffi
  // Opened on first use, and only on macOS: importing bun:ffi is harmless elsewhere, dlopen is not.
  const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
    // A CFStringRef can be a tagged pointer above 2^53, so it travels as a u64 BigInt, never a Number.
    CFStringGetCString: { args: [T.u64, T.ptr, T.i64, T.u32], returns: T.bool },
    CFStringCreateWithCString: { args: [T.ptr, T.ptr, T.u32], returns: T.u64 },
    CFRelease: { args: [T.u64], returns: T.void },
  })
  const ca = dlopen("/System/Library/Frameworks/CoreAudio.framework/CoreAudio", {
    AudioObjectGetPropertyDataSize: { args: [T.u32, T.ptr, T.u32, T.ptr, T.ptr], returns: T.i32 },
    AudioObjectGetPropertyData: { args: [T.u32, T.ptr, T.u32, T.ptr, T.ptr, T.ptr], returns: T.i32 },
  })
  const midi = dlopen("/System/Library/Frameworks/CoreMIDI.framework/CoreMIDI", {
    MIDIGetNumberOfSources: { args: [], returns: T.u64 },
    MIDIGetSource: { args: [T.u64], returns: T.u32 },
    MIDIGetNumberOfDestinations: { args: [], returns: T.u64 },
    MIDIGetDestination: { args: [T.u64], returns: T.u32 },
    MIDIObjectGetStringProperty: { args: [T.u32, T.u64, T.ptr], returns: T.i32 },
  })
  ffi = { cf: cf.symbols, ca: ca.symbols, midi: midi.symbols, ptr }
  return ffi
}

function cfString(ref: bigint): string {
  const { cf, ptr } = lib()
  const buf = new Uint8Array(1024)
  const ok = cf.CFStringGetCString(ref, ptr(buf), buf.length, UTF8)
  cf.CFRelease(ref)
  return ok ? new TextDecoder().decode(buf.subarray(0, buf.indexOf(0))) : ""
}

/** CoreAudio's device list, in kAudioHardwarePropertyDevices order — the order PortAudio numbers them in. */
export function coreAudioDevices(): AudioDevice[] | null {
  if (process.platform !== "darwin") return null
  try {
    const { ca, ptr } = lib()
    const addr = (sel: string, scope = "glob") => new Uint32Array([fourcc(sel), fourcc(scope), 0])
    const sizeOf = (id: number, a: Uint32Array) => {
      const s = new Uint32Array(1)
      return ca.AudioObjectGetPropertyDataSize(id, ptr(a), 0, null, ptr(s)) === 0 ? s[0] : -1
    }
    const channels = (id: number, scope: string) => {
      const a = addr("slay", scope)
      const n = sizeOf(id, a)
      if (n <= 0) return 0
      const b = new Uint32Array(Math.ceil(n / 4))
      if (ca.AudioObjectGetPropertyData(id, ptr(a), 0, null, ptr(new Uint32Array([n])), ptr(b)) !== 0) return 0
      // AudioBufferList: mNumberBuffers, then {mNumberChannels, mDataByteSize, mData(8)} per buffer.
      let total = 0
      for (let i = 0; i < b[0]; i++) total += b[2 + i * 4]
      return total
    }
    const all = addr("dev#")
    const bytes = sizeOf(1, all) // 1 = kAudioObjectSystemObject
    if (bytes < 0) return null
    const ids = new Uint32Array(bytes / 4)
    if (ca.AudioObjectGetPropertyData(1, ptr(all), 0, null, ptr(new Uint32Array([bytes])), ptr(ids)) !== 0) return null
    return [...ids].map((id) => {
      const ref = new BigUint64Array(1)
      const st = ca.AudioObjectGetPropertyData(id, ptr(addr("lnam")), 0, null, ptr(new Uint32Array([8])), ptr(ref))
      return {
        name: st === 0 && ref[0] ? cfString(ref[0]) : "",
        outputChannels: channels(id, "outp"),
        inputChannels: channels(id, "inpt"),
      }
    })
  } catch {
    return null
  }
}

/** MIDI port names (sources and destinations), as CoreMIDI displays them — what PortMidi names a controller. */
export function coreMidiDevices(): string[] | null {
  if (process.platform !== "darwin") return null
  try {
    const { cf, midi, ptr } = lib()
    const key = cf.CFStringCreateWithCString(null, ptr(Buffer.from("displayName\0")), UTF8) // kMIDIPropertyDisplayName
    const names = new Set<string>()
    const read = (endpoint: number) => {
      const ref = new BigUint64Array(1)
      if (midi.MIDIObjectGetStringProperty(endpoint, key, ptr(ref)) === 0 && ref[0]) names.add(cfString(ref[0]))
    }
    for (let i = 0n; i < BigInt(midi.MIDIGetNumberOfSources()); i++) read(midi.MIDIGetSource(i))
    for (let i = 0n; i < BigInt(midi.MIDIGetNumberOfDestinations()); i++) read(midi.MIDIGetDestination(i))
    cf.CFRelease(key)
    return [...names].filter(Boolean)
  } catch {
    return null
  }
}

// ── The log check ───────────────────────────────────────────────────────────────────────────

export interface LogExpect {
  /** MIDI names of the controllers that should open. */
  controllers: string[]
  /** Audio device names, one of which should become the clock reference. */
  audio: string[]
}

export interface LogVerdict {
  seen: string[]
  missing: string[]
  scriptErrors: string[]
}

const IGNORED_SCRIPT = /lodash\.mixxx\.js|midi-components/
const SCRIPT_ERROR = /\b(Warning|Critical|Fatal)\s+\[Controller\].*(\.js:\d+|Uncaught|exception|SyntaxError|ReferenceError|TypeError)/i
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** What mixxx.log says about the setup. Pure, so the markers are tested against tonight's real lines. */
export function checkMixxxLog(text: string, expect: LogExpect): LogVerdict {
  const seen: string[] = []
  const missing: string[] = []
  const need = (label: string, re: RegExp) => (re.test(text) ? seen : missing).push(label)
  for (const name of expect.controllers) {
    need(`Opening ${name} index N for output/input`, new RegExp(`Opening ${reEscape(name)} index \\d+ for (output|input)`))
  }
  if (expect.controllers.length) need("Starting engine", /\bStarting engine\b/)
  if (expect.audio.length) {
    need("Started stream successfully", /Started stream successfully/)
    need(
      `Using "<device>" as output sound device clock reference`,
      new RegExp(`Using "(${expect.audio.map(reEscape).join("|")})" as output sound device clock reference`),
    )
  }
  const scriptErrors = text.split("\n").filter((l) => SCRIPT_ERROR.test(l) && !IGNORED_SCRIPT.test(l)).map((l) => l.trim())
  return { seen, missing, scriptErrors }
}

// ── Quit, launch, wait ──────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function running(host: Host): boolean | null {
  const names = host.processNames()
  if (names === null) return null
  return names.some((n) => /^mixxx(\.exe)?$/i.test(n.trim().split(/[\\/]/).pop() ?? ""))
}

async function quit(host: Host): Promise<boolean> {
  if (host.platform !== "darwin") return false
  try {
    // A normal quit, so Mixxx saves and closes cleanly. It may ask "are you sure" while a deck plays.
    execFileSync("osascript", ["-e", 'tell application id "org.mixxx.mixxx" to quit'], { stdio: "ignore", timeout: 15_000 })
  } catch {
    /* checked below */
  }
  for (let i = 0; i < 60; i++) {
    if (running(host) === false) return true
    await sleep(1000)
  }
  return false
}

function inode(path: string): number | null {
  try {
    return statSync(path).ino
  } catch {
    return null
  }
}

async function launchAndCheck(bundle: Bundle, ctx: PlanContext, opts: { timeoutMs: number; onProgress?: (line: string) => void }) {
  const notes: string[] = []
  const problems: Problem[] = []
  const fileRead = (rel: string) => (existsSync(join(ctx.configDir, rel)) ? readFileSync(join(ctx.configDir, rel), "utf8") : null)
  const p = planMixxx(bundle, ctx, fileRead)
  const expect: LogExpect = { controllers: [...p.enabled.values()], audio: p.audio.map((d) => d.name) }

  // Mixxx rotates mixxx.log on start, so a different inode is this run's log.
  const log = join(ctx.configDir, "mixxx.log")
  const before = inode(log)
  const beforeSize = before === null ? 0 : statSync(log).size
  try {
    execFileSync("open", ["-b", "org.mixxx.mixxx"], { stdio: "ignore", timeout: 30_000 })
  } catch (e: any) {
    problems.push({ kind: "app-check", message: `could not start Mixxx: ${e?.message ?? e}` })
    return { notes, problems }
  }
  opts.onProgress?.("Started Mixxx; waiting for its log (a first launch with a new library can take minutes)…")

  const deadline = Date.now() + opts.timeoutMs
  let verdict: LogVerdict = { seen: [], missing: ["(no log yet)"], scriptErrors: [] }
  let lastSeen = -1
  let doneAt: number | null = null
  while (Date.now() < deadline) {
    await sleep(2000)
    const now = inode(log)
    if (now === null) continue
    let text = readFileSync(log, "utf8")
    if (now === before) text = text.slice(beforeSize) // not rotated: only what this run appended
    verdict = checkMixxxLog(text, expect)
    if (verdict.seen.length !== lastSeen) {
      lastSeen = verdict.seen.length
      opts.onProgress?.(`log: ${verdict.seen.length} of ${verdict.seen.length + verdict.missing.length} markers seen`)
    }
    if (verdict.missing.length === 0) {
      // Script errors land just after "Starting engine"; give them a moment to be written.
      doneAt ??= Date.now()
      if (Date.now() - doneAt >= 8000) break
    }
  }
  for (const s of verdict.seen) notes.push(`mixxx.log: ${s} ✓`)
  for (const m of verdict.missing) {
    problems.push({
      kind: "app-check",
      message: `mixxx.log has not shown "${m}" after ${Math.round(opts.timeoutMs / 1000)} s. Mixxx buffers its log, so this is unconfirmed, not failed — check Preferences › Controllers and Sound Hardware.`,
    })
  }
  for (const e of verdict.scriptErrors) problems.push({ kind: "app-check", message: `controller script error: ${e}` })
  return { notes, problems }
}

export const mixxxRuntime: AppRuntime = { quit, launchAndCheck }
