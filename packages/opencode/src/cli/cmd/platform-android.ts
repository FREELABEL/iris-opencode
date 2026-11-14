import { cmd } from "./cmd"
import { guardAct } from "./kinetic-guard"
import { bodyForDevice } from "./kinetic-couple"
import { appendAct, beginNewAct, currentActor, currentRunId, nodeKey } from "./kinetic-store"
import { dim, bold, success, irisFetch, resolveUserId } from "./iris-api"
import { parseUiDump, checkExpect, findSendTargets, centerOf, type UiNode } from "./android-screen"
import { parseBattery, parseLocked, parseAwake, healthVerdict, type Health } from "./android-health"
import {
  parseTasks, batchIdFor, parseUntil, newState, resume, nextTask, setResult, retryTask, dropTask, counts, needsYou, renderReport,
  TaskFileError, type BatchState, type TaskSpec, type TaskResult,
} from "./android-batch"
import { execFileSync, spawnSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs"
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
  await guardAct({ body: bodyOf(dev), verb })
  return dev
}

/**
 * The body's name. This was `bodyForDevice("phone", …)` while the class gate, the body table and
 * every test said `android` — so no couple could pass both gates: `android:<serial>` failed the
 * instance check, `phone:<serial>` failed the class check. Every agent act on a phone was refused.
 * It failed closed, which is why nobody saw it, and it would have refused the whole night shift.
 */
export const androidBody = (serial: string) => bodyForDevice("android", serial) ?? "android:unknown"
const bodyOf = (dev: Device) => androidBody(dev.serial)

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

// ─────────────────────────────── the night shift (#191791) ───────────────────────────────

/** The accessibility tree, as the CHECKER reads it — not as the actor remembers it. */
function readUi(serial: string): UiNode[] {
  // `/dev/tty` streams the dump to stdout on most builds. Some refuse it ("ERROR: null root node"),
  // so fall back to a file on the device. Either way an empty tree is an empty answer, never a pass:
  // checkExpect on no nodes finds nothing, so every expected value is a mismatch.
  try {
    const out = adb(["exec-out", "uiautomator", "dump", "/dev/tty"], { serial })
    if (out.includes("<node")) return parseUiDump(out)
  } catch {}
  try {
    adb(["shell", "uiautomator dump /sdcard/iris-ui.xml"], { serial })
    return parseUiDump(adb(["exec-out", "cat", "/sdcard/iris-ui.xml"], { serial }))
  } catch {
    return []
  }
}

function readHealth(serial: string): Health {
  const sh = (c: string) => {
    try {
      return adb(["shell", c], { serial })
    } catch {
      return ""
    }
  }
  return {
    battery: parseBattery(sh("dumpsys battery")),
    locked: parseLocked(sh("dumpsys window | grep -E 'Lockscreen|Keyguard'")),
    awake: parseAwake(sh("dumpsys power | grep mWakefulness")),
  }
}

