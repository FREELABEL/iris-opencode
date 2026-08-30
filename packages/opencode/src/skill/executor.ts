import matter from "gray-matter"
import { minimatch } from "minimatch"
import { Skill } from "./skill"
import { ConfigMarkdown } from "../config/markdown"
import { Log } from "../util/log"
import { homedir } from "os"
import { join, dirname, resolve as resolvePath, relative as relativePath, isAbsolute } from "path"
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, chmodSync } from "fs"

const log = Log.create({ service: "skill-executor" })

// ============================================================================
// Types
// ============================================================================

export interface ArgDef {
  type: "string" | "number" | "boolean"
  required: boolean
  default?: unknown
  enum?: string[]
  description?: string
}

export interface StepDef {
  id: string
  title: string
  mode: "shell" | "prompt" | "ai" | "hive" | "hive-script" | "skill" | "playbook" | "human" | "agent" | "manual" | "cloud-workflow" | "cloud-agentic" | "n8n" | "langgraph" | "schedule"
  body: string
  code: string | null
  confirm: boolean
  depends: string | null
  retry: number
  delay: number
  condition: string | null
  model: string | null
  node: string | null
  skillRef: string | null
  skillArgs: string | null
  workflowId: string | null
  webhook: string | null
  cron: string | null
  input: Record<string, any> | null
  /** Which connected services this step actually touches — Slack, Gmail, Stripe, etc. Freeform,
   * same reasoning as playbook-level `integrations` but scoped to the one step that needs it,
   * so a reader (or an agent deciding whether it can run this step) doesn't have to assume the
   * whole playbook's integration list applies to every step in it. */
  integrations: string[]
}

export interface SkillPlan {
  name: string
  version: 1 | 2
  /**
   * The `version` exactly as written in frontmatter, before coercion to 1|2.
   * `version` above silently becomes 1 for anything that is not exactly 2, which
   * makes an authoring typo ("version: 3") indistinguishable from a genuine v1
   * playbook. Keep the raw value so validation can tell those two apart.
   */
  declaredVersion?: unknown
  /**
   * How many `### step:` blocks exist in the body, regardless of `version`.
   * A non-2 version parses `steps` as [] — so without this a mis-versioned
   * playbook looks identical to one that legitimately has no steps.
   */
  bodyStepCount?: number
  description: string
  args: Record<string, ArgDef>
  steps: StepDef[]
  includes: string[]
  confirm: string[]
  onError: "continue" | "stop" | "ask"
  timeout: number
  integrations: string[]
  location: string
  /** Vertical/industry classification for playbook-library discovery — freeform, not a fixed taxonomy. */
  industries?: string[]
  /**
   * WHEN to invoke this playbook — the situations that should make a model pick it.
   * Distinct from `description`, which says what it does. Freeform, not a taxonomy.
   */
  triggers?: string[]
}

export interface StepResult {
  id: string
  status: "success" | "failed" | "skipped" | "pending" | "paused"
  output: string
  exit_code: number | null
  duration_ms: number
  attempts: number
}

export interface SkillResult {
  run_id: string
  skill: string
  status: "completed" | "failed" | "interrupted" | "paused"
  steps: Record<string, StepResult>
  started_at: string
  finished_at: string
  args: Record<string, unknown>
  /** Set when status is "paused" — the human step the run is waiting on. */
  paused_on?: { id: string; title: string; instructions: string }
}

// ============================================================================
// Runs directory
// ============================================================================

const RUNS_DIR = join(homedir(), ".iris", "skill-runs")

/**
 * Run checkpoints are OWNER-READABLE ONLY (#182461).
 *
 * A checkpoint stores each step's captured output, so anything a step printed is on disk
 * verbatim. Measured on a real machine: 10 of 81 checkpoints in ~/.iris/skill-runs held a
 * populated OAuth `access_token=`, every file at mode 0644 — readable by any local process.
 *
 * This is not hypothetical tidiness. The CLI and Desktop app are going to beta users on
 * machines we do not control, and a playbook that touches an integration writes its
 * credentials into this directory as a side effect of running.
 *
 * Redacting the captured output is the deeper fix and is tracked separately; permissions are
 * the part that must not wait, because it costs nothing and covers every secret shape at once.
 */
function ensureRunsDir() {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true, mode: 0o700 })
  // Re-assert on every call: `mode` applies only at CREATE, so an install that already has
  // a 0755 directory would otherwise keep it forever and the upgrade would fix nobody.
  try {
    chmodSync(RUNS_DIR, 0o700)
  } catch {
    // Best effort — never lose the run because a platform lacks chmod.
  }
}

/** Write a checkpoint 0600, re-asserting the mode for files that already exist. */
function writeCheckpointFile(path: string, contents: string) {
  writeFileSync(path, contents, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* best effort */
  }
}

function generateRunId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  let id = "sk_"
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)]
  return id
}

// ============================================================================
// Dangerous command auto-detection
// ============================================================================

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\b/,
  /\bgit\s+push\s+--force\b/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\brailway\s+redeploy\b/,
  /\bdoctl\s+apps\s+update\b/,
  /\bdocker\s+compose\s+down\b/,
  /\bDROP\s+TABLE\b/i,
  /\bmigrate:fresh\b/,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+checkout\s+--\s/,
  /\bgit\s+clean\s+-f\b/,
  /\bkill\s+-9\b/,
  /\bpkill\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bformat\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bchmod\s+-R\s+777\b/,
]

function isDangerousCommand(code: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(code))
}

// ============================================================================
// Parser
// ============================================================================

const STEP_HEADING = /^### step:([\w-]+) +(.+)$/gm
const FENCE = "\x60\x60\x60"  // three backticks, avoids bundler template literal issues
const YAML_BLOCK_RE = new RegExp(`${FENCE}yaml\\n([\\s\\S]*?)${FENCE}`)
const CODE_BLOCK_RE = new RegExp(`${FENCE}(\\w+)\\n([\\s\\S]*?)${FENCE}`)

export function parseSteps(markdownBody: string): StepDef[] {
  const steps: StepDef[] = []
  const matches = [...markdownBody.matchAll(STEP_HEADING)]

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    const id = match[1]
    const title = match[2]
    const startIdx = match.index! + match[0].length
    const endIdx = i + 1 < matches.length ? matches[i + 1].index! : markdownBody.length
    const section = markdownBody.slice(startIdx, endIdx)

    // Parse step YAML metadata — find and remove the yaml block first
    const yamlMatch = section.match(YAML_BLOCK_RE)
    let meta: Record<string, any> = {}
    if (yamlMatch) {
      try {
        const parsed = matter(`---\n${yamlMatch[1]}---\n`)
        meta = parsed.data || {}
      } catch (e) {
        log.warn("failed to parse step YAML", { stepId: id, error: e })
      }
    }

    // Remove the yaml block, then find the code block in the remainder
    const sectionWithoutYaml = yamlMatch ? section.replace(yamlMatch[0], "") : section
    const codeMatch = sectionWithoutYaml.match(CODE_BLOCK_RE)
    const code = codeMatch ? codeMatch[2].trim() : null

    // Extract prose (everything that's not a fenced block)
    const fencePattern = new RegExp(`${FENCE}[\\s\\S]*?${FENCE}`, "g")
    let body = section
      .replace(fencePattern, "")
      .trim()

    steps.push({
      id,
      title,
      mode: meta.mode ?? "manual",
      body,
      code,
      confirm: meta.confirm === true,
      depends: meta.depends ?? null,
      retry: meta.retry ?? 0,
      delay: meta.delay ?? 0,
      condition: meta.if ?? null,
      model: meta.model ?? null,
      node: meta.node ?? null,
      skillRef: meta.skill ?? meta.playbook ?? null,
      skillArgs: meta.args != null ? String(meta.args) : null,
      workflowId: meta.workflow_id != null ? String(meta.workflow_id) : null,
      webhook: meta.webhook ?? null,
      cron: meta.cron ?? null,
      input: (meta.input && typeof meta.input === "object" && !Array.isArray(meta.input)) ? meta.input : null,
      integrations: Array.isArray(meta.integrations)
        ? meta.integrations.filter((v: unknown) => typeof v === "string")
        : typeof meta.integrations === "string"
          ? [meta.integrations]
          : [],
    })
  }

  return steps
}

