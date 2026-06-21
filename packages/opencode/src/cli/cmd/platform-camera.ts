import { cmd } from "./cmd"
import { dim, bold, success } from "./iris-api"
import { execSync, execFileSync } from "child_process"
import { existsSync, mkdirSync, copyFileSync, chmodSync } from "fs"
import { homedir, platform } from "os"
import { join, dirname } from "path"

// ============================================================================
// iris camera — direct UVC control of PTZ webcams (OBSBOT Tiny & friends)
//
// macOS-only, like `iris mail` / `iris imessage`. Drives the camera's standard
// UVC pan/tilt/zoom controls directly over USB via `uvc-util` — no vendor app
// (e.g. OBSBOT Center) required. Works with any UVC camera that exposes
// pan-tilt-abs / zoom-abs (confirmed on the OBSBOT Tiny, VID 0x6e30 / PID 0xfef0).
//
// NOTE: manual PTZ only works while the camera's on-board AI tracking is OFF.
// On OBSBOT, toggle tracking with an open-palm ✋ gesture. These commands detect
// when the camera is moving on its own and warn you.
// ============================================================================

const TOOL_DIR = join(homedir(), ".iris", "tools")
const TOOL_BIN = join(TOOL_DIR, "uvc-util")
const TOOL_SRC = join(TOOL_DIR, "uvc-util-src")
const UVC_UTIL_REPO = "https://github.com/jtfrey/uvc-util.git"

function ensureMacOS(): void {
  if (platform() !== "darwin") {
    console.error("iris camera is macOS-only (direct UVC control over USB).")
    process.exit(1)
  }
}

