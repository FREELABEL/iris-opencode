import matter from "gray-matter"
import { minimatch } from "minimatch"
import { Skill } from "./skill"
import { ConfigMarkdown } from "../config/markdown"
import { Log } from "../util/log"
import { homedir } from "os"
import { join } from "path"
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs"

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
  mode: "shell" | "prompt" | "ai" | "hive" | "hive-script" | "skill" | "playbook" | "human" | "manual" | "cloud-workflow" | "cloud-agentic" | "n8n" | "langgraph" | "schedule"
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
}

export interface SkillPlan {
  name: string
  version: 1 | 2
  description: string
  args: Record<string, ArgDef>
  steps: StepDef[]
  includes: string[]
  confirm: string[]
  onError: "continue" | "stop" | "ask"
  timeout: number
  integrations: string[]
  location: string
}

export interface StepResult {
  id: string
  status: "success" | "failed" | "skipped" | "pending"
  output: string
  exit_code: number | null
  duration_ms: number
  attempts: number
}

export interface SkillResult {
  run_id: string
  skill: string
  status: "completed" | "failed" | "interrupted"
  steps: Record<string, StepResult>
  started_at: string
  finished_at: string
  args: Record<string, unknown>
}

// ============================================================================
// Runs directory
// ============================================================================

const RUNS_DIR = join(homedir(), ".iris", "skill-runs")