export async function parsePlan(skillInfo: Skill.Info): Promise<SkillPlan> {
  const md = await ConfigMarkdown.parse(skillInfo.location)
  if (!md) throw new Error(`Failed to parse skill at ${skillInfo.location}`)

  const fm = md.data as Record<string, any>
  const version = fm.version === 2 ? 2 : 1

  // Parse args schema
  const args: Record<string, ArgDef> = {}
  if (fm.args && typeof fm.args === "object") {
    for (const [key, val] of Object.entries(fm.args)) {
      const def = val as Record<string, any>
      args[key] = {
        type: def.type ?? "string",
        required: def.required ?? false,
        default: def.default,
        enum: def.enum,
        description: def.description,
      }
    }
  }

  // Parse steps from markdown body.
  // Parse unconditionally so a mis-versioned playbook can be told apart from one
  // that genuinely has no steps; only EXPOSE them as executable steps on v2.
  const bodySteps = parseSteps(md.content)
  const steps = version === 2 ? bodySteps : []

  // Freeform vertical/industry tags — no fixed taxonomy, so accept a single string too.
  const industries = Array.isArray(fm.industries)
    ? fm.industries.filter((v: unknown) => typeof v === "string")
    : typeof fm.industries === "string"
      ? [fm.industries]
      : []

  // WHEN to reach for this playbook, as opposed to WHAT it is (#182840 / CTX-2).
  //
  // `description` says what a playbook does; a model choosing between forty of them
  // needs the situation that should make it pick this one. Weak models (gpt-4.1-nano,
  // gpt-4o-mini) route on the trigger far more reliably than on a prose summary, which
  // is the failure this field exists to fix. Same freeform shape as `industries`:
  // accept a list or a bare string, no taxonomy.
  const triggers = Array.isArray(fm.triggers)
    ? fm.triggers.filter((v: unknown) => typeof v === "string")
    : typeof fm.triggers === "string"
      ? [fm.triggers]
      : []

  return {
    name: fm.name ?? skillInfo.name,
    version,
    declaredVersion: fm.version,
    bodyStepCount: bodySteps.length,
    description: fm.description ?? skillInfo.description,
    args,
    steps,
    includes: fm.includes ?? [],
    confirm: fm.confirm ?? [],
    onError: fm["on-error"] ?? "ask",
    timeout: fm.timeout ?? 300,
    integrations: fm.integrations ?? [],
    location: skillInfo.location,
    industries,
    triggers,
  }
}

// ============================================================================
// Variable Interpolation
// ============================================================================

/**
 * Escape a string for safe inclusion in a single-quoted bash string.
 * Replaces ' with '\'' (end quote, escaped quote, start quote).
 */
export function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''")
}

// ============================================================================
// The container
// ============================================================================
//
// A playbook is a directory, not a file. PLAYBOOK.md is simply the entry point;
// the SOP prose, the screenshots it references, and the scripts its steps run
// all live beside it. That only works if there is one way to name a sibling —
// otherwise the SOP links `assets/screenshot.png` (relative to the doc) and a
// step runs `./assets/screenshot.png` (relative to wherever the CLI was
// invoked), and the two silently mean different files.
//
// So: paths inside a playbook are named relative to the container, via
// ${{playbook.root}} / ${{playbook.assets}} / ${{playbook.file}}. Never via the
// process cwd, which the author does not control.
//
// The guard below is the other half. `${{playbook.root}}/${{args.name}}` is the
// obvious thing to write, and `--name ../../../.ssh/id_rsa` is the obvious way
// to abuse it. This is not a sandbox — a shell step can `cd` anywhere it likes
// — it just makes sure a container-relative path stays inside the container it
// claims to be relative to.

export interface PlaybookPaths {
  root: string
  assets: string
  file: string
}

/** Derive the container paths from a plan's PLAYBOOK.md location. */
export function playbookPaths(location: string): PlaybookPaths {
  const root = dirname(resolvePath(location))
  return { root, assets: join(root, "assets"), file: resolvePath(location) }
}

/**
 * Resolve a path that claims to be inside `root`, refusing to leave it.
 * Absolute inputs are permitted only if they already live under root.
 */
export function resolveContainerPath(root: string, p: string): string {
  const abs = isAbsolute(p) ? resolvePath(p) : resolvePath(root, p)
  const rel = relativePath(resolvePath(root), abs)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes the playbook container: ${p}`)
  }
  return abs
}

// Where a path ends in a shell line: whitespace, quoting, redirection, or the
// end of a command. Deliberately generous — false negatives just mean we skip
// a check we could have made, false positives would break legitimate commands.
const PATH_RUN = /[^\s'"`;|&()<>]*/

/**
 * After interpolation, verify that every path built off the container root is
 * still inside it. Catches `${{playbook.root}}/${{args.file}}` where the caller
 * supplied `../../secrets`.
 */
function assertNoContainerEscape(text: string, root: string): void {
  let i = text.indexOf(root)
  while (i !== -1) {
    const tail = text.slice(i + root.length).match(PATH_RUN)?.[0] ?? ""
    if (tail.includes("..")) resolveContainerPath(root, root + tail) // throws
    i = text.indexOf(root, i + root.length)
  }
}

export interface InterpolateOptions {
  /** Escape substituted values for a single-quoted bash string. */
  shellSafe?: boolean
  /** Absolute path to the playbook container, enabling ${{playbook.*}}. */
  root?: string
}

export function interpolate(
  template: string,
  args: Record<string, unknown>,
  stepResults: Record<string, StepResult>,
  options: boolean | InterpolateOptions = {},
): string {
  // 4th param used to be a bare `shellSafe` boolean; keep those callers working.
  const opts: InterpolateOptions = typeof options === "boolean" ? { shellSafe: options } : options
  const escape = opts.shellSafe ? shellEscape : (s: string) => s
  const paths = opts.root ? { root: opts.root, assets: join(opts.root, "assets"), file: "" } : null

  const out = template.replace(/\$\{\{(\s*[\w.\-]+\s*)\}\}/g, (_match, expr: string) => {
    const path = expr.trim().split(".")
    if (path[0] === "args" && path.length === 2) {
      return escape(String(args[path[1]] ?? ""))
    }
    if (path[0] === "steps" && path.length === 3) {
      const stepId = path[1]
      const field = path[2]
      const sr = stepResults[stepId]
      if (!sr) return ""
      if (field === "output") return sr.output
      if (field === "exit_code") return String(sr.exit_code ?? "")
      return ""
    }
    if (path[0] === "env" && path.length === 2) {
      return process.env[path[1]] ?? ""
    }
    // Container paths are ours, not user input — never shell-escaped away.
    if (path[0] === "playbook" && path.length === 2 && paths) {
      if (path[1] === "root") return paths.root
      if (path[1] === "assets") return paths.assets
      if (path[1] === "file") return paths.file || join(paths.root, "PLAYBOOK.md")
      return ""
    }
    return ""
  })
    .replace(/\$ARGUMENTS/g, escape(String(args._raw ?? "")))

  if (opts.root) assertNoContainerEscape(out, opts.root)
  return out
}

/**
 * Interpolate the string-valued fields of a step's YAML HEADER.
 *
 * The step BODY and code have always been interpolated, which is exactly what made this gap
 * hard to see: `${target}` worked three lines below a `node: ${target}` that did not. The
 * header value reached the node resolver as the literal string "${target}", and every hive
 * playbook was therefore pinned to one machine at authoring time — no fleet reuse, no
 * failover, no "run this where the case data happens to live" (#182415).
 *
 * Returns a COPY. Steps are reused across retries, and mutating one would bake the first
 * run's values in.
 *
 * Only fields that name a runtime target are interpolated. `mode`, `id` and `depends` are
 * structural — resolving them from arguments would let an argument change the shape of the
 * plan that was validated.
 */
export function interpolateStepHeaders(
  step: StepDef,
  args: Record<string, any>,
  stepResults: Record<string, StepResult>,
  root?: string,
): StepDef {
  const FIELDS = ["node", "model", "skillArgs", "workflowId", "webhook", "cron"] as const
  const out: StepDef = { ...step }

  for (const f of FIELDS) {
    const v = out[f]
    // Absence stays absence. Interpolating null would produce the string "null", which
    // reads downstream as a value someone chose.
    if (typeof v !== "string" || v === "") continue
    if (!v.includes("${")) continue
    try {
      const resolved = interpolate(v, args, stepResults, { root })
      // interpolate() resolves an UNKNOWN name to "". For a body that is harmless; for a
      // header it is not. An empty `node:` reads downstream as "no node given" and
      // dispatches to ANY machine — silently doing the opposite of what naming a node asks
      // for. So a reference that resolves to nothing leaves the header AS WRITTEN, and the
      // resolver then fails loudly with the unmatched name.
      if (resolved.trim() !== "") out[f] = resolved as any
    } catch {
      // Same reasoning for a thrown reference: keep what the author wrote.
    }
  }

  return out
}

/**
 * Recursively interpolate ${{}} variables inside an input object.
 * Unlike JSON.stringify→interpolate→JSON.parse, this is safe when
 * interpolated values contain JSON-special characters (quotes, backslashes).
 */
export function interpolateInput(
  obj: Record<string, any>,
  args: Record<string, unknown>,
  stepResults: Record<string, StepResult>,
  root?: string,
): Record<string, any> {
  const walk = (val: unknown): unknown => {
    if (typeof val === "string") return interpolate(val, args, stepResults, { root })
    if (Array.isArray(val)) return val.map(walk)
    if (val !== null && typeof val === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(val)) out[k] = walk(v)
      return out
    }
    return val // numbers, booleans, null pass through
  }
  return walk(obj) as Record<string, any>
}

// ============================================================================
// Condition Evaluation (simple expression parser)
// ============================================================================

