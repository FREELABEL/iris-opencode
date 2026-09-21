/**
 * WHAT COUNTS AS A BODY, and which command is an act on one.
 *
 * The first cut of the clutch guarded `iris camera` and `iris obs` by hand, which made enforcement
 * opt-in: `iris device`, `iris hive` and anything written next month drove hardware with no check
 * at all. That is the same shape as Genesis invariant 4 — "the decision exists in exactly one
 * place; a lane that grows its own copy skips it".
 *
 * So the route table moved HERE, and one middleware consults it for every command the CLI runs.
 * A new act path is guarded by adding a row, not by remembering to call a function. A row nobody
 * adds still fails safe in the direction that matters: unrouted commands are reads.
 *
 * Pure: no yargs, no fs, no network. `routeFor` takes the argv the user typed.
 */

export interface BodyClass {
  /** The `class` half of `class:instance`. */
  name: string
  describe: string
  /** The vocabulary a couple may bless for this class. Coupling an unknown verb is a typo, not a policy. */
  verbs: string[]
}

/**
 * The classes IRIS can drive today. Adding a robot arm is a row here plus an adapter — never a
 * change to the guard, which is why `arm:ur5` already works end to end before the arm exists.
 */
export const BODY_CLASSES: BodyClass[] = [
  { name: "camera", describe: "a PTZ webcam over UVC", verbs: ["move", "zoom", "patrol", "reset", "preset"] },
  { name: "obs", describe: "OBS Studio — what is being captured", verbs: ["scene", "record", "stream", "mute"] },
  // `iris device` is THIS machine's disk and logs — not a phone. Checked against the command's real
  // subcommands (scan, log, clean) rather than assumed; the first draft of this row invented verbs
  // no act path has, which is a couple that can never match dressed up as policy.
  { name: "device", describe: "this machine's disk — reclaiming space deletes files", verbs: ["clean"] },
  { name: "node", describe: "another machine in the Hive", verbs: ["run", "task", "script", "send"] },
  { name: "n8n", describe: "an automation that reaches the world", verbs: ["trigger", "activate"] },
  // A phone is the highest-consequence body on this list and the only one carrying someone's
  // logged-in sessions — bank, mail, the 2FA codes for everything else. ARTEMIS (google/artemis)
  // ships an MCP server that drives one over ADB with NO permission model at all, which is the
  // whole reason this row exists: the adapter is theirs, the clutch is ours.
  //
  // Verbs are the canonical agent-facing actions ARTEMIS actually declares
  // (artemis/mcp/action_specs.py: click, long_press, input_text, swipe, press_key, manage_app,
  // open_link, ...), collapsed to the sub-commands `iris phone` exposes. Read out of their source,
  // not invented — the `device` row above records what inventing verbs costs.
  { name: "android", describe: "an Android device over ADB — a real phone, with real sessions on it", verbs: ["run", "tap", "type", "swipe", "key", "app", "open"] },
]

export const bodyClass = (name: string): BodyClass | null =>
  BODY_CLASSES.find((c) => c.name === String(name ?? "").trim().toLowerCase()) ?? null

export interface Route {
  /** The body class this command acts on. */
  class: string
  verb: string
  /**
   * The instance, when the argv alone names it (a hive node). Null means the act path knows it and
   * the class-level check runs first — see `kinetic-guard`'s two-step.
   */
  instance?: string | null
}

/** Sub-commands that only LOOK. Looking is not moving, so these are never acts. */
const READS: Record<string, string[]> = {
  camera: ["list", "ls", "devices", "pos", "position", "status"],
  obs: ["scenes", "inputs", "status", "connect", "disconnect", "dashboard"],
  device: ["scan", "audit", "log", "record", "list", "ls", "status"],
  node: ["list", "ls", "nodes", "status", "scan", "ping", "doctor", "uptime"],
  n8n: ["list", "ls", "status", "export", "workflows"],
  // `screenshot` and `state` READ the screen — looking is not moving, same call as `camera pos`.
  // `doctor` is OUR local capability check (is adb here, is a device attached), deliberately NOT
  // ARTEMIS's `mobile_diagnose`, which can launch an emulator and apply fixes. A read that can
  // repair things is not a read, and naming ours `doctor` while calling theirs would smuggle an
  // act through this list.
  android: ["devices", "list", "ls", "state", "screen", "screenshot", "logcat", "trace", "doctor", "status"],
}

/** `iris obs record status` is a read; `iris obs record start` is an act. Same sub-command, different argv. */
const STATUS_ARG = new Set(["status", "state"])

/**
 * Which body does this command act on, and with what verb?
 *
 * Returns null for a read, for an unrouted command, and for `iris kinetic` itself — a command that
 * only INSPECTS the clutch cannot need the clutch's permission, or `kinetic couple list` would
 * require a couple to find out you have none.
 */
