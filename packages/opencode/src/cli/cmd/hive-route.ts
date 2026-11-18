// Route a Hive coding task to an agent runtime, and say why (#189154, G8 of epic #189146).
//
// `iris hive tasks create --type code --prompt "..."` used to be impossible: the caller had to
// know the daemon's runtimes (claude_code, opencode, gemini_cli) and pick one by hand. This picks.
//
// Two sources, in order:
//   1. MEASURED — the hive-gate-verdicts dataset (fail-first, integrate). Once there are enough
//      verdicts (MIN_TOTAL overall, MIN_PER_RUNTIME for a runtime to be compared at all), the
//      runtime whose changes pass their gates most often wins, within the class's allowed set.
//   2. THE TABLE — until then, a short starting table. It is a prior, not a policy: the epic's
//      re-plan deferred a hand-written tier table because a table nobody re-measures is folklore.
//      So the table only decides while there is nothing measured to decide with, and the route
//      says which of the two it used.
//
// Plan headroom (send heavy work to the less-used flat-rate plan) is NOT here: nothing in IRIS
// reads plan usage today, and a route that claims to balance on a number it never sees is worse
// than one that says it does not.

export type TaskClass = "review" | "build" | "mechanical" | "triage"
export type Runtime = "claude_code" | "opencode" | "gemini_cli"

export const MIN_TOTAL = 50
export const MIN_PER_RUNTIME = 10

const CLASS_RULES: Array<[TaskClass, RegExp]> = [
  ["review", /\b(review|audit|security|architect\w*|coordinat\w*|plan the|design the|threat model|migrat\w*)\b/i],
  ["triage", /\b(triage|investigat\w*|diagnos\w*|why (is|does|did)|root cause|reproduce|stack ?trace|logs?)\b/i],
  ["mechanical", /\b(typo|rename|readme|docs?|documentation|comment|bump|format\w*|lint\w*|changelog|copy ?edit|spelling)\b/i],
]

export function classify(prompt: string): TaskClass {
  const p = String(prompt || "")
  for (const [cls, re] of CLASS_RULES) if (re.test(p)) return cls
  return "build"
}

/** Which runtimes may take each class at all — strongest-only work never goes to the low-cost lane. */
export const ALLOWED: Record<TaskClass, Runtime[]> = {
  review: ["claude_code"],
  build: ["claude_code", "opencode", "gemini_cli"],
  mechanical: ["opencode", "claude_code", "gemini_cli"],
  triage: ["opencode", "claude_code", "gemini_cli"],
}

/** The starting table: first allowed runtime per class. */
const TABLE_WHY: Record<TaskClass, string> = {
  review: "review/coordination goes to the strongest runtime",
  build: "a feature or fix goes to the strongest runtime until verdicts say otherwise",
  mechanical: "a mechanical edit goes to the low-cost lane",
  triage: "triage goes to the fast lane",
}
const TABLE: Record<TaskClass, Runtime> = { review: "claude_code", build: "claude_code", mechanical: "opencode", triage: "opencode" }

export type Verdict = { passed?: boolean | null; author_vendor?: string | null; author_runtime?: string | null; check?: string | null }

/** The runtime a verdict's author ran on: recorded directly, else inferred from the vendor. */
export function runtimeOf(v: Verdict): Runtime | null {
  const r = String(v.author_runtime || "").toLowerCase()
  if (r === "claude_code" || r === "opencode" || r === "gemini_cli") return r
  const vendor = String(v.author_vendor || "").toLowerCase()
  if (!vendor) return null
  if (vendor.includes("anthropic") || vendor.includes("claude")) return "claude_code"
  if (vendor.includes("google") || vendor.includes("gemini")) return "gemini_cli"
  return "opencode"
}

export type Stats = Record<string, { n: number; passed: number; rate: number }>

export function passRates(verdicts: Verdict[]): { total: number; byRuntime: Stats } {
  const byRuntime: Stats = {}
  let total = 0
  for (const v of verdicts || []) {
    if (typeof v.passed !== "boolean") continue
    const rt = runtimeOf(v)
    if (!rt) continue
    total++
    const s = (byRuntime[rt] ??= { n: 0, passed: 0, rate: 0 })
    s.n++
    if (v.passed) s.passed++
    s.rate = s.passed / s.n
  }
  return { total, byRuntime }
}

export type Route = { cls: TaskClass; runtime: Runtime; source: "measured" | "table"; why: string }

export function route(prompt: string, verdicts: Verdict[] = []): Route {
  const cls = classify(prompt)
  const { total, byRuntime } = passRates(verdicts)
  const measured = ALLOWED[cls].filter((r) => (byRuntime[r]?.n ?? 0) >= MIN_PER_RUNTIME)
  if (total >= MIN_TOTAL && measured.length >= 2) {
    // Ties keep the class's preference order.
    const best = measured.reduce((a, b) => (byRuntime[b].rate > byRuntime[a].rate ? b : a))
    const pct = (r: Runtime) => `${r} ${Math.round(byRuntime[r].rate * 100)}% of ${byRuntime[r].n}`
    return { cls, runtime: best, source: "measured", why: `${cls}: best gate pass rate among ${measured.map(pct).join(", ")} (${total} verdicts)` }
  }
  const need = total >= MIN_TOTAL ? `fewer than 2 runtimes with ${MIN_PER_RUNTIME}+ verdicts` : `${total} of ${MIN_TOTAL} verdicts recorded`
  return { cls, runtime: TABLE[cls], source: "table", why: `${TABLE_WHY[cls]} (starting table — ${need})` }
}