function evaluateCondition(
  condition: string,
  args: Record<string, unknown>,
  stepResults: Record<string, StepResult>,
  root?: string,
): boolean {
  // Interpolate variables first
  const interpolated = interpolate(condition, args, stepResults, { root })

  // Simple != and == checks
  const neqMatch = interpolated.match(/^\s*(.+?)\s*!=\s*(.+?)\s*$/)
  if (neqMatch) return neqMatch[1].trim() !== neqMatch[2].trim()

  const eqMatch = interpolated.match(/^\s*(.+?)\s*==\s*(.+?)\s*$/)
  if (eqMatch) return eqMatch[1].trim() === eqMatch[2].trim()

  // Truthy check
  const val = interpolated.trim()
  return val !== "" && val !== "0" && val !== "false" && val !== "null"
}

// ============================================================================
// Argument Validation + Resolution
// ============================================================================

/**
 * Split raw CLI argv into flag args and positionals for a playbook run (#181577).
 *
 * Lives here, beside resolveArgs, because it was ORIGINALLY inlined at each call site and
 * only one of them got fixed. `iris playbook run` learned to bind a bare `key=value`;
 * `iris loop` kept its own copy — under a comment reading "same shape as `playbook run`" —
 * and kept the defect. Two copies of a parsing rule drift, and this one drifted silently.
 *
 * THE DEFECT: only `--key=value` bound to a named arg. A bare `key=value` fell through to
 * the positional list, and resolveArgs assigned the WHOLE string, prefix included, to the
 * first declared arg:
 *
 *   iris playbook run freelabel-ads topic="AI agents" brand=freelabel
 *   -> { topic: "topic=AI agents", brand: "brand=freelabel" }
 *
 * Nothing reports it. The steps still run and an AI step shrugs off a stray "topic=" prefix,
 * so it only surfaces where a value is used for an EXACT lookup — a brand slug — failing
 * several steps from the cause, after two AI steps have already spent tokens on a wrong
 * prompt.
 *
 * `declared` is what makes it safe: binding is guarded on the declared arg name, so a
 * positional that legitimately contains "=" stays a positional.
 */
export function splitPlaybookArgv(
  argv: string[],
  declaredArgs: Record<string, unknown> | undefined,
): { flagArgs: Record<string, unknown>; positional: string[] } {
  const flagArgs: Record<string, unknown> = {}
  const positional: string[] = []
  const declared = new Set(Object.keys(declaredArgs ?? {}))

  for (const a of argv) {
    if (a.startsWith("--")) {
      const eqIdx = a.indexOf("=")
      if (eqIdx > 2) {
        flagArgs[a.slice(2, eqIdx)] = a.slice(eqIdx + 1)
      } else {
        flagArgs[a.slice(2)] = true
      }
      continue
    }

    const eq = a.indexOf("=")
    if (eq > 0 && declared.has(a.slice(0, eq))) {
      flagArgs[a.slice(0, eq)] = a.slice(eq + 1)
      continue
    }

    positional.push(a)
  }

  return { flagArgs, positional }
}

export function resolveArgs(
  schema: Record<string, ArgDef>,
  positionalArgs: string[],
  flagArgs: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const requiredKeys = Object.entries(schema)
    .filter(([, def]) => def.required)
    .map(([k]) => k)
  const allKeys = Object.keys(schema)

  // Fill positional args in schema order
  let posIdx = 0
  for (const key of allKeys) {
    if (flagArgs[key] !== undefined) {
      result[key] = flagArgs[key]
    } else if (posIdx < positionalArgs.length) {
      result[key] = positionalArgs[posIdx++]
    } else if (schema[key].default !== undefined) {
      result[key] = schema[key].default
    }
  }

  // Type coercion
  for (const [key, def] of Object.entries(schema)) {
    if (result[key] === undefined) continue
    if (def.type === "number") result[key] = Number(result[key])
    if (def.type === "boolean") result[key] = result[key] === true || result[key] === "true"
  }

  // Validation
  const errors: string[] = []
  for (const key of requiredKeys) {
    if (result[key] === undefined || result[key] === "") {
      errors.push(`Missing required argument: ${key}`)
    }
  }
  for (const [key, def] of Object.entries(schema)) {
    if (result[key] !== undefined && def.enum && !def.enum.includes(String(result[key]))) {
      errors.push(`Invalid value for "${key}": ${result[key]}. Must be one of: ${def.enum.join(", ")}`)
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"))
  }

  return result
}

// ============================================================================
// Checkpoint Management
// ============================================================================

export interface Checkpoint {
  run_id: string
  skill: string
  args: Record<string, unknown>
  started_at: string
  updated_at: string
  status: "running" | "interrupted" | "completed" | "failed" | "paused"
  current_step: string | null
  steps: Record<string, StepResult>
}

function saveCheckpoint(cp: Checkpoint) {
  ensureRunsDir()
  writeCheckpointFile(join(RUNS_DIR, `${cp.run_id}.json`), JSON.stringify(cp, null, 2))
}

function loadCheckpoint(runId: string): Checkpoint | null {
  const path = join(RUNS_DIR, `${runId}.json`)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, "utf-8"))
}

function findLatestCheckpoint(skillName: string): Checkpoint | null {
  ensureRunsDir()
  const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"))
  let latest: Checkpoint | null = null
  let latestTime = 0

  for (const f of files) {
    try {
      const cp = JSON.parse(readFileSync(join(RUNS_DIR, f), "utf-8")) as Checkpoint
      if (cp.skill === skillName) {
        const t = new Date(cp.updated_at).getTime()
        if (t > latestTime) {
          latestTime = t
          latest = cp
        }
      }
    } catch {}
  }

  return latest
}

export function listRuns(limit = 20): Checkpoint[] {
  ensureRunsDir()
  const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"))
  const runs: Checkpoint[] = []

  for (const f of files) {
    try {
      runs.push(JSON.parse(readFileSync(join(RUNS_DIR, f), "utf-8")))
    } catch {}
  }

  return runs
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, limit)
}

export function getRun(runId: string): Checkpoint | null {
  return loadCheckpoint(runId)
}

export function pruneRuns(maxAgeDays: number): number {
  ensureRunsDir()
  const cutoff = Date.now() - maxAgeDays * 86_400_000
  const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"))
  let pruned = 0

  for (const f of files) {
    try {
      const cp = JSON.parse(readFileSync(join(RUNS_DIR, f), "utf-8")) as Checkpoint
      if (new Date(cp.updated_at).getTime() < cutoff) {
        unlinkSync(join(RUNS_DIR, f))
        pruned++
      }
    } catch {}
  }

  return pruned
}

// ============================================================================
// Step Executors
// ============================================================================

async function executeShell(code: string, timeoutMs: number): Promise<{ output: string; exit_code: number }> {
  try {
    const proc = Bun.spawn(["bash", "-c", code], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })

    const timeoutId = setTimeout(() => proc.kill(), timeoutMs)
    const exitCode = await proc.exited
    clearTimeout(timeoutId)

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const output = (stdout + (stderr ? "\n" + stderr : "")).trim()

    return { output, exit_code: exitCode }
  } catch (e: any) {
    return { output: `Shell error: ${e.message}`, exit_code: 1 }
  }
}

/**
 * Normalise a playbook's model name for the platform proxy.
 *
 * The proxy namespaces everything under `iris/` and 404s a bare vendor name —
 * `gpt-4o-mini` is not found, `iris/gpt-4o-mini` is. Every playbook in the tree
 * declares the bare form (11 steps on gpt-4o-mini, 6 on gpt-4.1-nano), so
 * normalising here is what lets them run unchanged.
 */
/**
 * Strip a reasoning model's thinking block, leaving only the answer.
 *
 * minimax-m3 and friends wrap their deliberation in <think>...</think>. Downstream steps are
 * fed the previous step's output as context, so leaving the reasoning in doubles the context
 * with text the next step should not treat as findings.
 *
 * An UNCLOSED block means the model ran out of tokens mid-thought and never answered — return
 * empty so the caller can fail the step rather than pass an answer that does not exist.
 */
function stripReasoning(text: string): string {
  if (!text.includes("<think>")) return text
  const close = text.lastIndexOf("</think>")
  if (close === -1) return ""
  return text.slice(close + "</think>".length).trim()
}
function platformModelName(model: string): string {
  return model.includes("/") ? model : `iris/${model}`
}