export function routeFor(argv: string[], parsed?: string[]): Route | null {
  const parts = (argv ?? []).map((a) => String(a ?? "").trim().toLowerCase()).filter(Boolean)
  if (parts.length === 0) return null

  // TWO SOURCES, EACH FOR WHAT IT IS GOOD AT.
  //
  // `parsed` is yargs' own command path (its `_`), which is the only reliable way to know WHICH
  // command ran: raw argv can lead with a global flag, and a flag's VALUE looks exactly like a word
  // (`iris --log-level DEBUG camera left` would otherwise be read as the command "debug").
  // Raw argv is the only place the INSTANCE survives, because yargs assigns named positionals and
  // `iris hive run studio-mac` arrives as ["hive","run"] — the node it drives, gone.
  const words = parts.filter((p) => !p.startsWith("-"))
  const path = (parsed ?? []).map((a) => String(a ?? "").trim().toLowerCase()).filter(Boolean)
  const [head, sub] = path.length > 0 ? path : words
  // the instance is the word after the sub-command, as typed
  const at = sub ? words.indexOf(sub) : -1
  const third = at >= 0 ? words[at + 1] : words[2]
  // Belt and braces: `kinetic` is also absent from the class map below, so this line is not load
  // bearing today (no mutation of it fails a test). It is here so that adding a "kinetic" body
  // class later cannot make the clutch require its own permission to be inspected.
  if (head === "kinetic" || head === "kinetics") return null

  const map: Record<string, string> = { camera: "camera", cam: "camera", ptz: "camera", obs: "obs", device: "device", hive: "node", n8n: "n8n", android: "android", adb: "android" }
  const cls = map[head]
  if (!cls) return null
  if (!sub) return null
  if ((READS[cls] ?? []).includes(sub)) return null
  // `record status` / `stream status` read; `record start` acts.
  if (STATUS_ARG.has(String(third ?? ""))) return null

  if (cls === "camera") {
    const verb = sub === "zoom" ? "zoom" : sub === "patrol" ? "patrol" : sub === "reset" ? "reset" : sub === "preset" ? "preset" : "move"
    return { class: "camera", verb, instance: null }
  }
  if (cls === "obs") {
    const verb = sub === "scene" || sub === "switch" ? "scene" : sub === "record" || sub === "rec" ? "record" : sub === "stream" ? "stream" : sub === "mute" ? "mute" : null
    return verb ? { class: "obs", verb, instance: "studio" } : null
  }
  if (cls === "node") {
    // `iris hive run <node> <cmd>` — arbitrary shell on another machine, the epic's named danger.
    const verb = sub === "run" || sub === "exec" ? "run" : sub === "task" ? "task" : sub === "script" ? "script" : sub === "send" ? "send" : null
    return verb ? { class: "node", verb, instance: third && !third.startsWith("-") ? third : null } : null
  }
  if (cls === "android") {
    const verb =
      sub === "run" || sub === "task" ? "run"
      : sub === "tap" || sub === "click" || sub === "press" ? "tap"
      : sub === "type" || sub === "input" || sub === "text" ? "type"
      : sub === "swipe" || sub === "scroll" ? "swipe"
      : sub === "key" ? "key"
      : sub === "app" ? "app"
      : sub === "open" ? "open"
      : null
    // INSTANCE IS ALWAYS NULL HERE, and this is the one line to get right. Every other class either
    // has no positional instance or has it in a fixed slot; a phone's device serial arrives as
    // `--device <serial>`, while the word after the sub-command is the PAYLOAD —
    // `iris android run "open settings"` would otherwise ask for a couple on `android:open settings`,
    // a body that cannot exist, so every act would be refused for the wrong reason and the fix
    // would look like loosening the guard. The handler resolves the real serial and re-asks
    // precisely via guardAct; coarse first, fine second.
    return verb ? { class: "android", verb, instance: null } : null
  }
  if (cls === "n8n") {
    const verb = sub === "trigger" || sub === "execute" || sub === "run" ? "trigger" : sub === "activate" ? "activate" : null
    return verb ? { class: "n8n", verb, instance: null } : null
  }
  // `device clean` is a DRY RUN until --apply, the same read/act split as `obs record status`.
  // Guarding the dry run would train people to couple for a command that changes nothing.
  if (sub === "clean") return parts.includes("--apply") ? { class: "device", verb: "clean", instance: null } : null // --apply is a FLAG, so read it from parts
  return null
}

/** Verbs a couple may bless for a class — used to refuse a typo at coupling time, not at act time. */
export function knownVerbs(cls: string): string[] {
  return bodyClass(cls)?.verbs ?? []
}

export function unknownVerbs(body: string, verbs: string[]): string[] {
  const cls = String(body ?? "").split(":")[0] ?? ""
  const known = knownVerbs(cls)
  if (known.length === 0) return [] // an adapter we do not model yet: do not pretend to know its vocabulary
  return verbs.filter((v) => v !== "*" && !known.includes(String(v ?? "").trim().toLowerCase()))
}

/**
 * The cost a caller declared for this act, from argv or the environment.
 *
 * Nothing guesses. A budget that fires on an invented number is worse than no budget, so an act
 * with no declared cost is counted as zero against the ceiling — and the ceiling's job is to stop
 * the acts that DO declare (rented compute, metered APIs).
 */
export function declaredCents(argv: string[], env: Record<string, string | undefined> = process.env): number | null {
  const parts = argv ?? []
  const i = parts.findIndex((a) => a === "--cents" || a === "--estimate-cents")
  const raw = i >= 0 ? parts[i + 1] : env.IRIS_ACT_CENTS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}
