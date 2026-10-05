import { cmd } from "./cmd"
import { guardAct } from "./kinetic-guard"
import { bodyForDevice } from "./kinetic-couple"
import { dim, bold, success } from "./iris-api"
import { execFileSync, spawnSync } from "child_process"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

// ============================================================================
// iris android — drive an Android device over ADB, with the clutch attached.
//
// WHY THIS EXISTS AS A BODY AND NOT A SCRIPT. google/artemis open-sourced a very
// good natural-language phone driver and an MCP server for it, and its installer
// wires that server into up to eight IDEs at once. What it does not ship is any
// notion of WHO may drive the phone: no couple, no verb allowlist, no budget, no
// act log, no revocation. On a device holding a bank app and the 2FA codes for
// everything else, that is the whole risk.
//
// So the split is: ARTEMIS is the actuator, kinetic is the authorisation. The
// natural-language path (`run`) shells to ARTEMIS; the primitive actions are
// plain ADB and need nothing installed. Both go through guardAct first.
//
// NAMED `android`, NOT `phone`, FOR TWO REASONS. `iris phone` already exists and
// manages agent phone NUMBERS — an unrelated command this would have silently
// replaced. And ARTEMIS is Android-only with no iOS path, so a body called
// `phone` would promise a device class we cannot drive.
// ============================================================================

const KEYCODES: Record<string, string> = {
  back: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  recents: "KEYCODE_APP_SWITCH",
  enter: "KEYCODE_ENTER",
  tab: "KEYCODE_TAB",
  del: "KEYCODE_DEL",
  delete: "KEYCODE_DEL",
  escape: "KEYCODE_ESCAPE",
  esc: "KEYCODE_ESCAPE",
  power: "KEYCODE_POWER",
  volup: "KEYCODE_VOLUME_UP",
  voldown: "KEYCODE_VOLUME_DOWN",
  mute: "KEYCODE_VOLUME_MUTE",
  search: "KEYCODE_SEARCH",
  menu: "KEYCODE_MENU",
}

function adbBin(): string {
  const override = process.env.IRIS_ADB
  if (override && existsSync(override)) return override
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  if (sdk) {
    const p = join(sdk, "platform-tools", "adb")
    if (existsSync(p)) return p
  }
  return "adb"
}

function adb(args: string[], opts: { serial?: string } = {}): string {
  const argv = opts.serial ? ["-s", opts.serial, ...args] : args
  return execFileSync(adbBin(), argv, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 })
}

function adbAvailable(): boolean {
  const r = spawnSync(adbBin(), ["version"], { encoding: "utf-8" })
  return r.status === 0
}

interface Device {
  serial: string
  state: string
  model: string
}

function listDevices(): Device[] {
  let out = ""
  try {
    out = adb(["devices", "-l"])
  } catch {
    return []
  }
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/)
      const model = rest.find((r) => r.startsWith("model:"))?.slice(6) ?? ""
      return { serial, state, model: model.replace(/_/g, " ") }
    })
    .filter((d) => d.serial && d.state)
}

/**
 * Which phone are we talking to? An ambiguous answer is refused rather than guessed — picking
 * "the first one" when two are plugged in would let a couple issued for a test handset act on a
 * personal one, which is the exact confusion the instance half of `class:instance` exists to stop.
 */
function resolveDevice(args: { device?: string }): Device {
  const devices = listDevices()
  const usable = devices.filter((d) => d.state === "device")

  if (args.device) {
    const hit = usable.find((d) => d.serial === args.device)
    if (!hit) {
      const unauthorised = devices.find((d) => d.serial === args.device && d.state !== "device")
      console.error(
        unauthorised
          ? `Device ${args.device} is "${unauthorised.state}" — accept the USB debugging prompt on the phone.`
          : `No connected device with serial ${args.device}. Try: iris android devices`,
      )
      process.exit(1)
    }
    return hit
  }

  if (usable.length === 0) {
    const pending = devices.find((d) => d.state === "unauthorized")
    console.error(pending ? "Phone is connected but unauthorised — accept the USB debugging prompt on it." : "No Android device connected. Enable USB debugging and plug it in, then: iris android devices")
    process.exit(1)
  }
  if (usable.length > 1) {
    console.error(`${usable.length} devices connected — name one with --device <serial>:`)
    for (const d of usable) console.error(`  ${d.serial}  ${dim(d.model)}`)
    process.exit(1)
  }
  return usable[0]
}

