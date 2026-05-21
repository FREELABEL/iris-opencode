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
  mode: "shell" | "ai" | "hive" | "skill" | "manual"
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

const STEP_HEADING = /^### step:(\S+)\s+(.+)$/gm
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
      skillRef: meta.skill ?? null,
      skillArgs: meta.args != null ? String(meta.args) : null,
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

export function interpolate(
  template: string,
  args: Record<string, unknown>,
  stepResults: Record<string, StepResult>,
): string {
  return template.replace(/\$\{\{(\s*[\w.\-]+\s*)\}\}/g, (_match, expr: string) => {
    const path = expr.trim().split(".")
    if (path[0] === "args" && path.length === 2) {
      return String(args[path[1]] ?? "")
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
    // Backward compat: $ARGUMENTS
    .replace(/\$ARGUMENTS/g, String(args._raw ?? ""))
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
    const interpolatedCode = step.code ? interpolate(step.code, rawArgs, stepResults) : null
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

        case "skill": {
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
    const sr: StepResult = {
      id: step.id,
      status: lastResult.exit_code === 0 ? "success" : "failed",
      output: lastResult.output,
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

    if (step.mode === "ai" && !step.body && !step.code) {
      issues.push({ level: "error", message: "AI step has no prompt body", stepId: step.id })
    }

    if (step.mode === "skill" && !step.skillRef) {
      issues.push({ level: "error", message: "Skill step has no skill reference", stepId: step.id })
    }

    if (step.depends && !stepIds.has(step.depends) && !plan.steps.some((s) => s.id === step.depends)) {
      issues.push({ level: "warning", message: `Depends on unknown step: ${step.depends}`, stepId: step.id })
    }
  }

  // Check for circular skill references
  for (const step of plan.steps) {
    if (step.mode === "skill" && step.skillRef === plan.name) {
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