function screencap(serial: string, out: string): string | undefined {
  try {
    writeFileSync(out, execFileSync(adbBin(), ["-s", serial, "exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 }))
    return out
  } catch {
    return undefined
  }
}

const HealthCommand = cmd({
  command: "health",
  describe: "is the phone fit to work? battery, charging, temperature, lock — what the night shift checks before every task",
  builder: (y: any) => deviceOpt(y).option("json", { type: "boolean", default: false }),
  async handler(args) {
    const dev = resolveDevice(args as any)
    const h = readHealth(dev.serial)
    const v = healthVerdict(h)
    if ((args as any).json) {
      console.log(JSON.stringify({ device: dev.serial, ...h, ok: v.ok, reasons: v.reasons }))
      return
    }
    const b = h.battery
    const fmt = (x: unknown) => (x === null || x === undefined ? dim("unknown") : String(x))
    console.log("")
    console.log(`${bold(dev.serial)}  ${dim(dev.model)}`)
    console.log(`  battery   ${fmt(b.level)}${b.level !== null ? "%" : ""}  ${b.plugged ? success("on power") : b.plugged === false ? dim("on battery") : dim("power unknown")}  ${b.status ? dim(b.status) : ""}`)
    console.log(`  temp      ${fmt(b.tempC)}${b.tempC !== null ? " °C" : ""}`)
    console.log(`  locked    ${fmt(h.locked)}`)
    console.log(`  awake     ${fmt(h.awake)}`)
    console.log(`  verdict   ${v.ok ? success("fit to work") : v.reasons.join("; ")}`)
    console.log("")
    if (!v.ok) process.exit(1)
  },
})

/** `--expect date=2026-11-04 --expect time=14:00` → { date, time }. */
function expectPairs(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of ([] as unknown[]).concat(raw ?? [])) {
    const s = String(p)
    const i = s.indexOf("=")
    if (i <= 0) {
      console.error(`--expect "${s}" must be name=value`)
      process.exit(1)
    }
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim()
  }
  return out
}

const CheckCommand = cmd({
  command: "check",
  describe: "does the screen show what you expect? reads the accessibility tree — never taps",
  builder: (y: any) =>
    deviceOpt(y)
      .option("expect", { describe: "name=value; an ISO date or HH:MM is read in any format the app shows it (repeatable)", type: "string", array: true, demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const a = args as any
    const dev = resolveDevice(a)
    const nodes = readUi(dev.serial)
    const r = checkExpect(nodes, expectPairs(a.expect))
    const targets = findSendTargets(nodes).map((n) => ({ label: n.text || n.desc, at: centerOf(n) }))
    if (a.json) {
      console.log(JSON.stringify({ device: dev.serial, nodes: nodes.length, ...r, send_targets: targets }))
    } else {
      console.log("")
      if (nodes.length === 0) console.log(dim("  the accessibility tree came back empty — nothing on screen can be checked"))
      for (const m of r.mismatches)
        console.log(`  ✕ ${bold(m.key)}  expected ${m.expected}${m.seen.length ? `, screen shows ${m.seen.join(", ")}` : ", not on screen"}`)
      console.log(`  ${r.ok ? success(`✓ all ${r.checked} expected values are on screen`) : `${r.mismatches.length} of ${r.checked} not as expected`}`)
      console.log(dim(`  send-class buttons visible: ${targets.length ? targets.map((t) => t.label).join(", ") : "none"}`))
      console.log("")
    }
    if (!r.ok) process.exit(1)
  },
})

/**
 * Two-phase commit for anything that leaves the phone. The ACTOR prepares; the CHECKER reads the
 * screen against the task's `expect:`; only then does IRIS — not the actor — press the button,
 * through the guard. The actor is told to stop short of it. If an actor ignores that and presses
 * it anyway, the checker is too late, which is why this is stated in the prompt AND recorded as an
 * open question on #191798 (a hard stop needs ARTEMIS to refuse the tap itself).
 */
const STOP_BEFORE_SEND =
  "\n\nIMPORTANT: prepare everything, but do NOT press the final Send / Submit / Confirm / Pay / Post / Book button. Stop on the screen where that button is visible. A separate checker will verify the screen and press it."

const NIGHT_DIR = () => join(homedir(), ".iris", "phone", "batches")

function loadState(batchId: string): BatchState | null {
  const p = join(NIGHT_DIR(), batchId, "state.json")
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8")) as BatchState
}

function saveState(s: BatchState): void {
  const d = join(NIGHT_DIR(), s.batch_id)
  mkdirSync(d, { recursive: true, mode: 0o700 })
  // Write-then-rename: a batch killed mid-write must not leave half a state file, because the
  // next resume would read it as "nothing has run" and run everything again.
  const tmp = join(d, `state.json.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, join(d, "state.json"))
}

function readTaskFile(file: string): { content: string; specs: TaskSpec[] } {
  if (!existsSync(file)) {
    console.error(`No tasks file at ${file}`)
    process.exit(1)
  }
  const content = readFileSync(file, "utf-8")
  try {
    const doc = /\.json$/i.test(file) ? JSON.parse(content) : (globalThis as any).Bun.YAML.parse(content)
    return { content, specs: parseTasks(doc) }
  } catch (e: any) {
    console.error(e instanceof TaskFileError ? `Tasks file refused:\n${e.message}` : `Could not read ${file}: ${e.message}`)
    process.exit(1)
  }
}

function runArtemisCaptured(dir: string, serial: string, prompt: string, profile: string, tracePath: string, timeoutMs: number) {
  const r = spawnSync("uv", ["run", "artemis", "run", prompt, "--profile", profile], {
    cwd: dir,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ANDROID_SERIAL: serial },
  })
  writeFileSync(tracePath, `$ artemis run --profile ${profile}\n${prompt}\n\n--- stdout ---\n${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}\n`, { mode: 0o600 })
  return { status: r.status, timedOut: r.error?.name === "Error" && String(r.error?.message).includes("ETIMEDOUT") }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function postReport(bloq: number, list: number, title: string, content: string): Promise<string | null> {
  const userId = await resolveUserId()
  if (!userId) return null
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloq}/items`, {
    method: "POST",
    body: JSON.stringify({ title, content, list_id: list, type: "default" }),
  })
  if (!res.ok) return null
  const body = (await res.json().catch(() => null)) as any
  const id = body?.data?.id ?? body?.data?.data?.id ?? body?.id
  return id ? String(id) : null
}

const BatchRunCommand = cmd({
  command: "run <file>",
  describe: "work through a tasks file until the cutoff — checked, paused when the phone is unwell, resumable",
  builder: (y: any) =>
    deviceOpt(y)
      .positional("file", { describe: "tasks.yaml (or .json): id, prompt, profile, send, expect", type: "string", demandOption: true })
      .option("until", { describe: "cutoff: HH:MM (next occurrence) or an ISO time — anything not started by then expires", type: "string", default: "07:00" })
      .option("task-timeout", { describe: "seconds one task may take", type: "number", default: 600 })
      .option("health-poll", { describe: "seconds between health checks while paused", type: "number", default: 60 })
      .option("report-bloq", { describe: "post the morning report to this Atlas bloq…", type: "number" })
      .option("report-list", { describe: "…in this list", type: "number" })
      .option("dry-run", { describe: "parse and show the plan; touch nothing", type: "boolean", default: false }),
  async handler(args) {
    const a = args as any
    const file = String(a.file)
    const { content, specs } = readTaskFile(file)
    let until: Date
    try {
      until = parseUntil(String(a.until), new Date())
    } catch (e: any) {
      console.error(e.message)
      process.exit(1)
    }
    const batchId = batchIdFor(content)

    if (a["dry-run"]) {
      console.log("")
      console.log(`${bold("batch")} ${batchId}  ${dim(`${specs.length} tasks · cutoff ${until.toLocaleString()}`)}`)
      for (const s of specs)
        console.log(`  ${s.send ? bold("SEND") : dim("    ")}  ${s.id}  ${dim(s.profile)}  ${Object.keys(s.expect).length ? dim(`expect ${Object.entries(s.expect).map(([k, v]) => `${k}=${v}`).join(" ")}`) : ""}`)
      console.log("")
      return
    }

    const dir = artemisDir()
    if (!dir) {
      console.error("ARTEMIS not found — the batch drives tasks through it. See: iris android doctor")
      process.exit(1)
    }
    const dev = resolveDevice(a)
    const body = bodyOf(dev)
    const existing = loadState(batchId)
    if (existing && existing.device !== dev.serial) {
      console.error(`Batch ${batchId} ran on ${existing.device}, not ${dev.serial}. Name that device with --device, or change the file to start a new batch.`)
      process.exit(1)
    }
    const untilGiven = process.argv.some((x) => x === "--until" || x.startsWith("--until="))
    let state = existing ? resume(existing, untilGiven ? until : undefined) : newState({ batchId, file, device: dev.serial, until, tasks: specs, now: new Date() })
    // Tasks added to a file change its hash, so a resumed batch always has the same task set.
    saveState(state)
    const bdir = join(NIGHT_DIR(), batchId)
    console.log(`${bold("batch")} ${batchId}  ${dim(`${dev.serial} · cutoff ${new Date(state.until).toLocaleString()} · ${bdir}`)}`)
    if (existing && state.until !== existing.until) console.log(dim(`  cutoff changed: ${new Date(existing.until).toLocaleString()} → ${new Date(state.until).toLocaleString()}`))
    if (existing) console.log(dim(`  resuming — ${Object.entries(counts(state)).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ")}`))

    for (;;) {
      const next = nextTask(state, new Date())
      state = next.state
      saveState(state)
      if (!next.id) break
      const spec = specs.find((s) => s.id === next.id)!

      // Health first. Paused is not failed: the task waits, and expires only if the cutoff comes.
      let fit = false
      for (;;) {
        const h = readHealth(dev.serial)
        const v = healthVerdict(h)
        state = { ...state, health: [...state.health, { ts: new Date().toISOString(), level: h.battery.level, plugged: h.battery.plugged, tempC: h.battery.tempC, ok: v.ok, reason: v.reasons.join("; ") || undefined }].slice(-500) }
        saveState(state)
        if (v.ok) {
          fit = true
          break
        }
        if (Date.now() >= new Date(state.until).getTime()) break
        console.log(dim(`  paused — ${v.reasons.join("; ")}`))
        await sleep(Math.max(5, Number(a["health-poll"])) * 1000)
      }
      if (!fit) continue // the cutoff passed while paused; nextTask expires the rest

      // The clutch, per task, before anything moves. A refusal exits here, with the task still
      // pending — nothing ran, so nothing is ambiguous.
      beginNewAct()
      await guardAct({ body, verb: "run" })

      const started = new Date().toISOString()
      state = setResult(state, spec.id, { status: "running", started_at: started })
      saveState(state)
      const before = screencap(dev.serial, join(bdir, `${spec.id}-before.png`))
      const trace = join(bdir, `${spec.id}-artemis.log`)
      console.log(`  ${bold(spec.id)}  ${dim(spec.send ? "prepare → check → send" : "run")}`)
      const run = runArtemisCaptured(dir, dev.serial, spec.send ? spec.prompt + STOP_BEFORE_SEND : spec.prompt, spec.profile, trace, Number(a["task-timeout"]) * 1000)

      let result: TaskResult
      if (run.status !== 0) {
        result = { status: "failed", reason: run.status === null ? `ARTEMIS did not finish within ${a["task-timeout"]}s` : `ARTEMIS exited ${run.status}`, exit_code: run.status }
      } else {
        const nodes = readUi(dev.serial)
        const hasExpect = Object.keys(spec.expect).length > 0
        const chk = hasExpect ? checkExpect(nodes, spec.expect) : null
        if (spec.send) {
          const targets = findSendTargets(nodes)
          if (!chk!.ok) {
            result = { status: "held", reason: `checker refused the send: the screen does not show what the task expects${nodes.length ? "" : " (the accessibility tree was empty)"}`, mismatches: chk!.mismatches }
            // On the act log too, beside the guard's own refusals: `iris kinetic log` is where a
            // person looks for "what did it NOT do last night", and a held send belongs there.
            appendAct({
              act_id: beginNewAct(), ts: new Date().toISOString(), node: nodeKey(), body, verb: "tap", actor: currentActor().kind, agent: currentActor().kind === "agent" ? (currentActor() as any).hash : null,
              couple_id: null, decision: "deny", reason: `checker: ${chk!.mismatches.map((m) => `${m.key} expected ${m.expected}${m.seen.length ? ` saw ${m.seen.join("/")}` : ""}`).join("; ")}`, unbound: false, estimated_cents: null, run_id: currentRunId(), gate: "checker",
            })
          } else if (targets.length !== 1) {
            result = { status: "held", reason: targets.length === 0 ? "checker passed, but no Send/Confirm-style button is on screen to press" : `checker passed, but ${targets.length} send-class buttons are on screen (${targets.map((t) => t.text || t.desc).join(", ")}) — not guessing which` }
          } else {
            const at = centerOf(targets[0])!
            beginNewAct()
            await guardAct({ body, verb: "tap" })
            adb(["shell", `input tap ${at[0]} ${at[1]}`], { serial: dev.serial })
            await sleep(2500)
            result = { status: "passed", reason: `checked ${chk!.checked} value${chk!.checked === 1 ? "" : "s"}, then pressed "${targets[0].text || targets[0].desc}"` }
          }
        } else if (chk) {
          result = chk.ok ? { status: "passed", reason: `checked ${chk.checked} value${chk.checked === 1 ? "" : "s"}` } : { status: "failed", reason: "finished, but the screen does not show what the task expects", mismatches: chk.mismatches }
        } else {
          result = { status: "passed", reason: "ARTEMIS finished (nothing to check)" }
        }
      }
      const after = screencap(dev.serial, join(bdir, `${spec.id}-after.png`))
      state = setResult(state, spec.id, { ...result, started_at: started, finished_at: new Date().toISOString(), before, after, trace })
      saveState(state)
      console.log(`    ${result.status === "passed" ? success(result.status) : bold(result.status.toUpperCase())}  ${dim(result.reason ?? "")}`)
    }

    const md = renderReport(state, specs)
    const reportPath = join(bdir, "report.md")
    writeFileSync(reportPath, md + "\n", { mode: 0o600 })
    const c = counts(state)
    console.log("")
    console.log(`${bold("done")}  ${c.passed} passed · ${c.held} held · ${c.failed} failed · ${c.interrupted} interrupted · ${c.expired} expired`)
    console.log(dim(`  report  ${reportPath}`))
    if (a["report-bloq"] && a["report-list"]) {
      const waiting = needsYou(state).length
      const id = await postReport(Number(a["report-bloq"]), Number(a["report-list"]), `NIGHT SHIFT ${batchId} — ${c.passed} passed, ${waiting} need you`, md)
      console.log(id ? dim(`  posted  Atlas item #${id}`) : `  ${bold("report NOT posted")} — it is on disk at ${reportPath}`)
    }
    if (needsYou(state).length || c.failed) process.exit(2)
  },
})

const BatchStatusCommand = cmd({
  command: "status [batch]",
  aliases: ["report", "ls", "list"],
  describe: "a batch's state and report (no batch: list them)",
  builder: (y: any) => y.positional("batch", { type: "string" }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    const a = args as any
    if (!a.batch) {
      const root = NIGHT_DIR()
      const ids = existsSync(root) ? readdirSync(root).filter((d) => existsSync(join(root, d, "state.json"))) : []
      if (!ids.length) console.log(dim("No batches yet. Start one: iris android batch run tasks.yaml --until 07:00"))
      for (const id of ids) {
        const s = loadState(id)!
        const c = counts(s)
        console.log(`  ${bold(id)}  ${dim(s.created_at)}  ${c.passed} passed · ${needsYou(s).length} need you · ${c.failed} failed · ${c.expired} expired  ${dim(s.file)}`)
      }
      return
    }
    const s = loadState(String(a.batch))
    if (!s) {
      console.error(`No batch ${a.batch}. List them: iris android batch status`)
      process.exit(1)
    }
    if (a.json) return console.log(JSON.stringify(s))
    const rp = join(NIGHT_DIR(), s.batch_id, "report.md")
    console.log(existsSync(rp) ? readFileSync(rp, "utf-8") : JSON.stringify(counts(s)))
  },
})

function editBatch(id: string, fn: (s: BatchState) => BatchState, verbDone: string, task: string) {
  const s = loadState(id)
  if (!s) {
    console.error(`No batch ${id}. List them: iris android batch status`)
    process.exit(1)
  }
  try {
    saveState(fn(s))
  } catch (e: any) {
    console.error(e.message)
    process.exit(1)
  }
  console.log(`${success(verbDone)}  ${task}  ${dim(`batch ${id}`)}`)
}

const BatchRetryCommand = cmd({
  command: "retry <batch> <task>",
  describe: "put a held, failed or interrupted task back in the queue — it runs on the next `batch run`",
  builder: (y: any) => y.positional("batch", { type: "string", demandOption: true }).positional("task", { type: "string", demandOption: true }),
  async handler(args) {
    const a = args as any
    editBatch(String(a.batch), (s) => retryTask(s, String(a.task)), "queued", String(a.task))
    console.log(dim(`  run it: iris android batch run <the same tasks file>`))
  },
})

const BatchDropCommand = cmd({
  command: "drop <batch> <task>",
  describe: "take a task out of the batch for good",
  builder: (y: any) => y.positional("batch", { type: "string", demandOption: true }).positional("task", { type: "string", demandOption: true }),
  async handler(args) {
    const a = args as any
    editBatch(String(a.batch), (s) => dropTask(s, String(a.task), new Date()), "dropped", String(a.task))
  },
})

const BatchCommand = cmd({
  command: "batch",
  aliases: ["night"],
  describe: "the night shift — a queue of phone tasks, checked before anything is sent",
  builder: (y: any) => y.command(BatchRunCommand).command(BatchStatusCommand).command(BatchRetryCommand).command(BatchDropCommand).demandCommand(),
  async handler() {},
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
      .command(HealthCommand)
      .command(CheckCommand)
      .command(BatchCommand)
      .demandCommand(),
  async handler() {},
})
