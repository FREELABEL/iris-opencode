/**
 * Hive › Scripts (#188817) — the pure half.
 *
 * Every rule the Scripts tab draws from lives here, so it can be tested without a DOM or a
 * network: reading a script's `# iris:` header, the ⌘K command line, which scripts are test
 * fixtures, which computers are the same computer registered several times, whether a script can
 * run anywhere right now and what one fix would unblock it, and which stage a dispatched task has
 * reached.
 *
 * The verdict on "can this run" is the HUB's (`/api/v1/scripts/:slug/doctor`), not recomputed
 * here: the hub is what refuses a dispatch, so a second opinion in the client would eventually
 * disagree with the router. This module only turns the hub's reasons into a fix a person can do.
 */

// ── wire shapes (what the sidecar sends) ─────────────────────────────────────────────────────────

export type DoctorUnmet = { requirement: string; reason: string }
export type DoctorRow = { node: string; verdict?: { ok?: boolean; unmet?: DoctorUnmet[]; summary?: string } }
export type Doctor = {
  slug: string
  requires?: string[]
  manifest_errors?: string[]
  timeout?: number | null
  eligible?: DoctorRow[]
  eligible_online?: number | null
  blocked?: DoctorRow[]
  runnable_now?: boolean
}

export type ScriptRow = {
  slug: string
  name?: string
  description?: string
  runtime?: string
  updatedAt?: string
  /** NULL on every script today (the field is never written) — never shown as "last run". */
  lastExecutedAt?: string | null
  doctor?: Doctor | null
}

export type HiveNodeRow = {
  id: string
  name: string
  online: boolean
  lastHeartbeat: string | null
  os?: string
  cores?: number
  memoryGb?: number
  diskTotalGb?: number
  diskFreeGb?: number
  capabilities?: readonly string[]
  tasksCompleted?: number
}

export type TaskView = {
  id: string
  status: string
  terminal: boolean
  createdAt?: string | null
  dispatchedAt?: string | null
  arrivedAt?: string | null
  startedAt?: string | null
  completedAt?: string | null
  stdout: string
  stderr: string
  exitCode: number | null
  /** `error_text` = recovered from the daemon's English, not reported — label it as inferred. */
  exitCodeSource: "metadata" | "result" | "error_text" | null
  error: string | null
  nodeName: string | null
  durationMs: number | null
}

// ── test fixtures ────────────────────────────────────────────────────────────────────────────────

/** Scripts that exist to test the Hive itself. Hidden behind a count, never deleted from view. */
export const TEST_PREFIXES = ["e2e-", "s1-", "s23-", "probe-gate", "m1-", "reach-probe", "console-demo"] as const

export function isTestScript(slug: string): boolean {
  return TEST_PREFIXES.some((p) => slug.startsWith(p))
}

// ── the `# iris:` header ─────────────────────────────────────────────────────────────────────────

export type HeaderArg = { name: string; default?: string; required: boolean; line: number }
export type ScriptHeader = {
  args: HeaderArg[]
  timeout: number | null
  requires: string[]
  egress: string | null
  /** 1-based line numbers of every `# iris:` line, so the editor can mark them. */
  lines: number[]
}

/**
 * Read the `# iris: key=value` lines a script declares about itself.
 *
 * Only the leading comment block counts — the daemon's manifest parser stops at the first line of
 * code, and a header field that only THIS reader honoured would be a promise nobody keeps.
 * `arg=<name> default=<v>` and `arg=<name> required` become inputs; the rest are chips.
 */
export function parseHeader(source: string): ScriptHeader {
  const out: ScriptHeader = { args: [], timeout: null, requires: [], egress: null, lines: [] }
  const lines = source.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (i === 0 && raw.startsWith("#!")) continue
    if (raw === "") continue
    if (!raw.startsWith("#") && !raw.startsWith("//")) break
    const m = /^(?:#|\/\/)\s*iris:\s*(.+)$/.exec(raw)
    if (!m) continue
    out.lines.push(i + 1)
    const words = m[1].trim().split(/\s+/)
    const [key, ...rest] = (words[0] ?? "").split("=")
    const value = rest.join("=")
    if (key === "arg" && value) {
      const kv = Object.fromEntries(
        words.slice(1).map((w) => {
          const at = w.indexOf("=")
          return at < 0 ? [w, "true"] : [w.slice(0, at), w.slice(at + 1)]
        }),
      )
      out.args.push({ name: value, default: kv["default"], required: kv["required"] === "true", line: i + 1 })
    } else if (key === "timeout") {
      const n = Number(value)
      if (Number.isFinite(n) && n > 0) out.timeout = n
    } else if (key === "requires" && value) {
      out.requires.push(...value.split(",").map((s) => s.trim()).filter(Boolean))
    } else if (key === "egress" && value) {
      out.egress = value
    }
  }
  return out
}

