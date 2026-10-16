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
  /** `project:<board id>` puts it in that board's Project view. */
  tags?: string[]
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
  activeTasks?: number
  maxConcurrent?: number
  cpu?: string
  daemonVersion?: string
  recentRestarts?: number
  /** When the hardware snapshot (disk, memory) was taken — not the heartbeat. */
  hardwareDetectedAt?: string
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
  /** Constellation Gate held this run for approval (#189589). Optional: older engines omit it. */
  held?: boolean
  gate?: { explanation: string; reasons: string[]; action: string | null; score: number | null; hardware: string[] } | null
}

// ── test fixtures ────────────────────────────────────────────────────────────────────────────────

/** Scripts that exist to test the Hive itself. Hidden behind a count, never deleted from view. */
// ── views: All · Project · Marketplace (the Playbooks tabs) ──────────────────────────────────
export type ScriptView = "all" | "project" | "market"
export const SCRIPT_VIEWS: ScriptView[] = ["all", "project", "market"]
export function readView(v: unknown): ScriptView {
  return SCRIPT_VIEWS.includes(v as ScriptView) ? (v as ScriptView) : "all"
}
/** Scripts belong to an account; a board claims one with a tag, since the hub has no project field. */
export function projectTag(bloqId: number | undefined): string | undefined {
  return bloqId && bloqId > 0 ? `project:${bloqId}` : undefined
}
export function inProject(s: Pick<ScriptRow, "tags">, tag: string | undefined): boolean {
  return !!tag && (s.tags ?? []).includes(tag)
}
/** The tags with `tag` added or taken out; every other tag is kept. */
export function withTag(tags: string[] | undefined, tag: string, on: boolean): string[] {
  const rest = (tags ?? []).filter((t) => t !== tag)
  return on ? [...rest, tag] : rest
}
/**
 * The rows a view lists. All hides the Hive's own test scripts behind a count (but keeps the open
 * one visible); Project shows exactly what the board claimed, tests included — claiming is deliberate.
 */
export function scriptsInView<T extends ScriptRow>(
  all: T[],
  view: ScriptView,
  tag: string | undefined,
  opts: { showTests: boolean; open?: string },
): T[] {
  if (view === "market") return []
  if (view === "project") return all.filter((s) => inProject(s, tag))
  return all.filter((s) => opts.showTests || !isTestScript(s.slug) || s.slug === opts.open)
}

/** The script list: a 40px rail when closed, otherwise 130–360px wide. */
export const LIST_RAIL = 40
export function listWidth(w: unknown): number {
  const n = typeof w === "number" && Number.isFinite(w) ? Math.round(w) : 196
  return Math.min(360, Math.max(130, n))
}

export const TEST_PREFIXES = ["e2e-", "s1-", "s23-", "probe-gate", "m1-", "reach-probe", "console-demo"] as const

export function isTestScript(slug: string): boolean {
  return TEST_PREFIXES.some((p) => slug.startsWith(p))
}

// ── the `# iris:` header ─────────────────────────────────────────────────────────────────────────

export type HeaderArg = { name: string; default?: string; required: boolean; line: number; choices?: string[] }
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
      const choices = kv["choices"] ? kv["choices"].split("|").filter(Boolean) : undefined
      out.args.push({ name: value, default: kv["default"], required: kv["required"] === "true", line: i + 1, ...(choices && choices.length > 1 ? { choices } : {}) })
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
  // #189589: held by Constellation Gate — not sent, and not "Queued", which would read as on its way.
  if (task.held) return "Waiting for your approval"
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

// ── find · sort · page ───────────────────────────────────────────────────────────────────────────

export type ScriptSort = "recent" | "name"
export const SCRIPT_SORTS: readonly ScriptSort[] = ["recent", "name"]
export const readSort = (raw: string | null | undefined): ScriptSort => (raw === "name" ? "name" : "recent")
/** Rows a page of the list holds. The account with the most scripts has 37 today. */
export const PAGE_SIZE = 25

/**
 * Every word of the query must appear somewhere in the script — slug, name, description or a
 * tag — so "deal scen" finds deal-scenarios and "csv tidy" finds csv-tidy. Case and the
 * separators people type in place of a hyphen are ignored.
 */
export function matchesQuery(
  s: { slug: string; name?: string | null; description?: string | null; tags?: readonly string[] },
  q: string,
): boolean {
  const words = fold(q).split(" ").filter(Boolean)
  if (!words.length) return true
  const hay = fold([s.slug, s.name ?? "", s.description ?? "", ...(s.tags ?? [])].join(" "))
  return words.every((w) => hay.includes(w))
}
const fold = (t: string) => t.toLowerCase().replace(/[-_./:]+/g, " ").replace(/\s+/g, " ").trim()

/**
 * Recent: newest edit first; a script with no date sinks to the bottom rather than being
 * treated as new. Name: A–Z. Ties fall back to the slug so the order never shuffles on refresh.
 */
export function sortScripts<T extends { slug: string; updatedAt?: string | null }>(list: readonly T[], by: ScriptSort): T[] {
  const time = (s: T) => {
    const t = s.updatedAt ? Date.parse(s.updatedAt) : NaN
    return Number.isFinite(t) ? t : -Infinity
  }
  return [...list].sort((a, b) =>
    by === "recent" ? time(b) - time(a) || a.slug.localeCompare(b.slug) : a.slug.localeCompare(b.slug),
  )
}