/** Ask the platform proxy. Returns null when the proxy itself is unusable. */
async function generateViaPlatform(
  model: string,
  prompt: string,
): Promise<{ text: string } | { error: string } | null> {
  try {
    const { irisFetch, IRIS_API } = await import("../cli/cmd/iris-api")
    const res = await irisFetch(
      `/api/v6/openai/chat/completions`,
      {
        method: "POST",
        body: JSON.stringify({
          model: platformModelName(model),
          // 2000 was too small for a reasoning model. minimax-m3 emits a <think> block
          // before its answer, and on 2026-08-28 every step of `the-algorithm` spent the
          // ENTIRE budget thinking: </think> closed at char 8586 of 8596 and the answer was
          // cut off immediately after. The run reported "7 passed" having produced no
          // answers at all — the reasoning was good and none of it survived the cap.
          max_tokens: 8000,
          // THE fix for reasoning models, and the reason raising max_tokens alone did not
          // work. Without it they deliberate until the budget runs out and never answer —
          // and you are billed for every one of those reasoning tokens. Measured on
          // iris/glm-5.3-flash with an identical prompt:
          //
          //   default                reasoning 18566   content    0   EMPTY
          //   reasoning_effort=low   reasoning   336   content 4867   ANSWERS
          //
          // 55x less reasoning AND a full answer. It is not model-specific: it also
          // rescued hy3 (0 -> 1908 content), which had been unusable at every cap, and
          // costs nothing on models that do not reason (minimax-m3 answers either way).
          //
          // Skill steps want a considered answer, not a visible chain of thought. "low"
          // is the right default here; a step that genuinely needs deep reasoning should
          // ask for a model that reasons rather than paying for tokens it throws away.
          reasoning_effort: "low",
          messages: [{ role: "user", content: prompt }],
        }),
      },
      IRIS_API,
    )
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200)
      // 401/403 means "not signed in here", which the direct rail may still cover.
      if (res.status === 401 || res.status === 403) return null
      return { error: `platform model proxy HTTP ${res.status}: ${body}` }
    }
    const j = (await res.json()) as any
    const choice = j?.choices?.[0] ?? {}
    const raw = choice?.message?.content
    // Reasoning models split the reply in two different ways and BOTH can leave `content`
    // empty. Name which one happened — "empty reply" sent three separate investigations down
    // the wrong path on 2026-08-28.
    //   inline:   minimax-m3 emits <think>…</think> inside content
    //   sidecar:  hy3 puts deliberation in message.reasoning_content and leaves content ""
    const reasoning = String(choice?.message?.reasoning_content ?? "")
    const finish = String(choice?.finish_reason ?? "")
    const answer = typeof raw === "string" ? stripReasoning(raw) : ""

    if (answer.trim()) return { text: answer }

    // No answer. Say precisely why, because the three causes need three different actions.
    if (finish === "length") {
      const spent = reasoning.length
        ? `${reasoning.length} characters of reasoning and none of answer`
        : "the entire budget"
      return {
        error:
          `the model hit its output limit having produced ${spent} (finish_reason=length). ` +
          `Raising max_tokens does NOT reliably help: measured on iris/hy3, 2000 -> 8000 tokens ` +
          `grew reasoning from 10k to 38k characters and still returned no answer. ` +
          `Use a model that answers before it runs out — iris/minimax-m3 completes this playbook.`,
      }
    }
    if (reasoning.trim()) {
      return {
        error:
          "the model returned reasoning but no answer (message.content was empty while " +
          "reasoning_content was not). This model deliberates into a separate field and never " +
          "committed to a reply; pick a different model for this step.",
      }
    }
    if (typeof raw !== "string") return { error: "platform model proxy returned no content field" }
    return { error: "platform model proxy returned an empty reply" }
  } catch (e: any) {
    return null
  }
}

/**
 * Run a playbook's `mode: prompt` step.
 *
 * THE PLATFORM PROXY IS THE DEFAULT RAIL (#181926). This used to go straight to
 * @ai-sdk/openai, which reads OPENAI_API_KEY from the local environment — so every
 * AI step in every playbook only ran on a machine that already had a vendor key.
 * That is fine for the person who wrote the playbooks and fatal for the products
 * built on them: a firm could install the CLI, authenticate, run `iris lexicon
 * demand 123`, and be told to set OPENAI_API_KEY — a credential the product never
 * said they needed and should not need, since their IRIS auth already pays for
 * model access. `iris mint scan` was already using the proxy; playbooks were not.
 *
 * The direct rail is kept as a FALLBACK rather than deleted, so nobody who relies
 * on their own key today loses anything, and IRIS_AI_DIRECT=1 forces it. When both
 * are unavailable the error names both, because "OpenAI API key is missing" sent
 * people looking for the wrong fix.
 */
async function executeAi(
  prompt: string,
  model: string,
  context: string,
): Promise<{ output: string; exit_code: number }> {
  const fullPrompt = context ? `Context from previous steps:\n${context}\n\n${prompt}` : prompt
  const forceDirect = process.env.IRIS_AI_DIRECT === "1"
  let platformNote = "not attempted (IRIS_AI_DIRECT=1)"

  if (!forceDirect) {
    const viaPlatform = await generateViaPlatform(model, fullPrompt)
    if (viaPlatform && "text" in viaPlatform) return { output: viaPlatform.text, exit_code: 0 }
    platformNote = viaPlatform ? viaPlatform.error : "unreachable or not signed in"
  }

  // Direct vendor SDK — only worth trying if a key actually exists, otherwise the
  // SDK's own "API key is missing" buries the platform reason above.
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY)
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY)
  const wantsAnthropic = model.startsWith("claude-")
  if ((wantsAnthropic && hasAnthropic) || (!wantsAnthropic && hasOpenAi)) {
    try {
      const { generateText } = await import("ai")
      let provider: any
      if (wantsAnthropic) {
        const { anthropic } = await import("@ai-sdk/anthropic")
        provider = anthropic(model)
      } else {
        const { openai } = await import("@ai-sdk/openai")
        // Strip the proxy namespace — the vendor SDK has never heard of `iris/`.
        provider = openai(model.replace(/^iris\//, ""))
      }
      // See the max_tokens note on the platform rail above — a reasoning model can spend the
      // whole budget inside <think> and never reach its answer.
      const result = await generateText({ model: provider, prompt: fullPrompt, maxOutputTokens: 8000 })
      return { output: result.text, exit_code: 0 }
    } catch (e: any) {
      return { output: `AI error: platform proxy — ${platformNote}; local key — ${e.message}`, exit_code: 1 }
    }
  }

  return {
    output:
      `AI error: no model rail available for "${model}".\n` +
      `  platform proxy: ${platformNote}\n` +
      `  local key: ${wantsAnthropic ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} not set\n` +
      `  Fix: run \`iris auth login\` so the platform proxy can be used, or set a vendor key for the direct rail.`,
    exit_code: 1,
  }
}

async function executeHive(
  code: string,
  plan: SkillPlan,
  step: StepDef,
  userId: number,
): Promise<{ output: string; exit_code: number }> {
  try {
    // Dynamic import to avoid hard dependency
    const { hiveFetch } = await import("../cli/cmd/platform-hive-nodes")

    const payload: Record<string, unknown> = {
      user_id: userId,
      title: `skill:${plan.name}/${step.id}`,
      type: "sandbox_execute",
      prompt: `#!/bin/bash\nset -e\n${code}`,
      config: { timeout_seconds: plan.timeout },
      timeout_seconds: plan.timeout,
    }
    // Only send node_id if it's a real UUID — "default" breaks FK constraint
    // RESOLVE the node name to its id. This passed `step.node` straight through as `node_id`,
    // but a playbook names a node the way a person does — `node: MacBookPro` — while the API
    // expects a uuid. Every hive step that NAMED a machine got HTTP 500, and omitting `node:`
    // worked, so the mode looked functional while its whole purpose — "run it where the data
    // is" — was broken. Measured: `mode: hive-script` with `node: AlexMaysnow1063` -> 500;
    // the identical step without `node:` -> passes in 3.0s.
    //
    // Same name-vs-identity confusion as #182368, one layer up.
    if (step.node && step.node !== "default") {
      const { resolveNode } = await import("../cli/cmd/platform-hive-nodes")
      const resolved = await resolveNode(userId, step.node)
      if (!resolved) {
        return {
          output: `Step ${step.id}: no Hive node matching "${step.node}". Run: iris hive nodes list`,
          exit_code: 1,
        }
      }
      payload.node_id = resolved.id
    }

    const createRes = await hiveFetch("/api/v6/nodes/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })

    if (!createRes.ok) {
      return { output: `Hive dispatch failed: ${createRes.status} ${await createRes.text()}`, exit_code: 1 }
    }

    const created = (await createRes.json()) as { task: { id: string; status: string } }
    const taskId = created.task.id

    // Poll for completion
    const deadline = Date.now() + (plan.timeout + 30) * 1000
    const terminal = new Set(["succeeded", "completed", "failed", "cancelled", "timeout", "errored"])

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000))
      const r = await hiveFetch(`/api/v6/nodes/tasks/${taskId}?user_id=${userId}`)
      if (!r.ok) continue
      const body = (await r.json()) as { task: any }
      const t = body.task
      if (terminal.has(t.status)) {
        const result = t.result ?? {}
        const output = result.output ?? result.stdout ?? ""
        const exitCode = t.status === "succeeded" || t.status === "completed" ? 0 : 1
        return { output, exit_code: exitCode }
      }
    }

    return { output: `Hive task ${taskId} timed out`, exit_code: 124 }
  } catch (e: any) {
    return { output: `Hive error: ${e.message}`, exit_code: 1 }
  }
}