/**
 * The instance-level gate. `guardCommand` already asked the class question from the route table
 * before any handler ran; this re-asks precisely, now that we know WHICH phone. Coarse first,
 * fine second — never coarse instead.
 */
async function actOn(args: { device?: string }, verb: string): Promise<Device> {
  const dev = resolveDevice(args)
  await guardAct({ body: bodyForDevice("phone", dev.serial) ?? "phone:unknown", verb })
  return dev
}

/** Single-quote for the DEVICE's shell: `adb shell` re-parses what it is handed. */
const sq = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`

const deviceOpt = (yargs: any) =>
  yargs.option("device", { alias: "D", describe: "device serial (see `iris android devices`)", type: "string" })

// ─────────────────────────────── reads ───────────────────────────────

const DevicesCommand = cmd({
  command: "devices",
  aliases: ["list", "ls"],
  describe: "connected Android devices and whether they are usable",
  async handler() {
    if (!adbAvailable()) {
      console.error("adb not found. Install Android platform-tools, or set IRIS_ADB=/path/to/adb")
      process.exit(1)
    }
    const devices = listDevices()
    console.log("")
    console.log(bold("Android devices"))
    if (devices.length === 0) {
      console.log(dim("  none connected"))
      console.log("")
      console.log(dim("Enable Developer Options → USB debugging on the phone, then replug."))
      console.log("")
      return
    }
    for (const d of devices) {
      const ok = d.state === "device"
      console.log(`  ${bold(d.serial)}  ${d.model ? dim(d.model) + "  " : ""}${ok ? success(d.state) : dim(d.state)}`)
    }
    console.log("")
  },
})

const DoctorCommand = cmd({
  command: "doctor",
  describe: "can this machine drive a phone? (adb, a device, ARTEMIS for natural-language tasks)",
  async handler() {
    const hasAdb = adbAvailable()
    const devices = hasAdb ? listDevices().filter((d) => d.state === "device") : []
    const artemis = artemisDir()
    console.log("")
    console.log(bold("iris android doctor"))
    console.log(`  adb            ${hasAdb ? success("found") : dim("missing — install Android platform-tools")}`)
    console.log(`  device         ${devices.length > 0 ? success(`${devices.length} ready`) : dim("none — enable USB debugging and replug")}`)
    console.log(`  ARTEMIS        ${artemis ? success(artemis) : dim("not found — `iris android run` needs it; the other verbs do not")}`)
    console.log("")
    console.log(dim("ARTEMIS: git clone https://github.com/google/artemis && cd artemis && ./start.sh"))
    console.log(dim("Then point IRIS at it: export IRIS_ARTEMIS_DIR=/path/to/artemis"))
    console.log("")
  },
})

const ScreenshotCommand = cmd({
  command: "screenshot",
  aliases: ["screen"],
  describe: "capture the phone's screen to a PNG",
  builder: (y: any) => deviceOpt(y).option("out", { describe: "output path", type: "string" }),
  async handler(args) {
    const dev = resolveDevice(args as any) // a read: looking is not moving
    const dir = join(homedir(), ".iris", "phone")
    mkdirSync(dir, { recursive: true })
    const out = (args as any).out || join(dir, `${dev.serial}-${Date.now()}.png`)
    const png = execFileSync(adbBin(), ["-s", dev.serial, "exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 })
    writeFileSync(out, png)
    console.log(`${success("captured")}  ${out}  ${dim(`${Math.round(png.length / 1024)}KB`)}`)
  },
})

const StateCommand = cmd({
  command: "state",
  aliases: ["status"],
  describe: "what is on screen right now — focused app and activity",
  builder: deviceOpt,
  async handler(args) {
    const dev = resolveDevice(args as any)
    let focus = ""
    try {
      focus = adb(["shell", "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'"], { serial: dev.serial }).trim()
    } catch {}
    const size = (() => {
      try {
        return adb(["shell", "wm size"], { serial: dev.serial }).trim()
      } catch {
        return ""
      }
    })()
    console.log("")
    console.log(`${bold(dev.serial)}  ${dim(dev.model)}`)
    console.log(`  ${size || dim("size unknown")}`)
    console.log(focus ? focus.split("\n").map((l) => "  " + l.trim()).join("\n") : dim("  no focused window reported"))
    console.log("")
  },
})

// ─────────────────────────────── acts ───────────────────────────────

function artemisDir(): string | null {
  const override = process.env.IRIS_ARTEMIS_DIR
  if (override && existsSync(join(override, "pyproject.toml"))) return override
  for (const c of [join(homedir(), "artemis"), join(process.cwd(), "artemis")]) {
    if (existsSync(join(c, "pyproject.toml"))) return c
  }
  return null
}

const RunCommand = cmd({
  command: "run <task>",
  aliases: ["task"],
  describe: "do something on the phone, described in plain English (uses ARTEMIS)",
  builder: (y: any) =>
    deviceOpt(y)
      .positional("task", { describe: 'e.g. "open Settings and tell me the battery level"', type: "string", demandOption: true })
      .option("profile", { describe: "ARTEMIS profile", type: "string", choices: ["flash", "pro"], default: "flash" }),
  async handler(args) {
    const dir = artemisDir()
    if (!dir) {
      console.error("ARTEMIS not found — `iris android run` is the one verb that needs it.")
      console.error(dim("  git clone https://github.com/google/artemis && cd artemis && ./start.sh"))
      console.error(dim("  export IRIS_ARTEMIS_DIR=/path/to/artemis"))
      console.error(dim("Primitive verbs (tap, type, swipe, key, app, open) work on plain adb today."))
      process.exit(1)
    }
    const dev = await actOn(args as any, "run")
    console.log(dim(`ARTEMIS ${(args as any).profile} → ${dev.serial}`))
    const r = spawnSync("uv", ["run", "artemis", "run", String((args as any).task), "--profile", String((args as any).profile)], {
      cwd: dir,
      stdio: "inherit",
      env: { ...process.env, ANDROID_SERIAL: dev.serial },
    })
    process.exit(r.status ?? 1)
  },
})

const TapCommand = cmd({
  command: "tap <x> <y>",
  aliases: ["click", "press"],
  describe: "tap a point on screen",
  builder: (y: any) =>
    deviceOpt(y)
      .positional("x", { type: "number", demandOption: true })
      .positional("y", { type: "number", demandOption: true })
      .option("long", { describe: "long-press instead (ms)", type: "number" }),
  async handler(args) {
    const a = args as any
    const dev = await actOn(a, "tap")
    const x = Number(a.x)
    const y = Number(a.y)
    if (a.long) adb(["shell", `input swipe ${x} ${y} ${x} ${y} ${Number(a.long)}`], { serial: dev.serial })
    else adb(["shell", `input tap ${x} ${y}`], { serial: dev.serial })
    console.log(`${success(a.long ? "long-pressed" : "tapped")}  ${x},${y}  ${dim(dev.serial)}`)
  },
})

const TypeCommand = cmd({
  command: "type <text>",
  aliases: ["input", "text"],
  describe: "type into the focused field",
  builder: (y: any) =>
    deviceOpt(y)
      .positional("text", { type: "string", demandOption: true })
      .option("clear", { describe: "clear the field first", type: "boolean", default: false }),
  async handler(args) {
    const a = args as any
    const dev = await actOn(a, "type")
    if (a.clear) {
      // `input keyevent` takes a list, so the deletes go in one call. Built here rather than with
      // a shell loop: Android's shell is mksh, not bash, and `{1..80}` does not expand there — it
      // would be sent as a literal and silently delete nothing.
      const dels = Array(80).fill("KEYCODE_DEL").join(" ")
      adb(["shell", `input keyevent KEYCODE_MOVE_END ${dels}`], { serial: dev.serial })
    }
    adb(["shell", `input text ${sq(String(a.text))}`], { serial: dev.serial })
    console.log(`${success("typed")}  ${dim(dev.serial)}`)
  },
})

const SwipeCommand = cmd({
  command: "swipe <direction>",
  aliases: ["scroll"],
  describe: "swipe up, down, left or right",
  builder: (y: any) =>
    deviceOpt(y)
      .positional("direction", { type: "string", choices: ["up", "down", "left", "right"], demandOption: true })
      .option("ms", { describe: "duration", type: "number", default: 300 }),
  async handler(args) {
    const a = args as any
    const dev = await actOn(a, "swipe")
    // Read the real screen rather than assuming 1080x1920 — a swipe sized for the wrong display
    // lands somewhere arbitrary, which on a phone means tapping whatever happens to be there.
    const size = adb(["shell", "wm size"], { serial: dev.serial })
    const m = size.match(/(\d+)x(\d+)/)
    const w = m ? Number(m[1]) : 1080
    const h = m ? Number(m[2]) : 1920
    const cx = Math.round(w / 2)
    const cy = Math.round(h / 2)
    const dx = Math.round(w * 0.35)
    const dy = Math.round(h * 0.3)
    const to: Record<string, [number, number, number, number]> = {
      up: [cx, cy + dy, cx, cy - dy],
      down: [cx, cy - dy, cx, cy + dy],
      left: [cx + dx, cy, cx - dx, cy],
      right: [cx - dx, cy, cx + dx, cy],
    }
    const [x1, y1, x2, y2] = to[String(a.direction)]
    adb(["shell", `input swipe ${x1} ${y1} ${x2} ${y2} ${Number(a.ms)}`], { serial: dev.serial })
    console.log(`${success("swiped")}  ${a.direction}  ${dim(dev.serial)}`)
  },
})

const KeyCommand = cmd({
  command: "key <name>",
  describe: `press a hardware/soft key (${Object.keys(KEYCODES).slice(0, 8).join(", ")}…)`,
  builder: (y: any) => deviceOpt(y).positional("name", { type: "string", demandOption: true }),
  async handler(args) {
    const a = args as any
    const raw = String(a.name).trim().toLowerCase()
    // Allowlist, not passthrough: an arbitrary string here is a keyevent we did not mean to send.
    const code = KEYCODES[raw] ?? (/^KEYCODE_[A-Z0-9_]+$/.test(String(a.name)) ? String(a.name) : null)
    if (!code) {
      console.error(`Unknown key "${a.name}". Known: ${Object.keys(KEYCODES).join(", ")}`)
      process.exit(1)
    }
    const dev = await actOn(a, "key")
    adb(["shell", `input keyevent ${code}`], { serial: dev.serial })
    console.log(`${success("pressed")}  ${code}  ${dim(dev.serial)}`)
  },
})

const AppCommand = cmd({
  command: "app <action> <package>",
  describe: "launch or force-stop an app",
  builder: (y: any) =>
    deviceOpt(y)
      .positional("action", { type: "string", choices: ["launch", "stop"], demandOption: true })
      .positional("package", { type: "string", demandOption: true }),
  async handler(args) {
    const a = args as any
    const pkg = String(a.package)
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg)) {
      console.error(`"${pkg}" is not an Android package name (e.g. com.android.settings).`)
      process.exit(1)
    }
    const dev = await actOn(a, "app")
    if (a.action === "stop") adb(["shell", `am force-stop ${sq(pkg)}`], { serial: dev.serial })
    else adb(["shell", `monkey -p ${sq(pkg)} -c android.intent.category.LAUNCHER 1`], { serial: dev.serial })
    console.log(`${success(a.action === "stop" ? "stopped" : "launched")}  ${pkg}  ${dim(dev.serial)}`)
  },
})

const OpenCommand = cmd({
  command: "open <url>",
  describe: "open an http(s) URL on the phone",
  builder: (y: any) => deviceOpt(y).positional("url", { type: "string", demandOption: true }),
  async handler(args) {
    const a = args as any
    const url = String(a.url)
    // http(s) only. An arbitrary scheme here is a deep link into any app that registered one —
    // a far larger surface than "open a web page", and not what this verb says it does.
    if (!/^https?:\/\//i.test(url)) {
      console.error("Only http(s) URLs. A custom scheme is a deep link into another app, which this verb does not cover.")
      process.exit(1)
    }
    const dev = await actOn(a, "open")
    adb(["shell", `am start -a android.intent.action.VIEW -d ${sq(url)}`], { serial: dev.serial })
    console.log(`${success("opened")}  ${url}  ${dim(dev.serial)}`)
  },
})

export const PlatformAndroidCommand = cmd({
  command: "android",
  aliases: ["adb"],
  describe: "drive an Android phone — plain English or direct taps, gated by the kinetic clutch",
  builder: (yargs) =>
    yargs
      .command(DevicesCommand)
      .command(DoctorCommand)
      .command(StateCommand)
      .command(ScreenshotCommand)
      .command(RunCommand)
      .command(TapCommand)
      .command(TypeCommand)
      .command(SwipeCommand)
      .command(KeyCommand)
      .command(AppCommand)
      .command(OpenCommand)
      .demandCommand(),
  async handler() {},
})
