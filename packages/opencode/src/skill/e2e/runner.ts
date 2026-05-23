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
  coverage: ModeCoverage
  tests: E2ETestResult[]
}

export interface ModeCoverage {
  tested: string[]
  untested: string[]
  total: number
}

export interface E2ERunOptions {
  tier?: Tier
  mode?: string
  playbook?: string
  project?: boolean
  verbose?: boolean
  json?: boolean
}

// ============================================================================
// All 14 modes in the executor
// ============================================================================

const ALL_MODES = [
  "shell", "prompt", "ai", "hive", "hive-script", "skill", "playbook",
  "human", "manual", "cloud-workflow", "cloud-agentic", "n8n", "langgraph", "schedule",
]

// ============================================================================
// Embedded test playbooks (bundled into binary)
// ============================================================================

interface TestPlaybook {
  name: string
  tier: Tier
  content: string
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
    name: "e2e-error-handling",
    tier: "local",
    content: `---
name: e2e-error-handling
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
    name: "e2e-daemon",
    tier: "edge",
    content: `---
name: e2e-daemon
description: E2E test — local daemon health and connectivity
version: 2
on-error: continue
timeout: 30
---

# E2E Daemon Test

### step:health Daemon Health Check

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
curl -sf http://localhost:3200/health
\`\`\`

### step:verify Verify Health Response

\`\`\`yaml
mode: shell
depends: health
\`\`\`

\`\`\`bash
echo "$\{{steps.health.output}}" | grep -q "ok\\|healthy\\|status"
\`\`\`
`,
  },
  {
    name: "e2e-hive-script",
    tier: "edge",
    content: `---
name: e2e-hive-script
description: E2E test — hive-script mode (Node.js via daemon, requires auth + irisApi)
version: 2
on-error: continue
timeout: 30
---

# E2E Hive Script Test

### step:ping Hive Script Ping

\`\`\`yaml
mode: hive-script
\`\`\`

\`\`\`javascript
console.log(JSON.stringify({ ok: true, pid: process.pid }))
\`\`\`

### step:verify Verify Output

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

### step:iris-health IRIS API Health

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
curl -sf https://freelabel.net/api/health || echo "UNREACHABLE"
\`\`\`

### step:fl-health FL API Health

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
curl -sf https://raichu.heyiris.io/api/health -o /dev/null && echo "OK" || echo "UNREACHABLE"
\`\`\`
`,
  },
]

// ============================================================================
// Tier/service mapping
// ============================================================================

const TIER_SERVICES: Record<Tier, string[]> = {
  local: [],
  edge: ["hive"],
  cloud: ["irisApi"],
}