// ============================================================================
// Standardized Error Format (all remote modes use this)
// ============================================================================

function formatModeError(mode: string, stepId: string, status: number, body: string): string {
  return `[Step: ${stepId}] FAILED: ${mode} returned HTTP ${status} — ${body.slice(0, 500)}`
}

// ============================================================================
// hive-script: Node.js script using IRIS SDK, dispatched to Hive node
// ============================================================================

async function executeHiveScript(
  code: string,
  plan: SkillPlan,
  step: StepDef,
  userId: number,
): Promise<{ output: string; exit_code: number }> {
  try {
    const { hiveFetch } = await import("../cli/cmd/platform-hive-nodes")

    // Wrap JS code: prepend SDK require path so scripts can use require('./iris-sdk')
    // The daemon also wraps with process.chdir() — this ensures the prompt field is clean JS.
    const wrappedCode = code

    const payload: Record<string, unknown> = {
      user_id: userId,
      title: `playbook:${plan.name}/${step.id}`,
      type: "hive_script",
      prompt: wrappedCode,
      config: { timeout_seconds: plan.timeout },
      timeout_seconds: plan.timeout,
    }
    // RESOLVE the node name to its id. This passed `step.node` straight through as `node_id`,
    // but a playbook names a node the way a person does — `node: MacBookPro` — while the API
    // expects a uuid. Every hive step that NAMED a machine got HTTP 500, and omitting `node:`
    // worked, so the mode looked functional while its whole purpose — "run it where the data
    // is" — was broken. Measured: `mode: hive-script` with `node: AlexMaysnow1063` -> 500;
    // the identical step without `node:` -> passes in 3.0s.
    //
    // Same name-vs-identity confusion as #182368, one layer up.
    if (step.node && step.node !== "default") {
      const { resolveNode } = await import("../cli/cmd/platform-hive-nodes")
      const resolved = await resolveNode(userId, step.node)
      if (!resolved) {
        return {
          output: `Step ${step.id}: no Hive node matching "${step.node}". Run: iris hive nodes list`,
          exit_code: 1,
        }
      }
      payload.node_id = resolved.id
    }

    const createRes = await hiveFetch("/api/v6/nodes/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })

    if (!createRes.ok) {
      const body = await createRes.text()
      return { output: `Hive script dispatch failed: ${createRes.status} ${body}`, exit_code: 1 }
    }

    const created = (await createRes.json()) as { task: { id: string; status: string } }
    const taskId = created.task.id
    const deadline = Date.now() + (plan.timeout + 30) * 1000
    const terminal = new Set(["succeeded", "completed", "failed", "cancelled", "timeout", "errored"])

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000))
      const r = await hiveFetch(`/api/v6/nodes/tasks/${taskId}?user_id=${userId}`)
      if (!r.ok) continue
      const body = (await r.json()) as { task: any }
      const t = body.task
      if (terminal.has(t.status)) {
        const result = t.result ?? {}
        const output = result.output ?? result.stdout ?? ""
        return { output, exit_code: t.status === "succeeded" || t.status === "completed" ? 0 : 1 }
      }
    }

    return { output: `Hive script task ${taskId} timed out`, exit_code: 124 }
  } catch (e: any) {
    return { output: `Hive script error: ${e.message}`, exit_code: 1 }
  }
}

// ============================================================================
// cloud-workflow / cloud-agentic: v6 engine on iris-api
// ============================================================================

async function executeCloudWorkflow(
  body: string,
  step: StepDef,
  userId: number,
  agentic: boolean,
  timeoutMs: number,
): Promise<{ output: string; exit_code: number }> {
  try {
    const { irisFetch, IRIS_API } = await import("../cli/cmd/iris-api")

    if (!step.workflowId) {
      return { output: `[Step: ${step.id}] FAILED: cloud-workflow requires workflow_id`, exit_code: 1 }
    }

    const endpoint = agentic
      ? `/api/v6/workspace/workflows/${step.workflowId}/execute-agentic`
      : `/api/v6/workspace/workflows/${step.workflowId}/execute`

    const payload: Record<string, any> = { user_id: userId }
    if (body) payload.goal = body
    if (step.input) Object.assign(payload, step.input)

    const res = await irisFetch(endpoint, {
      method: "POST",
      body: JSON.stringify(payload),
    }, IRIS_API)

    if (!res.ok) {
      const errBody = await res.text()
      return { output: formatModeError(agentic ? "cloud-agentic" : "cloud-workflow", step.id, res.status, errBody), exit_code: 1 }
    }

    const data = await res.json() as any
    const executionId = data.execution_id ?? data.workflow_execution_id ?? data.id

    // If already complete, return immediately
    if (data.status === "completed" || data.status === "success") {
      return { output: JSON.stringify(data.result ?? data), exit_code: 0 }
    }

    // Poll for async result
    if (executionId) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000))
        const pollRes = await irisFetch(`/api/v6/workspace/${step.workflowId}/result`, {}, IRIS_API)
        if (!pollRes.ok) continue
        const pollData = await pollRes.json() as any
        if (pollData.status === "completed" || pollData.status === "success" || pollData.status === "failed") {
          const exitCode = pollData.status === "failed" ? 1 : 0
          return { output: JSON.stringify(pollData.result ?? pollData), exit_code: exitCode }
        }
      }
      return { output: `[Step: ${step.id}] FAILED: cloud-workflow timed out (execution: ${executionId})`, exit_code: 124 }
    }

    // Synchronous response
    return { output: JSON.stringify(data.result ?? data), exit_code: 0 }
  } catch (e: any) {
    return { output: `[Step: ${step.id}] FAILED: cloud-workflow error — ${e.message}`, exit_code: 1 }
  }
}

// ============================================================================
// n8n: webhook trigger or workflow API execution
// ============================================================================

async function executeN8n(
  body: string,
  step: StepDef,
  timeoutMs: number,
): Promise<{ output: string; exit_code: number }> {
  try {
    const n8nUrl = (process.env.N8N_URL ?? "https://fl-n8n-production.up.railway.app").replace(/\/$/, "")

    let url: string
    let headers: Record<string, string> = { "Content-Type": "application/json" }

    if (step.webhook) {
      // Webhook mode — no auth needed (webhooks are public in n8n)
      url = `${n8nUrl}${step.webhook}`
    } else if (step.workflowId) {
      // API mode — requires N8N_API_KEY
      const apiKey = process.env.N8N_API_KEY
      if (!apiKey) {
        return { output: `[Step: ${step.id}] FAILED: n8n API mode requires N8N_API_KEY env var`, exit_code: 1 }
      }
      url = `${n8nUrl}/api/v1/workflows/${step.workflowId}/run`
      headers["X-N8N-API-KEY"] = apiKey
    } else {
      return { output: `[Step: ${step.id}] FAILED: n8n step requires webhook or workflow_id`, exit_code: 1 }
    }

    const payload = step.input ?? (body ? { query: body } : {})
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!res.ok) {
      const errBody = await res.text()
      return { output: formatModeError("n8n", step.id, res.status, errBody), exit_code: 1 }
    }

    const data = await res.json()
    return { output: JSON.stringify(data), exit_code: 0 }
  } catch (e: any) {
    return { output: `[Step: ${step.id}] FAILED: n8n error — ${e.message}`, exit_code: 1 }
  }
}

// ============================================================================
// langgraph: Python AI graphs via FastAPI
// ============================================================================

async function executeLanggraph(
  body: string,
  step: StepDef,
  timeoutMs: number,
): Promise<{ output: string; exit_code: number }> {
  try {
    const lgUrl = (process.env.LANGGRAPH_API_URL ?? "http://localhost:8001").replace(/\/$/, "")

    const payload: Record<string, any> = {
      workflow_id: step.workflowId ?? "basic_workflow",
      input_data: step.input ?? { query: body },
    }
    if (step.model) payload.model = step.model

    const res = await fetch(`${lgUrl}/execute-workflow`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!res.ok) {
      const errBody = await res.text()
      return { output: formatModeError("langgraph", step.id, res.status, errBody), exit_code: 1 }
    }

    const data = await res.json() as any
    const executionId = data.execution_id

    // If already complete
    if (data.status === "success" || data.status === "completed") {
      return { output: data.result?.ai_response ?? JSON.stringify(data.result ?? data), exit_code: 0 }
    }
    if (data.status === "error") {
      return { output: `[Step: ${step.id}] FAILED: langgraph error — ${data.error ?? JSON.stringify(data)}`, exit_code: 1 }
    }

    // Poll for async result
    if (executionId) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000))
        const pollRes = await fetch(`${lgUrl}/workflow/${executionId}`, {
          signal: AbortSignal.timeout(10000),
        })
        if (!pollRes.ok) continue
        const pollData = await pollRes.json() as any
        if (pollData.status === "success" || pollData.status === "completed") {
          return { output: pollData.result?.ai_response ?? JSON.stringify(pollData.result ?? pollData), exit_code: 0 }
        }
        if (pollData.status === "error") {
          return { output: `[Step: ${step.id}] FAILED: langgraph — ${pollData.error}`, exit_code: 1 }
        }
      }
      return { output: `[Step: ${step.id}] FAILED: langgraph timed out (execution: ${executionId})`, exit_code: 124 }
    }

    return { output: data.result?.ai_response ?? JSON.stringify(data), exit_code: 0 }
  } catch (e: any) {
    return { output: `[Step: ${step.id}] FAILED: langgraph error — ${e.message}`, exit_code: 1 }
  }
}