/** One page of a list; a page past the end lands on the last page, never on an empty one. */
export function pageOf<T>(list: readonly T[], page: number, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(list.length / size))
  const at = Math.min(Math.max(1, Math.floor(page) || 1), pages)
  const from = (at - 1) * size
  return { rows: list.slice(from, from + size), page: at, pages, from: list.length ? from + 1 : 0, to: Math.min(from + size, list.length), total: list.length }
}

/** The page a script is on, so opening one (⌘K, a remembered pick) shows the page holding it. */
export function pageHolding<T extends { slug: string }>(list: readonly T[], slug: string | undefined, size = PAGE_SIZE): number | undefined {
  const i = slug ? list.findIndex((s) => s.slug === slug) : -1
  return i < 0 ? undefined : Math.floor(i / size) + 1
}

/** The short age a list row carries: "now", "5m", "3h", "2d", "6w", "1y". */
export function shortAgo(iso: string | null | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ""
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  const d = Math.floor(s / 86400)
  return d < 14 ? `${d}d` : d < 365 ? `${Math.floor(d / 7)}w` : `${Math.floor(d / 365)}y`
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

/**
 * Syntax colour for the script view — small, dependency-free, line by line (#189589 follow-up:
 * "flat and ugly and not really scannable"). Not a parser: it colours what makes a script
 * scannable — comments, strings, keywords, numbers, calls — and the `# iris:` header that decides
 * where the script may run. A string or comment that spans lines is coloured per line, which is
 * the right trade for a reading view.
 */
export type Tok = { t: string; k?: "com" | "str" | "kw" | "num" | "fn" | "dir" | "var" }

const KEYWORDS: Record<string, string[]> = {
  python: ["def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or", "import", "from", "as", "try", "except", "finally", "raise", "with", "async", "await", "lambda", "pass", "break", "continue", "yield", "global", "is", "None", "True", "False", "self"],
  bash: ["if", "then", "else", "elif", "fi", "for", "do", "done", "while", "case", "esac", "function", "return", "in", "local", "export", "set", "exit", "echo", "source"],
  js: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "of", "in", "async", "await", "import", "from", "export", "new", "try", "catch", "finally", "throw", "class", "true", "false", "null", "undefined", "typeof"],
}

export function langOf(runtime: string | null | undefined): "python" | "bash" | "js" {
  if (runtime === "python") return "python"
  if (runtime === "node" || runtime === "playwright") return "js"
  return "bash"
}

export function highlightLine(line: string, lang: "python" | "bash" | "js"): Tok[] {
  if (/^\s*(#|\/\/)\s*iris:/.test(line)) return [{ t: line, k: "dir" }]
  const kw = new Set(KEYWORDS[lang])
  const comment = lang === "js" ? "//" : "#"
  const out: Tok[] = []
  let i = 0
  let plain = ""
  const flush = () => {
    if (plain) out.push({ t: plain })
    plain = ""
  }
  while (i < line.length) {
    const rest = line.slice(i)
    if (rest.startsWith(comment) && !(lang === "bash" && i > 0 && /[\w$]/.test(line[i - 1]))) {
      flush()
      out.push({ t: rest, k: "com" })
      break
    }
    const q = line[i]
    if (q === '"' || q === "'" || (q === "`" && lang === "js")) {
      const triple = lang === "python" && rest.startsWith(q.repeat(3))
      const close = triple ? q.repeat(3) : q
      let j = i + close.length
      while (j < line.length && !line.startsWith(close, j)) j += line[j] === "\\" ? 2 : 1
      j = Math.min(line.length, j + close.length)
      flush()
      out.push({ t: line.slice(i, j), k: "str" })
      i = j
      continue
    }
    if (lang === "bash" && q === "$") {
      const m = /^\$(\{[^}]*\}|[A-Za-z_][\w]*|\d|[@#?*!$])/.exec(rest)
      if (m) {
        flush()
        out.push({ t: m[0], k: "var" })
        i += m[0].length
        continue
      }
    }
    const word = /^[A-Za-z_][\w]*/.exec(rest)
    if (word && (i === 0 || !/[\w.]/.test(line[i - 1]) || lang !== "bash")) {
      const w = word[0]
      const prev = line[i - 1]
      if (kw.has(w) && !(prev && /[\w]/.test(prev))) {
        flush()
        out.push({ t: w, k: "kw" })
      } else if (line[i + w.length] === "(") {
        flush()
        out.push({ t: w, k: "fn" })
      } else plain += w
      i += w.length
      continue
    }
    const num = /^\d+(\.\d+)?/.exec(rest)
    if (num && !(i > 0 && /[\w]/.test(line[i - 1]))) {
      flush()
      out.push({ t: num[0], k: "num" })
      i += num[0].length
      continue
    }
    plain += q
    i++
  }
  flush()
  return out
}

/**
 * The values a run sends for a script's declared settings (#189589): what the person typed or
 * picked, else the declared default; empty optional settings are left out so the script's own
 * fallback applies. Unknown names are passed through so the hub can refuse them with a sentence.
 */
export function runArgs(declared: ScriptHeader["args"], values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of declared) {
    const v = (values[a.name] ?? "").trim()
    if (v !== "") out[a.name] = v
    else if (a.default !== undefined && a.default !== "") out[a.name] = a.default
  }
  for (const [k, v] of Object.entries(values)) if (!(k in out) && !declared.some((a) => a.name === k) && v.trim() !== "") out[k] = v.trim()
  return out
}

/** Required settings with no value — Run says which, instead of sending a run the hub will refuse. */
export function missingRequired(declared: ScriptHeader["args"], values: Record<string, string>): string[] {
  return declared.filter((a) => a.required && !(values[a.name] ?? "").trim() && !a.default).map((a) => a.name)
}