// Some edge tests also need irisApi (hive-script dispatches through cloud)
const EXTRA_SERVICES: Record<string, string[]> = {
  "e2e-hive-script": ["irisApi"],
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
// Materialize embedded playbooks to temp dir
// ============================================================================

interface MaterializedPlaybook {
  info: Skill.Info
  tier: Tier
  source: "builtin" | "project"
  customPass?: (r: SkillResult) => boolean
}

function materializeBuiltins(opts: E2ERunOptions, tmpDir: string): MaterializedPlaybook[] {
  const results: MaterializedPlaybook[] = []

  for (const pb of TEST_PLAYBOOKS) {
    if (opts.tier && pb.tier !== opts.tier) continue
    if (opts.playbook && pb.name !== opts.playbook) continue

    const dir = join(tmpDir, pb.name)
    mkdirSync(dir, { recursive: true })
    const location = join(dir, "PLAYBOOK.md")
    writeFileSync(location, pb.content)

    results.push({
      info: { name: pb.name, description: "", location },
      tier: pb.tier,
      source: "builtin",
      customPass: pb.customPass,
    })
  }

  return results
}

// ============================================================================
// Discover project playbooks for --project / --playbook <name>
// ============================================================================

async function discoverProjectPlaybooks(opts: E2ERunOptions): Promise<MaterializedPlaybook[]> {
  const { Skill: SkillModule } = await import("../skill")
  const { Instance } = await import("../../project/instance")

  const results: MaterializedPlaybook[] = []

  const allSkills = await Instance.provide({
    directory: process.cwd(),
    fn: () => SkillModule.all(),
  })

  for (const info of allSkills) {
    if (info.name.startsWith("e2e-")) continue
    if (opts.playbook && info.name !== opts.playbook) continue

    let plan: SkillPlan
    try {
      plan = await parsePlan(info)
    } catch {
      continue
    }
    if (plan.version !== 2 || plan.steps.length === 0) continue

    if (opts.mode) {
      const modes = plan.steps.map((s) => s.mode)
      if (!modes.includes(opts.mode as any)) continue
    }

    const modes = new Set(plan.steps.map((s) => s.mode))
    let tier: Tier = "local"
    if (modes.has("hive") || modes.has("hive-script")) tier = "edge"
    if (modes.has("cloud-workflow") || modes.has("cloud-agentic") || modes.has("n8n") || modes.has("langgraph")) tier = "cloud"
    if (modes.has("prompt") || modes.has("ai")) tier = "cloud"

    if (opts.tier && tier !== opts.tier) continue

    results.push({ info, tier, source: "project" })
  }

  return results
}

// ============================================================================
// Compute mode coverage
// ============================================================================

function computeCoverage(tests: E2ETestResult[]): ModeCoverage {
  const testedModes = new Set<string>()
  for (const t of tests) {
    if (t.status !== "skip") {
      for (const m of t.modes) testedModes.add(m)
    }
  }
  const tested = ALL_MODES.filter((m) => testedModes.has(m))
  const untested = ALL_MODES.filter((m) => !testedModes.has(m))
  return { tested, untested, total: ALL_MODES.length }
}

// ============================================================================
// Run a single playbook as a test
// ============================================================================

async function runOneTest(
  entry: MaterializedPlaybook,
  services: Record<string, boolean>,
  opts: E2ERunOptions,
): Promise<E2ETestResult> {
  const { info, tier, customPass } = entry
  const baseServices = TIER_SERVICES[tier] ?? []
  const extraServices = EXTRA_SERVICES[info.name] ?? []
  const requiredServices = [...new Set([...baseServices, ...extraServices])]
  const missingServices = requiredServices.filter((s) => !services[s])

  let plan: SkillPlan
  try {
    plan = await parsePlan(info)
  } catch (e: any) {
    return {
      name: info.name, tier, modes: [], status: "fail",
      reason: `Parse error: ${e.message}`, steps: {}, duration_ms: 0,
    }
  }

  const modes = [...new Set(plan.steps.map((s) => s.mode))]

  if (opts.mode && !modes.includes(opts.mode as any)) {
    return {
      name: info.name, tier, modes, status: "skip",
      reason: `No steps with mode "${opts.mode}"`, steps: {}, duration_ms: 0,
    }
  }

  if (missingServices.length > 0) {
    return {
      name: info.name, tier, modes, status: "skip",
      reason: `Missing service(s): ${missingServices.join(", ")}`, steps: {}, duration_ms: 0,
    }
  }

  // Skip project playbooks with modes that can't be auto-tested
  if (entry.source === "project") {
    if (modes.some((m) => m === "prompt" || m === "ai")) {
      return {
        name: info.name, tier, modes, status: "skip",
        reason: "AI mode requires API key (skipped in e2e)", steps: {}, duration_ms: 0,
      }
    }
    if (modes.some((m) => m === "human" || m === "manual")) {
      return {
        name: info.name, tier, modes, status: "skip",
        reason: "Has human/manual steps (cannot auto-test)", steps: {}, duration_ms: 0,
      }
    }
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
    return {
      name: info.name, tier, modes, status: "fail",
      reason: `Execution error: ${e.message}`, steps: {}, duration_ms: Date.now() - testStart,
    }
  }

  const failedSteps = Object.values(result.steps).filter((r) => r.status === "failed")
  let status: "pass" | "fail"

  if (customPass) {
    status = customPass(result) ? "pass" : "fail"
  } else {
    status = failedSteps.length === 0 ? "pass" : "fail"
  }

  cleanupCheckpoint(result.run_id)

  return {
    name: info.name, tier, modes, status,
    reason: status === "fail" ? `${failedSteps.length} step(s) failed` : undefined,
    steps: result.steps, duration_ms: Date.now() - testStart,
  }
}

// ============================================================================
// Run suite
// ============================================================================

export async function runE2ESuite(opts: E2ERunOptions = {}): Promise<E2ESuiteResult> {
  const suiteStart = Date.now()
  const services = await probeServices()
  const tmpDir = join(tmpdir(), `iris-e2e-${process.pid}`)
  mkdirSync(tmpDir, { recursive: true })

  const entries: MaterializedPlaybook[] = []

  // Built-in tests (unless --project without --playbook)
  if (!opts.project || opts.playbook) {
    entries.push(...materializeBuiltins(opts, tmpDir))
  }

  // Project playbooks (when --project or --playbook targeting a non-builtin)
  if (opts.project || opts.playbook) {
    const projectEntries = await discoverProjectPlaybooks(opts)
    const existingNames = new Set(entries.map((e) => e.info.name))
    for (const pe of projectEntries) {
      if (!existingNames.has(pe.info.name)) entries.push(pe)
    }
  }

  const tests: E2ETestResult[] = []
  for (const entry of entries) {
    tests.push(await runOneTest(entry, services, opts))
  }

  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }

  const passed = tests.filter((t) => t.status === "pass").length
  const failed = tests.filter((t) => t.status === "fail").length
  const skipped = tests.filter((t) => t.status === "skip").length

  return {
    passed, failed, skipped,
    total: tests.length,
    duration_ms: Date.now() - suiteStart,
    services,
    coverage: computeCoverage(tests),
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