// ============================================================================
// schedule: create a recurring cron trigger in bloq_scheduled_jobs
// ============================================================================

async function executeSchedule(
  body: string,
  step: StepDef,
  plan: SkillPlan,
): Promise<{ output: string; exit_code: number }> {
  try {
    const { irisFetch, IRIS_API } = await import("../cli/cmd/iris-api")
    const { resolveUserId } = await import("../cli/cmd/iris-api")
    const userId = await resolveUserId()
    if (!userId) {
      return { output: `[Step: ${step.id}] FAILED: not authenticated`, exit_code: 1 }
    }

    if (!step.cron) {
      return { output: `[Step: ${step.id}] FAILED: schedule step requires cron expression`, exit_code: 1 }
    }

    const playbook = step.skillRef ?? plan.name
    const payload = {
      user_id: userId,
      task_name: "hive_task_dispatch",
      frequency: "custom",
      prompt: `playbook:${playbook}`,
      data: {
        type: "hive_task_dispatch",
        task_type: "playbook_run",
        prompt: playbook,
        args: step.input ?? {},
        cron: step.cron,
      },
    }

    const res = await irisFetch("/api/v1/campaign-templates", {
      method: "POST",
      body: JSON.stringify(payload),
    }, IRIS_API)

    if (!res.ok) {
      const errBody = await res.text()
      return { output: formatModeError("schedule", step.id, res.status, errBody), exit_code: 1 }
    }

    const data = await res.json() as any
    const scheduleId = data.id ?? data.data?.id ?? "unknown"
    return {
      output: `Scheduled "${playbook}" with cron "${step.cron}" (ID: ${scheduleId})`,
      exit_code: 0,
    }
  } catch (e: any) {
    return { output: `[Step: ${step.id}] FAILED: schedule error — ${e.message}`, exit_code: 1 }
  }
}

// ============================================================================
// Main Executor
// ============================================================================

export interface ExecuteOptions {
  dryRun?: boolean
  yes?: boolean
  verbose?: boolean
  resume?: boolean
  stepFilter?: string
  onConfirm?: (stepId: string, command: string) => Promise<boolean>
  onStepStart?: (step: StepDef) => void
  onStepEnd?: (step: StepDef, result: StepResult) => void
  onManualPrompt?: (step: StepDef) => Promise<boolean>
  /**
   * Resume a specific paused run by id, reusing its run_id and completed steps.
   * Takes precedence over `resume` (which only finds the latest run by skill name).
   */
  resumeRunId?: string
  /**
   * How to settle the step a run paused on, when resuming by run id.
   * "done" (default) marks it success; "skip" marks it skipped, so dependent steps
   * are skipped too rather than running on work that never happened.
   */
  resolvePaused?: "done" | "skip"
}