// Locate (or build, once) the uvc-util binary. Override with IRIS_UVC_UTIL.
function ensureUvcUtil(): string {
  const override = process.env.IRIS_UVC_UTIL
  if (override && existsSync(override)) return override
  if (existsSync(TOOL_BIN)) return TOOL_BIN

  console.log(dim("First run: building uvc-util (one-time, ~10s, requires Xcode CLT)…"))
  try {
    mkdirSync(TOOL_DIR, { recursive: true })
    if (!existsSync(TOOL_SRC)) {
      execSync(`git clone --depth 1 ${UVC_UTIL_REPO} "${TOOL_SRC}"`, { stdio: "ignore" })
    }
    execSync(`xcodebuild -project uvc-util.xcodeproj -configuration Release`, {
      cwd: TOOL_SRC,
      stdio: "ignore",
    })
    const built = join(TOOL_SRC, "build", "Release", "uvc-util")
    if (!existsSync(built)) throw new Error("build produced no binary")
    copyFileSync(built, TOOL_BIN)
    chmodSync(TOOL_BIN, 0o755)
    return TOOL_BIN
  } catch (e: any) {
    console.error(bold("Could not build uvc-util automatically."))
    console.error(dim("Requires macOS + Xcode Command Line Tools (`xcode-select --install`)."))
    console.error(dim("Manual install:"))
    console.error(`  git clone ${UVC_UTIL_REPO}`)
    console.error(`  cd uvc-util && xcodebuild -project uvc-util.xcodeproj -configuration Release`)
    console.error(`  cp build/Release/uvc-util "${TOOL_BIN}"`)
    console.error(dim(`  (or set IRIS_UVC_UTIL=/path/to/uvc-util)`))
    console.error(dim(`  reason: ${e.message}`))
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

type Device = { index: number; vidpid: string; name: string }

function listDevices(bin: string): Device[] {
  const out = execFileSync(bin, ["-d"], { encoding: "utf-8" })
  return out
    .split("\n")
    .map((l) => l.trim())
    .map((l) => {
      const m = l.match(/^(\d+)\s+(0x[0-9a-f]+:0x[0-9a-f]+)\s+\S+\s+\S+\s+(.+)$/i)
      return m ? { index: Number(m[1]), vidpid: m[2].toLowerCase(), name: m[3].trim() } : null
    })
    .filter((d): d is Device => d !== null)
}

// Pick the target camera: explicit index, name match, OBSBOT/0x6e30, else first PTZ-capable.
function selectDevice(bin: string, opts: { index?: number; name?: string }): Device {
  const devices = listDevices(bin)
  if (devices.length === 0) {
    console.error("No UVC cameras detected.")
    process.exit(1)
  }
  if (opts.index !== undefined) {
    const d = devices.find((x) => x.index === opts.index)
    if (!d) {
      console.error(`No camera at index ${opts.index}. Run \`iris camera list\`.`)
      process.exit(1)
    }
    return d
  }
  if (opts.name) {
    const d = devices.find((x) => x.name.toLowerCase().includes(opts.name!.toLowerCase()))
    if (!d) {
      console.error(`No camera matching "${opts.name}". Run \`iris camera list\`.`)
      process.exit(1)
    }
    return d
  }
  // Prefer OBSBOT, then any device that actually supports pan/tilt.
  const obsbot = devices.find((d) => d.name.toLowerCase().includes("obsbot") || d.vidpid.startsWith("0x6e30"))
  if (obsbot) return obsbot
  const ptz = devices.find((d) => supportsControl(bin, d.index, "pan-tilt-abs"))
  return ptz ?? devices[0]
}

function supportsControl(bin: string, index: number, control: string): boolean {
  try {
    const out = execFileSync(bin, ["-I", String(index), "-c"], { encoding: "utf-8" })
    return out.includes(control)
  } catch {
    return false
  }
}

function setControl(bin: string, index: number, control: string, value: string): void {
  execFileSync(bin, ["-I", String(index), "-s", `${control}=${value}`], { stdio: "ignore" })
}

// Accept a raw integer, a 0..1 fraction, or a uvc-util keyword. Reject junk
// (e.g. "abc") before it reaches the binary and crashes with a raw error.
const AXIS_KEYWORDS = new Set(["min", "max", "minimum", "maximum", "default"])
function isValidAxisValue(v: string): boolean {
  if (AXIS_KEYWORDS.has(v.trim().toLowerCase())) return true
  return v.trim() !== "" && Number.isFinite(Number(v))
}
// uvc-util only accepts the long forms — normalize the friendly short ones.
function normalizeAxisValue(v: string): string {
  const k = v.trim().toLowerCase()
  if (k === "min") return "minimum"
  if (k === "max") return "maximum"
  return v.trim()
}

function getPanTilt(bin: string, index: number): { pan: number; tilt: number } | null {
  try {
    const out = execFileSync(bin, ["-I", String(index), "-o", "pan-tilt-abs"], { encoding: "utf-8" })
    const m = out.match(/pan=(-?\d+),\s*tilt=(-?\d+)/)
    return m ? { pan: Number(m[1]), tilt: Number(m[2]) } : null
  } catch {
    return null
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Detect on-board AI tracking: if the camera's pan/tilt drifts with no input
// from us, tracking is active and will override manual control.
async function isSelfMoving(bin: string, index: number): Promise<boolean> {
  const a = getPanTilt(bin, index)
  await sleep(350)
  const b = getPanTilt(bin, index)
  if (!a || !b) return false
  return Math.abs(a.pan - b.pan) > 50 || Math.abs(a.tilt - b.tilt) > 50
}

async function warnIfTracking(bin: string, index: number): Promise<void> {
  if (await isSelfMoving(bin, index)) {
    console.log(
      dim("⚠ camera is moving on its own — AI tracking looks ON. Manual control is ignored while tracking."),
    )
    console.log(dim("  On OBSBOT: hold an open palm ✋ at the camera (~2s) to toggle tracking off."))
  }
}

// Resolve binary + device once for a subcommand.
function target(args: { device?: number; name?: string }): { bin: string; dev: Device } {
  ensureMacOS()
  const bin = ensureUvcUtil()
  const dev = selectDevice(bin, { index: args.device, name: args.name })
  return { bin, dev }
}

const deviceOpts = (yargs: any) =>
  yargs
    .option("device", { alias: "D", describe: "camera index (see `iris camera list`)", type: "number" })
    .option("name", { alias: "n", describe: "select camera by name substring", type: "string" })

// ============================================================================
// Subcommands
// ============================================================================

const ListCommand = cmd({
  command: "list",
  aliases: ["ls", "devices"],
  describe: "list connected cameras and their PTZ/zoom ranges",
  async handler() {
    ensureMacOS()
    const bin = ensureUvcUtil()
    const devices = listDevices(bin)
    console.log("")
    console.log(bold("📷 Cameras"))
    if (devices.length === 0) {
      console.log(dim("  none detected"))
      return
    }
    for (const d of devices) {
      const ptz = supportsControl(bin, d.index, "pan-tilt-abs")
      const zoom = supportsControl(bin, d.index, "zoom-abs")
      const caps = [ptz ? "pan/tilt" : null, zoom ? "zoom" : null].filter(Boolean).join(", ") || "no PTZ"
      console.log(`  ${bold(String(d.index))}  ${d.name}  ${dim(d.vidpid)}  ${ptz || zoom ? success(caps) : dim(caps)}`)
    }
    console.log("")
    console.log(dim("Control with: iris camera center | left | right | zoom 60 | sweep --seconds 20"))
    console.log("")
  },
})

const PosCommand = cmd({
  command: "pos",
  aliases: ["position", "status"],
  describe: "read the camera's current pan/tilt/zoom",
  builder: deviceOpts,
  async handler(args) {
    const { bin, dev } = target(args as any)
    const pt = getPanTilt(bin, dev.index)
    let zoom = "?"
    try {
      zoom = execFileSync(bin, ["-I", String(dev.index), "-o", "zoom-abs"], { encoding: "utf-8" }).trim()
    } catch {}
    console.log(`${bold(dev.name)}  ${dim(`#${dev.index}`)}`)
    console.log(`  pan/tilt: ${pt ? `${pt.pan}, ${pt.tilt}` : dim("n/a")}`)
    console.log(`  zoom:     ${zoom}`)
  },
})

const CenterCommand = cmd({
  command: "center",
  aliases: ["home", "reset-position"],
  describe: "recenter pan/tilt to default",
  builder: deviceOpts,
  async handler(args) {
    const { bin, dev } = target(args as any)
    setControl(bin, dev.index, "pan-tilt-abs", "default")
    console.log(success(`centered ${dev.name}`))
  },
})

// left / right / up / down — move one axis to its extreme, keep the other.
function directionCommand(name: string, aliases: string[], axis: "pan" | "tilt", to: "minimum" | "maximum") {
  return cmd({
    command: name,
    aliases,
    describe: `pan/tilt ${name}`,
    builder: deviceOpts,
    async handler(args) {
      const { bin, dev } = target(args as any)
      await warnIfTracking(bin, dev.index)
      const cur = getPanTilt(bin, dev.index)
      const other = axis === "pan" ? `tilt=${cur ? cur.tilt : "default"}` : `pan=${cur ? cur.pan : "default"}`
      setControl(bin, dev.index, "pan-tilt-abs", `{${axis}=${to},${other}}`)
      console.log(success(`${dev.name} → ${name}`))
    },
  })
}

const LeftCommand = directionCommand("left", ["l"], "pan", "minimum")
const RightCommand = directionCommand("right", ["r"], "pan", "maximum")
const UpCommand = directionCommand("up", ["u"], "tilt", "maximum")
const DownCommand = directionCommand("down", ["d"], "tilt", "minimum")

const MoveCommand = cmd({
  command: "move",
  aliases: ["goto"],
  describe: "move to absolute pan/tilt values (omit an axis to keep it)",
  builder: (yargs) =>
    deviceOpts(yargs)
      .option("pan", { alias: "p", describe: "absolute pan (or 0..1 fraction, or min/max)", type: "string" })
      .option("tilt", { alias: "t", describe: "absolute tilt (or 0..1 fraction, or min/max)", type: "string" }),
  async handler(args) {
    const { bin, dev } = target(args as any)
    if (args.pan === undefined && args.tilt === undefined) {
      console.error("Provide --pan and/or --tilt.")
      process.exit(1)
    }
    for (const [name, v] of [["pan", args.pan], ["tilt", args.tilt]] as const) {
      if (v !== undefined && !isValidAxisValue(String(v))) {
        console.error(`Invalid --${name} "${v}". Use a number, a 0–1 fraction, or min/max/default.`)
        process.exit(1)
      }
    }
    await warnIfTracking(bin, dev.index)
    const cur = getPanTilt(bin, dev.index)
    const pan = args.pan !== undefined ? normalizeAxisValue(String(args.pan)) : cur ? String(cur.pan) : "default"
    const tilt = args.tilt !== undefined ? normalizeAxisValue(String(args.tilt)) : cur ? String(cur.tilt) : "default"
    setControl(bin, dev.index, "pan-tilt-abs", `{pan=${pan},tilt=${tilt}}`)
    console.log(success(`moved ${dev.name} → pan=${pan} tilt=${tilt}`))
  },
})

const ZoomCommand = cmd({
  command: "zoom <level>",
  describe: "set zoom 0–100 (0 = wide, 100 = full zoom)",
  builder: (yargs) =>
    deviceOpts(yargs).positional("level", { describe: "zoom 0-100", type: "number", demandOption: true }),
  async handler(args) {
    const raw = Number(args.level)
    if (!Number.isFinite(raw)) {
      console.error(`Invalid zoom value. Use a number 0–100.`)
      process.exit(1)
    }
    const { bin, dev } = target(args as any)
    const level = Math.max(0, Math.min(100, raw))
    // map 0-100 to a 0..1 fraction so it works regardless of the camera's zoom range
    setControl(bin, dev.index, "zoom-abs", String(level / 100))
    console.log(success(`${dev.name} zoom → ${level}`))
  },
})

const SweepCommand = cmd({
  command: "sweep",
  aliases: ["dance"],
  describe: "smooth left↔right pan sweep for N seconds",
  builder: (yargs) =>
    deviceOpts(yargs)
      .option("seconds", { alias: "s", describe: "duration", type: "number", default: 15 })
      .option("step", { describe: "fraction per step (smaller = smoother)", type: "number", default: 0.05 })
      .option("delay", { describe: "ms between steps", type: "number", default: 40 }),
  async handler(args) {
    const { bin, dev } = target(args as any)
    await warnIfTracking(bin, dev.index)
    const seconds = Math.max(1, Number(args.seconds))
    const step = Math.min(0.5, Math.max(0.01, Number(args.step)))
    const delay = Math.max(0, Number(args.delay))
    const start = Date.now()
    let cycles = 0
    console.log(dim(`sweeping ${dev.name} for ~${seconds}s… (Ctrl-C to stop)`))
    while ((Date.now() - start) / 1000 < seconds) {
      for (let f = 0; f <= 1.0001; f += step) {
        setControl(bin, dev.index, "pan-tilt-abs", `{pan=${f.toFixed(3)},tilt=0.5}`)
        await sleep(delay)
      }
      for (let f = 1; f >= -0.0001; f -= step) {
        setControl(bin, dev.index, "pan-tilt-abs", `{pan=${Math.max(0, f).toFixed(3)},tilt=0.5}`)
        await sleep(delay)
      }
      cycles++
    }
    setControl(bin, dev.index, "pan-tilt-abs", "default")
    console.log(success(`done — ${cycles} sweep(s), recentered`))
  },
})

const PatrolCommand = cmd({
  command: "patrol",
  describe: "slow continuous security-cam pan loop until Ctrl-C",
  builder: (yargs) =>
    deviceOpts(yargs)
      .option("delay", { describe: "ms between steps (higher = slower)", type: "number", default: 120 })
      .option("step", { describe: "fraction per step", type: "number", default: 0.04 }),
  async handler(args) {
    const { bin, dev } = target(args as any)
    await warnIfTracking(bin, dev.index)
    const delay = Math.max(0, Number(args.delay))
    const step = Math.min(0.5, Math.max(0.01, Number(args.step)))
    console.log(dim(`patrolling ${dev.name}… (Ctrl-C to stop)`))
    const recenter = () => {
      try {
        setControl(bin, dev.index, "pan-tilt-abs", "default")
      } catch {}
      process.exit(0)
    }
    process.on("SIGINT", recenter)
    // eslint-disable-next-line no-constant-condition
    while (true) {
      for (let f = 0; f <= 1.0001; f += step) {
        setControl(bin, dev.index, "pan-tilt-abs", `{pan=${f.toFixed(3)},tilt=0.5}`)
        await sleep(delay)
      }
      for (let f = 1; f >= -0.0001; f -= step) {
        setControl(bin, dev.index, "pan-tilt-abs", `{pan=${Math.max(0, f).toFixed(3)},tilt=0.5}`)
        await sleep(delay)
      }
    }
  },
})

const ResetCommand = cmd({
  command: "reset",
  describe: "reset all camera controls to defaults",
  builder: deviceOpts,
  async handler(args) {
    const { bin, dev } = target(args as any)
    try {
      execFileSync(bin, ["-I", String(dev.index), "-r"], { stdio: "ignore" })
    } catch {
      setControl(bin, dev.index, "pan-tilt-abs", "default")
      setControl(bin, dev.index, "zoom-abs", "0")
    }
    console.log(success(`reset ${dev.name}`))
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformCameraCommand = cmd({
  command: "camera",
  aliases: ["cam", "ptz"],
  describe: "control a PTZ webcam (OBSBOT Tiny) — pan/tilt/zoom over UVC, no vendor app",
  builder: (yargs) =>
    yargs
      .command(ListCommand)
      .command(PosCommand)
      .command(CenterCommand)
      .command(LeftCommand)
      .command(RightCommand)
      .command(UpCommand)
      .command(DownCommand)
      .command(MoveCommand)
      .command(ZoomCommand)
      .command(SweepCommand)
      .command(PatrolCommand)
      .command(ResetCommand)
      .demandCommand(),
  async handler() {},
})