/**
 * Change an arg's declared default IN THE SOURCE. The input boxes are the header, so editing one
 * edits the `# iris: arg=` line it came from — there is no second copy that could disagree.
 * An empty value removes `default=`; any other word on the line (`required`) is kept.
 */
export function setArgDefault(source: string, name: string, value: string): string {
  const header = parseHeader(source)
  const arg = header.args.find((a) => a.name === name)
  if (!arg) return source
  const lines = source.split("\n")
  const line = lines[arg.line - 1]
  const v = value.trim().replace(/\s+/g, "_")
  let next: string
  if (/\sdefault=\S*/.test(line)) next = v ? line.replace(/(\s)default=\S*/, `$1default=${v}`) : line.replace(/\s+default=\S*/, "")
  else next = v ? line.replace(new RegExp(`(arg=${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`), `$1 default=${v}`) : line
  lines[arg.line - 1] = next
  return lines.join("\n")
}

export function fileName(slug: string, runtime?: string): string {
  const ext = ({ bash: "sh", node: "js", python: "py", playwright: "spec.ts" } as Record<string, string>)[runtime ?? ""] ?? "sh"
  return `${slug}.${ext}`
}

// ── ⌘K ───────────────────────────────────────────────────────────────────────────────────────────

export type Command = { verb: "run" | "edit" | "open"; slug: string; args: Record<string, string>; node?: string }

/**
 * `run <slug> [name=value …] [on <node>]` · `edit <slug>` · `<slug>` (open it).
 * Returns null for anything else rather than guessing what was meant.
 */
export function parseCommand(input: string): Command | null {
  const words = input.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return null
  let verb: Command["verb"] = "open"
  if (words[0] === "run" || words[0] === "edit" || words[0] === "open") verb = words.shift() as Command["verb"]
  const slug = words.shift()
  if (!slug || slug.includes("=")) return null
  const args: Record<string, string> = {}
  let node: string | undefined
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w === "on") {
      node = words.slice(i + 1).join(" ") || undefined
      break
    }
    const at = w.indexOf("=")
    if (at <= 0) return null
    args[w.slice(0, at)] = w.slice(at + 1)
  }
  return { verb, slug, args, node }
}