export async function executeSkill(
  plan: SkillPlan,
  rawArgs: Record<string, unknown>,
  opts: ExecuteOptions = {},
  _depth = 0,
): Promise<SkillResult> {
  if (_depth > 3) {
    throw new Error("Maximum skill nesting depth (3) exceeded")
  }

  const now = new Date().toISOString()
  const stepResults: Record<string, StepResult> = {}

  // Load checkpoint if resuming
  let resumeCheckpoint: Checkpoint | null = null
  if (opts.resumeRunId) {
    // Resume a specific run — reuses its id so the run has one continuous history
    resumeCheckpoint = loadCheckpoint(opts.resumeRunId)
    if (!resumeCheckpoint) throw new Error(`Run "${opts.resumeRunId}" not found`)
    if (resumeCheckpoint.skill !== plan.name) {
      throw new Error(`Run "${opts.resumeRunId}" belongs to skill "${resumeCheckpoint.skill}", not "${plan.name}"`)
    }
  } else if (opts.resume) {
    resumeCheckpoint = findLatestCheckpoint(plan.name)
  }

  // Steps carried over from a previous run — never re-executed on resume.
  const restoredIds = new Set<string>()

  if (resumeCheckpoint) {
    for (const [id, sr] of Object.entries(resumeCheckpoint.steps)) {
      if (sr.status === "success") {
        stepResults[id] = sr
        restoredIds.add(id)
      } else if (sr.status === "paused" && opts.resumeRunId) {
        // Explicitly resuming a run IS the human's answer for the step it paused on.
        // Without this the step would re-pause immediately and the run could never finish.
        const skipped = opts.resolvePaused === "skip"
        stepResults[id] = {
          ...sr,
          status: skipped ? "skipped" : "success",
          output: skipped ? "Human skipped step on resume" : "Human confirmed done on resume",
          exit_code: skipped ? 1 : 0,
        }
        restoredIds.add(id)
      }
    }
  }

  // A resumed run keeps its original id and start time; a fresh run gets new ones.
  const runId = opts.resumeRunId ? resumeCheckpoint!.run_id : generateRunId()
  const startedAt = opts.resumeRunId ? resumeCheckpoint!.started_at : now

  // Initialize checkpoint
  const checkpoint: Checkpoint = {
    run_id: runId,
    skill: plan.name,
    args: rawArgs,
    started_at: startedAt,
    updated_at: now,
    status: "running",
    current_step: null,
    steps: { ...stepResults },
  }

  // Build step execution order (resolve depends)
  let stepsToRun = plan.steps
  if (opts.stepFilter) {
    stepsToRun = plan.steps.filter((s) => s.id === opts.stepFilter)
    if (stepsToRun.length === 0) {
      throw new Error(`Step "${opts.stepFilter}" not found. Available: ${plan.steps.map((s) => s.id).join(", ")}`)
    }
  }

  let finalStatus: "completed" | "failed" | "interrupted" | "paused" = "completed"
  let pausedOn: SkillResult["paused_on"] | undefined

  // The container every ${{playbook.*}} in this run resolves against.
  const root = plan.location ? playbookPaths(plan.location).root : undefined

  for (const step of stepsToRun) {
    // Skip steps already settled by a previous run (resume mode)
    if (restoredIds.has(step.id) || stepResults[step.id]?.status === "success") continue

    // Check depends
    if (step.depends) {
      const depResult = stepResults[step.depends]
      if (!depResult || depResult.status !== "success") {
        stepResults[step.id] = {
          id: step.id, status: "skipped", output: `Dependency "${step.depends}" not met`,
          exit_code: null, duration_ms: 0, attempts: 0,
        }
        opts.onStepEnd?.(step, stepResults[step.id])
        continue
      }
    }

    // Check condition
    if (step.condition) {
      if (!evaluateCondition(step.condition, rawArgs, stepResults, root)) {
        stepResults[step.id] = {
          id: step.id, status: "skipped", output: `Condition not met: ${step.condition}`,
          exit_code: null, duration_ms: 0, attempts: 0,
        }
        opts.onStepEnd?.(step, stepResults[step.id])
        continue
      }
    }

    checkpoint.current_step = step.id
    opts.onStepStart?.(step)

    // Interpolate code and body
    // Shell mode uses shellSafe=true to escape args (prevents injection from CLI-supplied values)
    const isShell = step.mode === "shell"
    let interpolatedCode: string | null
    let interpolatedBody: string
    // The step with its HEADER fields resolved. `step` itself is const and reused across
    // retries, so the interpolated form is a copy bound here and used from this point on.
    let stepH: StepDef = step
    try {
      interpolatedCode = step.code
        ? interpolate(step.code, rawArgs, stepResults, { shellSafe: isShell, root })
        : null
      interpolatedBody = interpolate(step.body, rawArgs, stepResults, { root })
      // The HEADER too (#182415). Only the body and code were interpolated, so
      // `node: ${{args.target}}` reached the node resolver as that literal string and every
      // hive playbook was pinned to one machine at authoring time. The same `${{}}` syntax
      // working three lines lower in the same step is what made it hard to see.
      stepH = interpolateStepHeaders(step, rawArgs, stepResults, root)
    } catch (e) {
      // A container escape is a bad argument, not a crash. Fail this step the
      // way any other step failure is reported, and let on-error decide.
      const sr: StepResult = {
        id: step.id, status: "failed", output: e instanceof Error ? e.message : String(e),
        exit_code: null, duration_ms: 0, attempts: 1,
      }
      stepResults[step.id] = sr
      checkpoint.steps[step.id] = sr
      checkpoint.updated_at = new Date().toISOString()
      saveCheckpoint(checkpoint)
      opts.onStepEnd?.(step, sr)
      if (plan.onError === "continue") continue
      finalStatus = "failed"
      break
    }

    // Confirmation gate
    const needsConfirm =
      step.confirm ||
      plan.confirm.some((pattern) => minimatch(step.id, pattern)) ||
      (interpolatedCode && isDangerousCommand(interpolatedCode))

    if (needsConfirm && !opts.yes && !opts.dryRun) {
      const display = interpolatedCode ?? interpolatedBody
      const confirmed = opts.onConfirm
        ? await opts.onConfirm(step.id, display)
        : true
      if (!confirmed) {
        stepResults[step.id] = {
          id: step.id, status: "skipped", output: "User declined confirmation",
          exit_code: null, duration_ms: 0, attempts: 0,
        }
        opts.onStepEnd?.(step, stepResults[step.id])
        continue
      }
    }

    // Human-in-the-loop halt.
    // A human step with no interactive handler (unattended run: --json, non-TTY,
    // scheduled job) cannot be answered now. Persist a resumable pause instead of
    // silently reporting success for work nobody did.
    if ((step.mode === "human" || step.mode === "manual") && !opts.onManualPrompt && !opts.dryRun) {
      const instructions = [interpolatedBody, interpolatedCode].filter(Boolean).join("\n\n").trim()
      const sr: StepResult = {
        id: step.id,
        status: "paused",
        output: instructions || step.title,
        exit_code: null,
        duration_ms: 0,
        attempts: 0,
      }
      stepResults[step.id] = sr
      checkpoint.steps[step.id] = sr
      checkpoint.current_step = step.id
      checkpoint.status = "paused"
      checkpoint.updated_at = new Date().toISOString()
      saveCheckpoint(checkpoint)
      opts.onStepEnd?.(step, sr)
      finalStatus = "paused"
      pausedOn = { id: step.id, title: step.title, instructions: instructions || step.title }
      break
    }

    // Dry run — skip actual execution
    if (opts.dryRun) {
      stepResults[step.id] = {
        id: step.id, status: "pending", output: "",
        exit_code: null, duration_ms: 0, attempts: 0,
      }
      continue
    }

    // Verbose output
    if (opts.verbose && interpolatedCode) {
      console.log(`  $ ${interpolatedCode}`)
    }

    // Execute with retry
    const maxAttempts = step.retry + 1
    let lastResult: { output: string; exit_code: number } = { output: "", exit_code: 1 }
    const startTime = Date.now()

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (step.delay > 0 && attempt === 1) {
        await new Promise((r) => setTimeout(r, step.delay * 1000))
      }
      if (attempt > 1 && step.delay > 0) {
        await new Promise((r) => setTimeout(r, step.delay * 1000))
      }

      switch (step.mode) {
        case "shell":
          lastResult = await executeShell(interpolatedCode!, plan.timeout * 1000)
          break

        case "prompt":
        case "ai": {
          // Build context from previous step outputs
          const context = Object.entries(stepResults)
            .filter(([, r]) => r.status === "success" && r.output)
            .map(([id, r]) => `[${id}]: ${r.output.slice(0, 2000)}`)
            .join("\n\n")
          const aiModel = stepH.model ?? "gpt-4o-mini"
          lastResult = await executeAi(interpolatedBody, aiModel, context)
          break
        }

        case "hive": {
          // Need userId for hive dispatch
          const { resolveUserId } = await import("../cli/cmd/iris-api")
          const userId = await resolveUserId()
          if (!userId) {
            lastResult = { output: "Not authenticated — cannot dispatch to Hive", exit_code: 1 }
          } else {
            lastResult = await executeHive(interpolatedCode!, plan, stepH, userId)
          }
          break
        }

        case "hive-script": {
          // Node.js script using IRIS SDK, dispatched to a Hive node
          const { resolveUserId: resolveUid } = await import("../cli/cmd/iris-api")
          const uid = await resolveUid()
          if (!uid) {
            lastResult = { output: "Not authenticated — cannot dispatch to Hive", exit_code: 1 }
          } else if (!interpolatedCode) {
            lastResult = { output: "[Step: " + step.id + "] FAILED: hive-script step has no code block", exit_code: 1 }
          } else {
            lastResult = await executeHiveScript(interpolatedCode, plan, stepH, uid)
          }
          break
        }

        case "cloud-workflow":
        case "cloud-agentic": {
          const { resolveUserId: resolveCwUid } = await import("../cli/cmd/iris-api")
          const cwUid = await resolveCwUid()
          if (!cwUid) {
            lastResult = { output: "Not authenticated — cannot execute cloud workflow", exit_code: 1 }
          } else {
            const interpolatedInput = step.input
              ? interpolateInput(step.input, rawArgs, stepResults, root)
              : null
            const stepWithInput = { ...step, input: interpolatedInput }
            lastResult = await executeCloudWorkflow(
              interpolatedBody,
              stepWithInput,
              cwUid,
              step.mode === "cloud-agentic",
              plan.timeout * 1000,
            )
          }
          break
        }

        case "n8n": {
          const n8nInput = step.input ? interpolateInput(step.input, rawArgs, stepResults, root) : null
          lastResult = await executeN8n(interpolatedBody, { ...step, input: n8nInput }, plan.timeout * 1000)
          break
        }

        case "langgraph": {
          const lgInput = step.input ? interpolateInput(step.input, rawArgs, stepResults, root) : null
          lastResult = await executeLanggraph(interpolatedBody, { ...step, input: lgInput }, plan.timeout * 1000)
          break
        }

        case "schedule": {
          const schedInput = step.input ? interpolateInput(step.input, rawArgs, stepResults, root) : null
          lastResult = await executeSchedule(interpolatedBody, { ...step, input: schedInput }, plan)
          break
        }

        case "skill":
        case "playbook": {
          if (!step.skillRef) {
            lastResult = { output: "No skill reference specified", exit_code: 1 }
            break
          }
          const targetSkill = await Skill.get(step.skillRef)
          if (!targetSkill) {
            lastResult = { output: `Skill "${step.skillRef}" not found`, exit_code: 1 }
            break
          }
          const targetPlan = await parsePlan(targetSkill)
          if (targetPlan.version === 1) {
            // v1 skill — load content as output
            const content = await Bun.file(targetSkill.location).text()
            lastResult = { output: content, exit_code: 0 }
          } else {
            const childArgs: Record<string, unknown> = {}
            if (stepH.skillArgs) {
              const parts = stepH.skillArgs.split(/\s+/)
              const keys = Object.keys(targetPlan.args)
              parts.forEach((v, i) => { if (keys[i]) childArgs[keys[i]] = v })
            }
            const childResult = await executeSkill(targetPlan, childArgs, {
              ...opts,
              resume: false,
            }, _depth + 1)
            const combinedOutput = Object.values(childResult.steps)
              .filter((r) => r.status === "success")
              .map((r) => r.output)
              .join("\n")
            lastResult = {
              output: combinedOutput,
              exit_code: childResult.status === "completed" ? 0 : 1,
            }
          }
          break
        }

        case "human":
        // Same runtime behaviour as human/manual — print the instruction, wait for a
        // person to confirm. Listed explicitly so a reader can see that a drafted
        // playbook's steps are deliberately not executed, rather than discovering it
        // by tracing a fall-through.
        case "agent":
        case "manual":
        default: {
          // Print instructions, wait for user to confirm done
          if (opts.onManualPrompt) {
            const done = await opts.onManualPrompt(step)
            lastResult = { output: done ? "User confirmed done" : "User skipped", exit_code: done ? 0 : 1 }
          } else {
            lastResult = { output: interpolatedBody, exit_code: 0 }
          }
          break
        }
      }

      if (lastResult.exit_code === 0) break
      if (attempt < maxAttempts) {
        log.info("step failed, retrying", { stepId: step.id, attempt, maxAttempts })
      }
    }

    const duration = Date.now() - startTime
    const MAX_OUTPUT = 10_000 // 10KB cap per step — prevents 80KB HTML blobs in JSON/checkpoints
    const rawOutput = lastResult.output
    const truncatedOutput = rawOutput.length > MAX_OUTPUT
      ? rawOutput.slice(0, MAX_OUTPUT) + `\n\n[truncated — ${rawOutput.length} chars total]`
      : rawOutput
    const sr: StepResult = {
      id: step.id,
      status: lastResult.exit_code === 0 ? "success" : "failed",
      output: truncatedOutput,
      exit_code: lastResult.exit_code,
      duration_ms: duration,
      attempts: Math.min(maxAttempts, step.retry + 1),
    }
    stepResults[step.id] = sr
    checkpoint.steps[step.id] = sr
    checkpoint.updated_at = new Date().toISOString()
    saveCheckpoint(checkpoint)
    opts.onStepEnd?.(step, sr)

    // Handle failure
    if (sr.status === "failed") {
      if (plan.onError === "stop") {
        finalStatus = "failed"
        break
      }
      if (plan.onError === "ask" && opts.onConfirm) {
        const continueExec = await opts.onConfirm(step.id, `Step "${step.id}" failed. Continue?`)
        if (!continueExec) {
          finalStatus = "interrupted"
          break
        }
      }
      if (plan.onError === "continue") {
        // keep going
      } else if (plan.onError === "ask" && !opts.onConfirm) {
        finalStatus = "failed"
        break
      }
    }
  }

  // Check if all steps succeeded. A paused run is neither done nor failed —
  // it is waiting on a human, so leave its status alone.
  if (finalStatus !== "paused") {
    const allSucceeded = Object.values(stepResults).every((r) => r.status === "success" || r.status === "skipped")
    if (allSucceeded && finalStatus !== "interrupted") finalStatus = "completed"
    else if (finalStatus === "completed" && !allSucceeded) finalStatus = "failed"
  }

  // Save final checkpoint
  checkpoint.status = finalStatus
  checkpoint.updated_at = new Date().toISOString()
  saveCheckpoint(checkpoint)

  return {
    run_id: runId,
    skill: plan.name,
    status: finalStatus,
    steps: stepResults,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    args: rawArgs,
    ...(pausedOn ? { paused_on: pausedOn } : {}),
  }
}