function ensureRunsDir() {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true })
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

  // Parse steps from markdown body
  const steps = version === 2 ? parseSteps(md.content) : []

  return {
    name: fm.name ?? skillInfo.name,
    version,
    description: fm.description ?? skillInfo.description,
    args,
    steps,
    includes: fm.includes ?? [],
    confirm: fm.confirm ?? [],
    onError: fm["on-error"] ?? "ask",
    timeout: fm.timeout ?? 300,
    integrations: fm.integrations ?? [],
    location: skillInfo.location,
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

export function interpolate(
  template: string,
  args: Record<string, unknown>,
  stepResults: Record<string, StepResult>,
  shellSafe = false,
): string {
  const escape = shellSafe ? shellEscape : (s: string) => s
  return template.replace(/\$\{\{(\s*[\w.\-]+\s*)\}\}/g, (_match, expr: string) => {
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
    return ""
  })
    .replace(/\$ARGUMENTS/g, escape(String(args._raw ?? "")))
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
): Record<string, any> {
  const walk = (val: unknown): unknown => {
    if (typeof val === "string") return interpolate(val, args, stepResults)
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
): boolean {
  // Interpolate variables first
  const interpolated = interpolate(condition, args, stepResults)

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

interface Checkpoint {
  run_id: string
  skill: string
  args: Record<string, unknown>
  started_at: string
  updated_at: string
  status: "running" | "interrupted" | "completed" | "failed"
  current_step: string | null
  steps: Record<string, StepResult>
}

function saveCheckpoint(cp: Checkpoint) {
  ensureRunsDir()
  writeFileSync(join(RUNS_DIR, `${cp.run_id}.json`), JSON.stringify(cp, null, 2))
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

async function executeAi(
  prompt: string,
  model: string,
  context: string,
): Promise<{ output: string; exit_code: number }> {
  try {
    // Use the AI SDK's generateText for simple prompts
    const { generateText } = await import("ai")

    // Resolve provider based on model name
    let provider: any
    if (model.startsWith("gpt-")) {
      const { openai } = await import("@ai-sdk/openai")
      provider = openai(model)
    } else if (model.startsWith("claude-")) {
      const { anthropic } = await import("@ai-sdk/anthropic")
      provider = anthropic(model)
    } else {
      // Default to openai for nano models
      const { openai } = await import("@ai-sdk/openai")
      provider = openai(model)
    }

    const fullPrompt = context ? `Context from previous steps:\n${context}\n\n${prompt}` : prompt

    const result = await generateText({
      model: provider,
      prompt: fullPrompt,
      maxOutputTokens: 2000,
    })

    return { output: result.text, exit_code: 0 }
  } catch (e: any) {
    return { output: `AI error: ${e.message}`, exit_code: 1 }
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

    const createRes = await hiveFetch("/api/v6/nodes/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        title: `skill:${plan.name}/${step.id}`,
        type: "sandbox_execute",
        node_id: step.node ?? "default",
        prompt: `#!/bin/bash\nset -e\n${code}`,
        config: { timeout_seconds: plan.timeout },
        timeout_seconds: plan.timeout,
      }),
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

    const createRes = await hiveFetch("/api/v6/nodes/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        title: `playbook:${plan.name}/${step.id}`,
        type: "hive_script",
        prompt: wrappedCode,
        node_id: step.node ?? "default",
        config: { timeout_seconds: plan.timeout },
        timeout_seconds: plan.timeout,
      }),
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
    const n8nUrl = (process.env.N8N_URL ?? "http://localhost:5678").replace(/\/$/, "")

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

  const runId = generateRunId()
  const now = new Date().toISOString()
  const stepResults: Record<string, StepResult> = {}

  // Load checkpoint if resuming
  let resumeCheckpoint: Checkpoint | null = null
  if (opts.resume) {
    resumeCheckpoint = findLatestCheckpoint(plan.name)
    if (resumeCheckpoint) {
      // Restore previous results
      for (const [id, sr] of Object.entries(resumeCheckpoint.steps)) {
        if (sr.status === "success") stepResults[id] = sr
      }
    }
  }

  // Initialize checkpoint
  const checkpoint: Checkpoint = {
    run_id: runId,
    skill: plan.name,
    args: rawArgs,
    started_at: now,
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

  let finalStatus: "completed" | "failed" | "interrupted" = "completed"

  for (const step of stepsToRun) {
    // Skip already-completed steps (resume mode)
    if (stepResults[step.id]?.status === "success") continue

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
      if (!evaluateCondition(step.condition, rawArgs, stepResults)) {
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
    const interpolatedCode = step.code ? interpolate(step.code, rawArgs, stepResults, isShell) : null
    const interpolatedBody = interpolate(step.body, rawArgs, stepResults)

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
          const aiModel = step.model ?? "gpt-4o-mini"
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
            lastResult = await executeHive(interpolatedCode!, plan, step, userId)
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
            lastResult = await executeHiveScript(interpolatedCode, plan, step, uid)
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
              ? interpolateInput(step.input, rawArgs, stepResults)
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
          const n8nInput = step.input ? interpolateInput(step.input, rawArgs, stepResults) : null
          lastResult = await executeN8n(interpolatedBody, { ...step, input: n8nInput }, plan.timeout * 1000)
          break
        }

        case "langgraph": {
          const lgInput = step.input ? interpolateInput(step.input, rawArgs, stepResults) : null
          lastResult = await executeLanggraph(interpolatedBody, { ...step, input: lgInput }, plan.timeout * 1000)
          break
        }

        case "schedule": {
          const schedInput = step.input ? interpolateInput(step.input, rawArgs, stepResults) : null
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
            if (step.skillArgs) {
              const parts = step.skillArgs.split(/\s+/)
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

  // Check if all steps succeeded
  const allSucceeded = Object.values(stepResults).every((r) => r.status === "success" || r.status === "skipped")
  if (allSucceeded && finalStatus !== "interrupted") finalStatus = "completed"
  else if (finalStatus === "completed" && !allSucceeded) finalStatus = "failed"

  // Save final checkpoint
  checkpoint.status = finalStatus
  checkpoint.updated_at = new Date().toISOString()
  saveCheckpoint(checkpoint)

  return {
    run_id: runId,
    skill: plan.name,
    status: finalStatus,
    steps: stepResults,
    started_at: now,
    finished_at: new Date().toISOString(),
    args: rawArgs,
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

export function validatePlan(plan: SkillPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (!plan.name) issues.push({ level: "error", message: "Missing skill name" })
  if (!plan.description) issues.push({ level: "error", message: "Missing skill description" })

  if (plan.version === 2 && plan.steps.length === 0) {
    issues.push({ level: "warning", message: "v2 skill has no steps defined" })
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