/** The command line that would do what the screen is showing — what ⌘K shows as its hint. */
export function commandFor(slug: string, args: Record<string, string>, node?: string): string {
  const a = Object.entries(args)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${v}`)
  return ["run", slug, ...a, ...(node ? ["on", node] : [])].join(" ")
}

// ── one computer, several registrations ──────────────────────────────────────────────────────────

export type Computer = HiveNodeRow & {
  /** How many node records are this same computer. */
  regs: number
  /** Every registration's name — the doctor speaks in node NAMES, which repeat. */
  names: string[]
  ids: string[]
}

/**
 * Group registrations of the same computer: same OS, cores, memory and disk size. The MacBook is
 * three node records today; showing three MacBooks would say three computers can take work.
 * The representative is the online registration (else the most recent heartbeat).
 */
export function groupComputers(nodes: readonly HiveNodeRow[]): Computer[] {
  const groups = new Map<string, HiveNodeRow[]>()
  for (const n of nodes) {
    const hasSig = n.os != null || n.cores != null || n.memoryGb != null || n.diskTotalGb != null
    const sig = hasSig ? [n.os, n.cores, n.memoryGb, n.diskTotalGb].join("|") : `id:${n.id}`
    const g = groups.get(sig)
    if (g) g.push(n)
    else groups.set(sig, [n])
  }
  const beat = (n: HiveNodeRow) => (n.lastHeartbeat ? Date.parse(n.lastHeartbeat) || 0 : 0)
  const out: Computer[] = []
  for (const regs of groups.values()) {
    const sorted = [...regs].sort((a, b) => Number(b.online) - Number(a.online) || beat(b) - beat(a))
    out.push({ ...sorted[0], regs: regs.length, names: [...new Set(sorted.map((r) => r.name))], ids: sorted.map((r) => r.id) })
  }
  out.sort((a, b) => Number(b.online) - Number(a.online) || (b.tasksCompleted ?? 0) - (a.tasksCompleted ?? 0))
  return out
}

export function diskOf(c: HiveNodeRow): { free: number; total: number; pct: number } | null {
  if (!c.diskTotalGb || c.diskFreeGb == null) return null
  return { free: c.diskFreeGb, total: c.diskTotalGb, pct: (c.diskFreeGb / c.diskTotalGb) * 100 }
}

/** Under 2% free is critical: a run that writes anything can fail on it. */
export function diskCritical(c: HiveNodeRow): boolean {
  const d = diskOf(c)
  return !!d && d.pct < 2
}

/** Capability → (icon, word). Only the ones a person cares about; at most `limit`. */
export const SKILLS: Record<string, { icon: string; word: string }> = {
  browser: { icon: "globe", word: "Browses the web" },
  browser_use: { icon: "globe", word: "Browses the web" },
  camera: { icon: "camera", word: "Camera" },
  audio_in: { icon: "microphone", word: "Listens" },
  audio_out: { icon: "speaker", word: "Speaks" },
  gpu: { icon: "chip", word: "GPU" },
  docker: { icon: "box", word: "Runs apps (Docker)" },
  bluetooth: { icon: "bluetooth", word: "Bluetooth" },
  disk_encrypted: { icon: "lock", word: "Encrypted disk" },
  instagram: { icon: "at", word: "Instagram" },
}

export function skillsOf(c: HiveNodeRow, limit = 3): { icon: string; word: string }[] {
  const seen = new Set<string>()
  const out: { icon: string; word: string }[] = []
  for (const cap of c.capabilities ?? []) {
    const s = SKILLS[cap]
    if (!s || seen.has(s.word)) continue
    seen.add(s.word)
    out.push(s)
  }
  return out.slice(0, limit)
}

// ── readiness and the one fix ────────────────────────────────────────────────────────────────────

export type Readiness =
  | { state: "unknown"; label: string; fix: null }
  | { state: "ok"; label: string; fix: null; onlineCount: number }
  | { state: "blocked"; label: string; fix: string | null }

function fixWords(node: string, u: DoctorUnmet): string | null {
  const r = u.reason
  if (/privacy/i.test(r)) {
    const what = u.requirement.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    return `${node} needs ${what} — grant it in macOS Settings`
  }
  if (/STOPPED reporting/.test(r)) return `${node} stopped reporting what it can do — restart its Hive daemon`
  if (/not advertised/i.test(r)) return `No online computer has ${u.requirement}`
  return null
}

/** Rank: a setting the owner can change beats a daemon restart beats anything else. */
function fixRank(u: DoctorUnmet): number {
  if (/privacy/i.test(u.reason)) return 0
  if (/STOPPED reporting/.test(u.reason)) return 1
  return 2
}

/**
 * Can this script run on an online computer right now, and if not, the most actionable fix.
 *
 * Counts come from the doctor's own `eligible_online`, never from matching names: node names
 * repeat (duplicate registrations) and a name match would count one MacBook three times.
 * Only reasons from ONLINE computers are fixes — an offline computer's unmet list is moot until
 * it comes back, and "turn it on" is already said by the offline row.
 */
export function readiness(doctor: Doctor | null | undefined, onlineNames: ReadonlySet<string>): Readiness {
  if (!doctor) return { state: "unknown", label: "Not checked yet", fix: null }
  const n = doctor.eligible_online ?? 0
  if (n > 0) return { state: "ok", label: `Ready on ${n} computer${n === 1 ? "" : "s"}`, fix: null, onlineCount: n }
  const reasons: { node: string; u: DoctorUnmet }[] = []
  for (const b of doctor.blocked ?? []) {
    if (!onlineNames.has(b.node)) continue
    for (const u of b.verdict?.unmet ?? []) reasons.push({ node: b.node, u })
  }
  reasons.sort((a, b) => fixRank(a.u) - fixRank(b.u))
  let fix: string | null = null
  for (const r of reasons) {
    fix = fixWords(r.node, r.u)
    if (fix) break
  }
  return { state: "blocked", label: "Can't run anywhere right now", fix }
}

/** The fix that unblocks the most scripts, and which ones. Null when nothing is blocked on a fix. */
export function topFix(
  scripts: readonly ScriptRow[],
  onlineNames: ReadonlySet<string>,
): { fix: string; slugs: string[] } | null {
  const by = new Map<string, string[]>()
  for (const s of scripts) {
    const r = readiness(s.doctor, onlineNames)
    if (r.state !== "blocked" || !r.fix) continue
    by.set(r.fix, [...(by.get(r.fix) ?? []), s.slug])
  }
  let best: { fix: string; slugs: string[] } | null = null
  for (const [fix, slugs] of by) if (!best || slugs.length > best.slugs.length) best = { fix, slugs }
  return best
}

/** Can this computer take this script? By name, against the doctor's eligible list. */
export function computerVerdict(
  c: Computer,
  doctor: Doctor | null | undefined,
): { can: boolean | null; why?: string } {
  if (!doctor) return { can: null }
  const row = (doctor.blocked ?? []).find((b) => c.names.includes(b.node))
  const u = row?.verdict?.unmet?.[0]
  const why = u ? `${u.requirement} — ${u.reason}` : row?.verdict?.summary
  // The hub's own count wins over a name match: names repeat across registrations, so an OFFLINE
  // duplicate can be "eligible" under the same name as the online computer that is blocked.
  if (c.online && (doctor.eligible_online ?? 0) === 0) return { can: false, why: why ?? "No online computer can run it" }
  if ((doctor.eligible ?? []).some((e) => c.names.includes(e.node))) return { can: true }
  if (!row) return { can: null }
  return { can: false, why }
}

/** Which computer Run sends to by default: the first online one that can take it. */
export function defaultComputer(computers: readonly Computer[], doctor: Doctor | null | undefined): Computer | undefined {
  // A computer whose disk is nearly full is the last choice, not the first: a run that writes
  // anything can fail on it for a reason that has nothing to do with the script.
  const online = computers.filter((c) => c.online).sort((a, b) => Number(diskCritical(a)) - Number(diskCritical(b)))
  return online.find((c) => computerVerdict(c, doctor).can === true) ?? online.find((c) => computerVerdict(c, doctor).can !== false)
}

/** Resolve the ⌘K `on <node>` the way the CLI does: id, exact name, id prefix, name prefix. */
export function findComputer(computers: readonly Computer[], target: string): Computer | undefined {
  const t = target.toLowerCase()
  return (
    computers.find((c) => c.ids.includes(target)) ??
    computers.find((c) => c.names.some((n) => n.toLowerCase() === t)) ??
    computers.find((c) => c.ids.some((id) => id.startsWith(target))) ??
    computers.find((c) => c.names.some((n) => n.toLowerCase().startsWith(t)))
  )
}

// ── stages ───────────────────────────────────────────────────────────────────────────────────────

export const STAGES = [
  { id: "queued", label: "Queued", icon: "clock", field: "createdAt" },
  { id: "sent", label: "Sent", icon: "send", field: "dispatchedAt" },
  { id: "arrived", label: "Arrived", icon: "pin", field: "arrivedAt" },
  { id: "running", label: "Running", icon: "play", field: "startedAt" },
  { id: "done", label: "Done", icon: "check", field: "completedAt" },
] as const

export type StageId = (typeof STAGES)[number]["id"]
export type StageState = "done" | "now" | "todo" | "failed"

/**
 * Where a task is, from the timestamps the Hive recorded — never from a clock in the client.
 * The furthest stage with a timestamp is where it is; every stage before it is done. A terminal
 * task that did not succeed marks its last reached stage `failed` rather than painting Done green.
 */
export function stageStates(task: TaskView | null | undefined): Record<StageId, StageState> {
  const out = Object.fromEntries(STAGES.map((s) => [s.id, "todo"])) as Record<StageId, StageState>
  if (!task) return out
  let reached = -1
  STAGES.forEach((s, i) => {
    if (task[s.field]) reached = i
  })
  if (reached < 0) reached = 0 // a task that exists is at least queued
  const ok = taskSucceeded(task)
  STAGES.forEach((s, i) => {
    if (i < reached) out[s.id] = "done"
    else if (i === reached) out[s.id] = task.terminal ? (ok ? "done" : "failed") : "now"
  })
  if (task.terminal && ok) out.done = "done"
  return out
}

/** Succeeded = a terminal success status AND (no exit code, or exit 0). Unknown is not success. */
export function taskSucceeded(task: TaskView | null | undefined): boolean {
  if (!task || !task.terminal) return false
  if (typeof task.exitCode === "number") return task.exitCode === 0
  return task.status === "completed" || task.status === "succeeded"
}

export function taskStatusWord(task: TaskView | null | undefined): string {
  if (!task) return "Ready"
  if (task.terminal) {
    if (taskSucceeded(task)) return task.exitCode != null ? `Done · exit ${task.exitCode}` : "Done"
    if (task.status === "timeout") return "Timed out"
    return task.exitCode != null ? `Failed · exit ${task.exitCode}` : `Failed`
  }
  const st = stageStates(task)
  const now = STAGES.find((s) => st[s.id] === "now")
  return now?.label ?? "Queued"
}

/** Seconds since the task was created, until it completed. */
export function elapsedSeconds(task: TaskView | null | undefined, now: number): number {
  if (!task?.createdAt) return 0
  const start = Date.parse(task.createdAt)
  const end = task.completedAt ? Date.parse(task.completedAt) : now
  return Math.max(0, (end - start) / 1000)
}

/** The last non-empty output line — what the computer card shows under "Running here". */
export function lastLine(text: string | null | undefined): string {
  const lines = String(text ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean)
  return lines.at(-1) ?? ""
}

export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return "never"
  const s = (now - Date.parse(iso)) / 1000
  if (!Number.isFinite(s)) return "unknown"
  if (s < 120) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86400)
  return d === 1 ? "yesterday" : d < 14 ? `${d} days ago` : `${Math.floor(d / 7)} weeks ago`
}