// ============================================================================
// Validation (for `iris skill test`)
// ============================================================================

export interface ValidationIssue {
  level: "error" | "warning"
  message: string
  stepId?: string
}

// Mirrors StepDef["mode"] exactly. `meta.mode` is read as a bare string at parse time (never
// validated against the union), so a typo like "agent" (meant "ai") is accepted silently and
// falls into the executor's `default:` case — same behavior as an undeclared manual step.
const KNOWN_STEP_MODES: ReadonlySet<string> = new Set([
  "shell", "prompt", "ai", "hive", "hive-script", "skill", "playbook",
  // `agent` is what the server's WalkthroughStructurer emits for EVERY step of a
  // drafted playbook, deliberately: a step drafted by a model from audio must not be
  // executable on sight ("bare push" was transcribed as "bear push" on a real
  // recording), so promoting one to `shell` is a human edit where someone takes
  // responsibility for what runs. It behaved correctly only by accident — it was
  // never in this union, so it fell through the executor's `default:` to manual.
  // Declaring it keeps that behaviour, and stops validation crying wolf on every
  // playbook the platform's own drafter produces.
  "human", "agent", "manual", "cloud-workflow", "cloud-agentic", "n8n", "langgraph", "schedule",
])

export function validatePlan(plan: SkillPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (!plan.name) issues.push({ level: "error", message: "Missing skill name" })
  if (!plan.description) issues.push({ level: "error", message: "Missing skill description" })

  // DEAD INTERPOLATION REFERENCES.
  //
  // Playbook interpolation is `${{args.x}}` — double braces, namespaced. A playbook written
  // with `${args.x}` or `${x}` validated CLEAN and then silently never resolved: the literal
  // text was passed through to the shell, the model, or the node resolver. Caught after
  // writing one that way and having `iris playbook test` report "No issues found" — a check
  // that could not tell a correct playbook from one whose references are all dead.
  //
  // Two different rules, because the false-positive risk differs:
  //   CODE/BODY — flag only NAMESPACED references (args./steps./env./playbook.). A bare
  //     `${i}` or `${process.env.HOME}` is a shell or JS template literal and is none of our
  //     business; flagging those would make this noise, and a noisy check gets ignored.
  //   HEADERS  — flag ANY single-brace reference. A header is never shell or JS, so there is
  //     nothing else `${...}` could be there.
  const NS = /(^|[^$])\$\{\s*(args|steps|env|playbook)\.[^{}]*\}/
  const ANY = /(^|[^$])\$\{[^{}]*\}/
  for (const step of plan.steps) {
    for (const [field, value] of [["code", step.code], ["body", step.body]] as const) {
      if (typeof value === "string" && NS.test(value)) {
        issues.push({
          level: "error",
          message: `[${step.id}] ${field} uses \${...} — playbook interpolation is \${{...}} (double braces). As written it will never resolve and the literal text is passed through.`,
        })
      }
    }
    for (const field of ["node", "model", "skillArgs", "workflowId", "webhook", "cron"] as const) {
      const v = step[field]
      if (typeof v === "string" && ANY.test(v)) {
        issues.push({
          level: "error",
          message: `[${step.id}] ${field}: uses \${...} — playbook interpolation is \${{...}} (double braces). As written it reaches the resolver as literal text.`,
        })
      }
    }
  }

  if (plan.version === 2 && plan.steps.length === 0) {
    issues.push({ level: "warning", message: "v2 skill has no steps defined" })
  }

  // The version-coercion trap. `parsePlan` collapses any frontmatter `version`
  // that is not EXACTLY 2 down to 1, and a v1 plan parses zero steps — so
  // "version: 3", "version: '2'" (a string), "version: 2.0" or a missing field
  // all produce a playbook that validates clean, syncs clean, and executes
  // NOTHING. Silence here reads as "fine", which is the whole problem: it is
  // indistinguishable from a real v1 doc. Only fire when the body actually has
  // steps, so genuine v1 playbooks stay quiet.
  if (plan.version !== 2 && (plan.bodyStepCount ?? 0) > 0) {
    const declared = plan.declaredVersion === undefined
      ? "no version field"
      : `version: ${JSON.stringify(plan.declaredVersion)}`
    issues.push({
      level: "error",
      message:
        `${plan.bodyStepCount} "### step:" block(s) in the body, but frontmatter has ${declared} ` +
        `— it must be EXACTLY "version: 2" (the number, not a string). ` +
        `As written these steps will NOT execute: the plan silently degrades to v1 and \`run\` ` +
        `dumps raw text instead of running anything. Fix: set "version: 2".`,
    })
  }

  const stepIds = new Set<string>()
  for (const step of plan.steps) {
    if (stepIds.has(step.id)) {
      issues.push({ level: "error", message: `Duplicate step ID: ${step.id}`, stepId: step.id })
    }
    stepIds.add(step.id)

    if (step.mode === "manual") {
      issues.push({ level: "warning", message: `Step uses default "manual" mode (no mode: declared)`, stepId: step.id })
    }

    // Any mode string is accepted at parse time (it's a bare `string`, not validated against
    // StepDef's mode union) — an unrecognized value like "agent" (meant "ai") doesn't error,
    // it silently falls into the executor's `default:` case and behaves exactly like an
    // undeclared manual step: print the body, wait for a human to say "done". A playbook whose
    // steps all say `mode: agent` looks like it should invoke an AI automatically and never does.
    if (!KNOWN_STEP_MODES.has(step.mode)) {
      issues.push({
        level: "error",
        message: `Unrecognized mode "${step.mode}" — not a real step mode, so it silently falls through to manual/no-op behavior at runtime instead of executing. Known modes: ${[...KNOWN_STEP_MODES].join(", ")}`,
        stepId: step.id,
      })
    }

    if (step.mode === "shell" && !step.code) {
      issues.push({ level: "error", message: "Shell step has no code block", stepId: step.id })
    }

    if (step.mode === "hive-script" && !step.code) {
      issues.push({ level: "error", message: "hive-script step has no code block (needs a JS script)", stepId: step.id })
    }

    if ((step.mode === "cloud-workflow" || step.mode === "cloud-agentic") && !step.workflowId) {
      issues.push({ level: "error", message: `${step.mode} step requires workflow_id`, stepId: step.id })
    }

    if (step.mode === "n8n" && !step.webhook && !step.workflowId) {
      issues.push({ level: "error", message: "n8n step requires webhook or workflow_id", stepId: step.id })
    }

    if (step.mode === "langgraph" && !step.body && !step.input && !step.workflowId) {
      issues.push({ level: "error", message: "langgraph step requires body, input, or workflow_id", stepId: step.id })
    }

    if (step.mode === "schedule" && !step.cron) {
      issues.push({ level: "error", message: "schedule step requires cron expression", stepId: step.id })
    }

    if (step.mode === "ai" && !step.body && !step.code) {
      issues.push({ level: "error", message: "AI step has no prompt body", stepId: step.id })
    }

    if ((step.mode === "skill" || step.mode === "playbook") && !step.skillRef) {
      issues.push({ level: "error", message: "Skill step has no skill reference", stepId: step.id })
    }

    if (typeof step.retry === "number" && step.retry < 0) {
      issues.push({ level: "warning", message: `Negative retry (${step.retry}) — step will never execute`, stepId: step.id })
    }

    if (step.depends && !stepIds.has(step.depends) && !plan.steps.some((s) => s.id === step.depends)) {
      issues.push({ level: "warning", message: `Depends on unknown step: ${step.depends}`, stepId: step.id })
    }
  }

  // Check for circular skill references
  for (const step of plan.steps) {
    if ((step.mode === "skill" || step.mode === "playbook") && step.skillRef === plan.name) {
      issues.push({ level: "error", message: "Circular self-reference detected", stepId: step.id })
    }
  }

  // Validate args
  for (const [key, def] of Object.entries(plan.args)) {
    if (!["string", "number", "boolean"].includes(def.type)) {
      issues.push({ level: "error", message: `Arg "${key}" has invalid type: ${def.type}` })
    }
  }

  return issues
}
