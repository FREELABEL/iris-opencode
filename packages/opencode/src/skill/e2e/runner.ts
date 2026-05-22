import { join } from "path"
import { existsSync, unlinkSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { homedir, tmpdir } from "os"
import { parsePlan, executeSkill, type SkillPlan, type SkillResult, type StepResult, type ExecuteOptions } from "../executor"
import type { Skill } from "../skill"

// ============================================================================
// Types
// ============================================================================

export type Tier = "local" | "edge" | "cloud"

export interface E2ETestResult {
  name: string
  tier: Tier
  modes: string[]
  status: "pass" | "fail" | "skip"
  reason?: string
  steps: Record<string, StepResult>
  duration_ms: number
}

export interface E2ESuiteResult {
  passed: number
  failed: number
  skipped: number
  total: number
  duration_ms: number
  services: Record<string, boolean>
  tests: E2ETestResult[]
}

export interface E2ERunOptions {
  tier?: Tier
  mode?: string
  verbose?: boolean
  json?: boolean
}

// ============================================================================
// Embedded test playbooks (bundled into binary)
// ============================================================================

interface TestPlaybook {
  name: string
  tier: Tier
  content: string
  /** For e2e-nested: custom pass criteria */
  customPass?: (result: SkillResult) => boolean
}

const TEST_PLAYBOOKS: TestPlaybook[] = [
  {
    name: "e2e-shell",
    tier: "local",
    content: `---
name: e2e-shell
description: E2E test — basic shell execution and step chaining
version: 2
on-error: continue
timeout: 30
---

# E2E Shell Test

### step:echo Echo Hello

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
echo "hello-e2e"
\`\`\`

### step:chain Verify Chain Output

\`\`\`yaml
mode: shell
depends: echo
\`\`\`

\`\`\`bash
echo "$\{{steps.echo.output}}"
\`\`\`

### step:env Environment Variable

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
echo "$HOME"
\`\`\`

### step:exit-zero Exit Code Zero

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
true
\`\`\`
`,
  },
  {
    name: "e2e-chained",
    tier: "local",
    content: `---
name: e2e-chained
description: E2E test — step chaining, transforms, and conditional logic
version: 2
args:
  run_conditional:
    type: string
    required: false
    default: "no"
on-error: continue
timeout: 30
---

# E2E Chained Steps Test

### step:generate Generate Payload

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
echo "PAYLOAD_42"
\`\`\`

### step:transform Transform to Lowercase

\`\`\`yaml
mode: shell
depends: generate
\`\`\`

\`\`\`bash
echo "$\{{steps.generate.output}}" | tr '[:upper:]' '[:lower:]'
\`\`\`

### step:validate Validate Transform

\`\`\`yaml
mode: shell
depends: transform
\`\`\`

\`\`\`bash
test "$\{{steps.transform.output}}" = "payload_42"
\`\`\`

### step:conditional Conditional Step

\`\`\`yaml
mode: shell
if: $\{{args.run_conditional}} == yes
\`\`\`

\`\`\`bash
echo "ran"
\`\`\`
`,
  },
  {
    name: "e2e-interpolation",
    tier: "local",
    content: `---
name: e2e-interpolation
description: E2E test — argument, env, and step-ref interpolation
version: 2
args:
  name:
    type: string
    required: false
    default: "alice"
  count:
    type: number
    required: false
    default: 7
on-error: continue
timeout: 30
---

# E2E Interpolation Test

### step:args Argument Interpolation

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
echo "$\{{args.name}}-$\{{args.count}}"
\`\`\`

### step:env-var Environment Interpolation

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
echo "$\{{env.HOME}}"
\`\`\`

### step:multi Multi-Reference Interpolation

\`\`\`yaml
mode: shell
depends: args
\`\`\`

\`\`\`bash
echo "$\{{steps.args.output}} $\{{steps.args.exit_code}}"
\`\`\`
`,
  },
  {
    name: "e2e-nested",
    tier: "local",
    content: `---
name: e2e-nested
description: E2E test — multi-step error handling and on-error continue
version: 2
on-error: continue
timeout: 30
---

# E2E Error Handling Test

### step:pass Passing Step

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
echo "step-pass-ok"
\`\`\`

### step:fail Intentional Failure

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
exit 1
\`\`\`

### step:after-fail After Failure

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
echo "continued-after-failure"
\`\`\`

### step:verify Verify Continuation

\`\`\`yaml
mode: shell
depends: after-fail
\`\`\`

\`\`\`bash
test "$\{{steps.after-fail.output}}" = "continued-after-failure"
\`\`\`
`,
    customPass: (result) => {
      const afterFail = result.steps["after-fail"]
      const verify = result.steps["verify"]
      return afterFail?.status === "success" && verify?.status === "success"
    },
  },
  {
    name: "e2e-hive-script",
    tier: "edge",
    content: `---
name: e2e-hive-script
description: E2E test — hive-script execution via local daemon
version: 2
on-error: continue
timeout: 30
---

# E2E Hive Script Test

### step:ping Hive Ping

\`\`\`yaml
mode: hive-script
\`\`\`

\`\`\`javascript
console.log(JSON.stringify({ ok: true, pid: process.pid }))
\`\`\`

### step:verify Verify Hive Output

\`\`\`yaml
mode: shell
depends: ping
\`\`\`

\`\`\`bash
echo "$\{{steps.ping.output}}" | grep -q '"ok"'
\`\`\`
`,
  },
  {
    name: "e2e-cloud-smoke",
    tier: "cloud",
    content: `---
name: e2e-cloud-smoke
description: E2E test — cloud API reachability (read-only health check)
version: 2
on-error: continue
timeout: 30
---

# E2E Cloud Smoke Test

### step:health API Health Check

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
curl -sf https://freelabel.net/api/health || echo "UNREACHABLE"
\`\`\`
`,
  },
]

// ============================================================================
// Tier→service mapping
// ============================================================================

const TIER_SERVICES: Record<Tier, string[]> = {
  local: [],
  edge: ["hive"],
  cloud: ["irisApi"],
}

// ============================================================================
// Service probes
// ============================================================================

export async function probeServices(): Promise<Record<string, boolean>> {
  const probes: Record<string, () => Promise<boolean>> = {
    hive: async () => {
      const res = await fetch("http://localhost:3200/health", {
        signal: AbortSignal.timeout(2000),
      })
      return res.ok
    },
    n8n: async () => {
      const res = await fetch("http://localhost:5678/healthz", {
        signal: AbortSignal.timeout(2000),
      })
      return res.ok
    },
    langgraph: async () => {
      const res = await fetch("http://localhost:8001/health", {
        signal: AbortSignal.timeout(2000),
      })
      return res.ok
    },
    irisApi: async () => {
      const res = await fetch("https://freelabel.net/api/health", {
        signal: AbortSignal.timeout(2000),
      })
      return res.ok
    },
  }

  const results: Record<string, boolean> = {}

  await Promise.all(
    Object.entries(probes).map(async ([name, probe]) => {
      try {
        results[name] = await probe()
      } catch {
        results[name] = false
      }
    }),
  )

  return results
}

// ============================================================================
// Write playbooks to temp dir and build Skill.Info
// ============================================================================

function materializePlaybooks(opts: E2ERunOptions): { info: Skill.Info; tier: Tier; customPass?: (r: SkillResult) => boolean; tmpDir: string }[] {
  const base = join(tmpdir(), `iris-e2e-${process.pid}`)
  mkdirSync(base, { recursive: true })

  const results: { info: Skill.Info; tier: Tier; customPass?: (r: SkillResult) => boolean; tmpDir: string }[] = []

  for (const pb of TEST_PLAYBOOKS) {
    if (opts.tier && pb.tier !== opts.tier) continue

    const dir = join(base, pb.name)
    mkdirSync(dir, { recursive: true })
    const location = join(dir, "PLAYBOOK.md")
    writeFileSync(location, pb.content)

    results.push({
      info: { name: pb.name, description: "", location },
      tier: pb.tier,
      customPass: pb.customPass,
      tmpDir: base,
    })
  }

  return results
}

// ============================================================================
// Run suite
// ============================================================================

export async function runE2ESuite(opts: E2ERunOptions = {}): Promise<E2ESuiteResult> {
  const suiteStart = Date.now()
  const services = await probeServices()
  const playbooks = materializePlaybooks(opts)
  const tests: E2ETestResult[] = []
  let tmpDir: string | null = null

  for (const { info, tier, customPass } of playbooks) {
    tmpDir = playbooks[0]?.tmpDir ?? null
    const requiredServices = TIER_SERVICES[tier] ?? []
    const missingServices = requiredServices.filter((s) => !services[s])

    let plan: SkillPlan
    try {
      plan = await parsePlan(info)
    } catch (e: any) {
      tests.push({
        name: info.name,
        tier,
        modes: [],
        status: "fail",
        reason: `Parse error: ${e.message}`,
        steps: {},
        duration_ms: 0,
      })
      continue
    }

    const modes = [...new Set(plan.steps.map((s) => s.mode))]

    if (opts.mode && !modes.includes(opts.mode as any)) continue

    if (missingServices.length > 0) {
      tests.push({
        name: info.name,
        tier,
        modes,
        status: "skip",
        reason: `Missing service(s): ${missingServices.join(", ")}`,
        steps: {},
        duration_ms: 0,
      })
      continue
    }

    const testStart = Date.now()
    let result: SkillResult

    const execOpts: ExecuteOptions = {
      yes: true,
      verbose: opts.verbose ?? false,
      onStepStart() {},
      onStepEnd() {},
      async onConfirm() { return true },
      async onManualPrompt() { return true },
    }

    try {
      result = await executeSkill(plan, {}, execOpts)
    } catch (e: any) {
      tests.push({
        name: info.name,
        tier,
        modes,
        status: "fail",
        reason: `Execution error: ${e.message}`,
        steps: {},
        duration_ms: Date.now() - testStart,
      })
      continue
    }

    const failedSteps = Object.values(result.steps).filter((r) => r.status === "failed")
    let status: "pass" | "fail"

    if (customPass) {
      status = customPass(result) ? "pass" : "fail"
    } else {
      status = failedSteps.length === 0 ? "pass" : "fail"
    }

    tests.push({
      name: info.name,
      tier,
      modes,
      status,
      reason: status === "fail" ? `${failedSteps.length} step(s) failed` : undefined,
      steps: result.steps,
      duration_ms: Date.now() - testStart,
    })

    cleanupCheckpoint(result.run_id)
  }

  // Cleanup temp directory
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  const passed = tests.filter((t) => t.status === "pass").length
  const failed = tests.filter((t) => t.status === "fail").length
  const skipped = tests.filter((t) => t.status === "skip").length

  return {
    passed,
    failed,
    skipped,
    total: tests.length,
    duration_ms: Date.now() - suiteStart,
    services,
    tests,
  }
}

// ============================================================================
// Cleanup
// ============================================================================

function cleanupCheckpoint(runId: string) {
  const runsDir = join(homedir(), ".iris", "skill-runs")
  const file = join(runsDir, `${runId}.json`)
  try {
    if (existsSync(file)) unlinkSync(file)
  } catch {
    // ignore cleanup errors
  }
}
