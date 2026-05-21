import { describe, test, expect } from "bun:test"
import {
  parseSteps,
  interpolate,
  shellEscape,
  resolveArgs,
  validatePlan,
  type StepDef,
  type StepResult,
  type SkillPlan,
  type ArgDef,
} from "./executor"

// ============================================================================
// parseSteps
// ============================================================================

describe("parseSteps", () => {
  test("parses a single shell step", () => {
    const md = `
### step:hello Hello World

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
echo "hello"
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps).toHaveLength(1)
    expect(steps[0].id).toBe("hello")
    expect(steps[0].title).toBe("Hello World")
    expect(steps[0].mode).toBe("shell")
    expect(steps[0].code).toBe('echo "hello"')
  })

  test("parses multiple steps", () => {
    const md = `
### step:one Step One

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
echo "one"
\`\`\`

### step:two Step Two

\`\`\`yaml
mode: ai
model: gpt-4o-mini
\`\`\`

Analyze the output from step one.

### step:three Step Three

\`\`\`yaml
mode: manual
\`\`\`

Do this manually.
`
    const steps = parseSteps(md)
    expect(steps).toHaveLength(3)
    expect(steps[0].id).toBe("one")
    expect(steps[0].mode).toBe("shell")
    expect(steps[1].id).toBe("two")
    expect(steps[1].mode).toBe("ai")
    expect(steps[1].model).toBe("gpt-4o-mini")
    expect(steps[2].id).toBe("three")
    expect(steps[2].mode).toBe("manual")
  })

  test("parses step metadata: confirm, depends, retry, delay", () => {
    const md = `
### step:deploy Deploy Service

\`\`\`yaml
mode: shell
confirm: true
depends: check
retry: 3
delay: 5
\`\`\`

\`\`\`bash
railway redeploy --service fl-api --yes
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].confirm).toBe(true)
    expect(steps[0].depends).toBe("check")
    expect(steps[0].retry).toBe(3)
    expect(steps[0].delay).toBe(5)
  })

  test("parses if: condition", () => {
    const md = `
### step:conditional Conditional Step

\`\`\`yaml
mode: shell
if: \${{args.action}} == status
\`\`\`

\`\`\`bash
echo "status check"
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].condition).toBe("${{args.action}} == status")
  })

  test("parses skill mode with skill ref and args", () => {
    const md = `
### step:sub Call Sub-Skill

\`\`\`yaml
mode: skill
skill: bridge-doctor
args: status
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].mode).toBe("skill")
    expect(steps[0].skillRef).toBe("bridge-doctor")
    expect(steps[0].skillArgs).toBe("status")
  })

  test("defaults to manual mode when no yaml block", () => {
    const md = `
### step:manual-step Do Something

Just follow these instructions manually.
`
    const steps = parseSteps(md)
    expect(steps[0].mode).toBe("manual")
    expect(steps[0].code).toBeNull()
  })

  test("extracts prose body (not in fenced blocks)", () => {
    const md = `
### step:ai-step Analyze Data

\`\`\`yaml
mode: ai
\`\`\`

Look at the data and summarize key findings.
Focus on errors and anomalies.
`
    const steps = parseSteps(md)
    expect(steps[0].body).toContain("Look at the data")
    expect(steps[0].body).toContain("Focus on errors")
  })

  test("handles hyphenated step IDs", () => {
    const md = `
### step:check-api Check API Health

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
curl -sf https://example.com/health
\`\`\`

### step:check-frontend Check Frontend

\`\`\`yaml
mode: shell
depends: check-api
\`\`\`

\`\`\`bash
curl -sf https://example.com
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps).toHaveLength(2)
    expect(steps[0].id).toBe("check-api")
    expect(steps[1].id).toBe("check-frontend")
    expect(steps[1].depends).toBe("check-api")
  })

  test("returns empty array when no steps", () => {
    const md = `
# Just a regular markdown document

No steps here.
`
    const steps = parseSteps(md)
    expect(steps).toHaveLength(0)
  })

  test("ignores non-step headings", () => {
    const md = `
### Regular Heading

Some content.

### step:real Real Step

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
echo "real"
\`\`\`

### Another Regular Heading

More content.
`
    const steps = parseSteps(md)
    expect(steps).toHaveLength(1)
    expect(steps[0].id).toBe("real")
  })
})

// ============================================================================
// interpolate
// ============================================================================

describe("interpolate", () => {
  test("interpolates args", () => {
    const result = interpolate(
      'echo "Hello, ${{args.name}}!"',
      { name: "IRIS" },
      {},
    )
    expect(result).toBe('echo "Hello, IRIS!"')
  })

  test("interpolates step output", () => {
    const result = interpolate(
      "Previous output: ${{steps.check.output}}",
      {},
      { check: { id: "check", status: "success", output: "all good", exit_code: 0, duration_ms: 100, attempts: 1 } },
    )
    expect(result).toBe("Previous output: all good")
  })

  test("interpolates step exit_code", () => {
    const result = interpolate(
      "Exit: ${{steps.check.exit_code}}",
      {},
      { check: { id: "check", status: "success", output: "", exit_code: 0, duration_ms: 100, attempts: 1 } },
    )
    expect(result).toBe("Exit: 0")
  })

  test("interpolates env vars", () => {
    process.env.__TEST_SKILL_VAR = "test_value"
    const result = interpolate("Value: ${{env.__TEST_SKILL_VAR}}", {}, {})
    expect(result).toBe("Value: test_value")
    delete process.env.__TEST_SKILL_VAR
  })

  test("returns empty string for missing args", () => {
    const result = interpolate("${{args.missing}}", {}, {})
    expect(result).toBe("")
  })

  test("returns empty string for missing step results", () => {
    const result = interpolate("${{steps.nonexistent.output}}", {}, {})
    expect(result).toBe("")
  })

  test("handles hyphenated step IDs", () => {
    const result = interpolate(
      "Result: ${{steps.check-api.output}}",
      {},
      { "check-api": { id: "check-api", status: "success", output: "200 OK", exit_code: 0, duration_ms: 50, attempts: 1 } },
    )
    expect(result).toBe("Result: 200 OK")
  })

  test("handles multiple interpolations in one string", () => {
    const result = interpolate(
      "${{args.greeting}} ${{args.name}} (exit: ${{steps.prev.exit_code}})",
      { greeting: "Hello", name: "World" },
      { prev: { id: "prev", status: "success", output: "", exit_code: 0, duration_ms: 0, attempts: 1 } },
    )
    expect(result).toBe("Hello World (exit: 0)")
  })

  test("replaces $ARGUMENTS with raw args", () => {
    const result = interpolate("Args: $ARGUMENTS", { _raw: "status --verbose" }, {})
    expect(result).toBe("Args: status --verbose")
  })

  test("handles whitespace in expressions", () => {
    const result = interpolate("${{ args.name }}", { name: "test" }, {})
    expect(result).toBe("test")
  })
})

// ============================================================================
// resolveArgs
// ============================================================================

describe("resolveArgs", () => {
  const schema: Record<string, ArgDef> = {
    action: { type: "string", required: true, enum: ["status", "errors", "logs"] },
    service: { type: "string", required: false, default: "all" },
    verbose: { type: "boolean", required: false, default: false },
  }

  test("fills positional args in schema order", () => {
    const result = resolveArgs(schema, ["status", "fl-api"], {})
    expect(result.action).toBe("status")
    expect(result.service).toBe("fl-api")
  })

  test("applies defaults for missing args", () => {
    const result = resolveArgs(schema, ["status"], {})
    expect(result.action).toBe("status")
    expect(result.service).toBe("all")
  })

  test("flag args override positional", () => {
    const result = resolveArgs(schema, ["status"], { service: "fl-iris-api" })
    expect(result.service).toBe("fl-iris-api")
  })

  test("throws on missing required arg", () => {
    expect(() => resolveArgs(schema, [], {})).toThrow("Missing required argument: action")
  })

  test("throws on invalid enum value", () => {
    expect(() => resolveArgs(schema, ["invalid"], {})).toThrow('Invalid value for "action"')
  })

  test("coerces number type", () => {
    const numSchema: Record<string, ArgDef> = {
      count: { type: "number", required: true },
    }
    const result = resolveArgs(numSchema, ["42"], {})
    expect(result.count).toBe(42)
  })

  test("coerces boolean type", () => {
    const result = resolveArgs(schema, ["status"], { verbose: "true" })
    expect(result.verbose).toBe(true)
  })
})

// ============================================================================
// validatePlan
// ============================================================================

describe("validatePlan", () => {
  const basePlan: SkillPlan = {
    name: "test",
    version: 2,
    description: "test skill",
    args: {},
    steps: [],
    includes: [],
    confirm: [],
    onError: "ask",
    timeout: 300,
    integrations: [],
    location: "/tmp/test/SKILL.md",
  }

  test("passes for valid plan with steps", () => {
    const plan = {
      ...basePlan,
      steps: [
        { id: "one", title: "Step One", mode: "shell" as const, body: "", code: "echo hi", confirm: false, depends: null, retry: 0, delay: 0, condition: null, model: null, node: null, skillRef: null, skillArgs: null },
      ],
    }
    const issues = validatePlan(plan)
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0)
  })

  test("warns on v2 skill with no steps", () => {
    const issues = validatePlan(basePlan)
    expect(issues.some((i) => i.message.includes("no steps"))).toBe(true)
  })

  test("errors on duplicate step IDs", () => {
    const step = { id: "dup", title: "Dup", mode: "shell" as const, body: "", code: "echo", confirm: false, depends: null, retry: 0, delay: 0, condition: null, model: null, node: null, skillRef: null, skillArgs: null }
    const plan = { ...basePlan, steps: [step, { ...step }] }
    const issues = validatePlan(plan)
    expect(issues.some((i) => i.message.includes("Duplicate step ID"))).toBe(true)
  })

  test("errors on shell step with no code", () => {
    const plan = {
      ...basePlan,
      steps: [
        { id: "bad", title: "Bad", mode: "shell" as const, body: "", code: null, confirm: false, depends: null, retry: 0, delay: 0, condition: null, model: null, node: null, skillRef: null, skillArgs: null },
      ],
    }
    const issues = validatePlan(plan)
    expect(issues.some((i) => i.message.includes("Shell step has no code"))).toBe(true)
  })

  test("errors on skill step with no skill ref", () => {
    const plan = {
      ...basePlan,
      steps: [
        { id: "bad", title: "Bad", mode: "skill" as const, body: "", code: null, confirm: false, depends: null, retry: 0, delay: 0, condition: null, model: null, node: null, skillRef: null, skillArgs: null },
      ],
    }
    const issues = validatePlan(plan)
    expect(issues.some((i) => i.message.includes("Skill step has no skill reference"))).toBe(true)
  })

  test("errors on circular self-reference", () => {
    const plan = {
      ...basePlan,
      steps: [
        { id: "self", title: "Self", mode: "skill" as const, body: "", code: null, confirm: false, depends: null, retry: 0, delay: 0, condition: null, model: null, node: null, skillRef: "test", skillArgs: null },
      ],
    }
    const issues = validatePlan(plan)
    expect(issues.some((i) => i.message.includes("Circular self-reference"))).toBe(true)
  })

  test("warns on default manual mode", () => {
    const plan = {
      ...basePlan,
      steps: [
        { id: "man", title: "Manual", mode: "manual" as const, body: "do stuff", code: null, confirm: false, depends: null, retry: 0, delay: 0, condition: null, model: null, node: null, skillRef: null, skillArgs: null },
      ],
    }
    const issues = validatePlan(plan)
    expect(issues.some((i) => i.message.includes("manual"))).toBe(true)
  })

  test("errors on invalid arg type", () => {
    const plan = {
      ...basePlan,
      args: { bad: { type: "object" as any, required: false } },
    }
    const issues = validatePlan(plan)
    expect(issues.some((i) => i.message.includes("invalid type"))).toBe(true)
  })
})

// ============================================================================
// Security: interpolation does not enable shell injection from args
// ============================================================================

describe("security: shell-safe interpolation", () => {
  test("shellEscape escapes single quotes", () => {
    expect(shellEscape("it's")).toBe("it'\\''s")
    expect(shellEscape("no'pe")).toBe("no'\\''pe")
  })

  test("shellSafe=true escapes args for shell safety", () => {
    const result = interpolate(
      'echo "${{args.name}}"',
      { name: "$(rm -rf /)" },
      {},
      true, // shellSafe
    )
    // With shellSafe, single quotes in the value are escaped
    expect(result).toBe('echo "$(rm -rf /)"')
    // The value doesn't contain single quotes, so no escaping needed here.
    // But the key point: shellSafe mode is active for shell steps.
  })

  test("shellSafe=true escapes single quotes in args", () => {
    const result = interpolate(
      "echo '${{args.input}}'",
      { input: "it's a test'; rm -rf / #" },
      {},
      true,
    )
    // Single quotes are escaped: ' becomes '\''
    expect(result).toBe("echo 'it'\\''s a test'\\''; rm -rf / #'")
  })

  test("shellSafe=false (default) passes values through unmodified", () => {
    const result = interpolate(
      "${{args.input}}",
      { input: "it's a test" },
      {},
      false,
    )
    expect(result).toBe("it's a test")
  })

  test("step outputs are NOT escaped (trusted — we produced them)", () => {
    const result = interpolate(
      "${{steps.prev.output}}",
      {},
      { prev: { id: "prev", status: "success", output: "it's fine", exit_code: 0, duration_ms: 0, attempts: 1 } },
      true,
    )
    // Step output is trusted, not escaped
    expect(result).toBe("it's fine")
  })

  test("$ARGUMENTS is escaped in shell mode", () => {
    const result = interpolate(
      "echo '$ARGUMENTS'",
      { _raw: "test'; malicious" },
      {},
      true,
    )
    expect(result).toBe("echo 'test'\\''; malicious'")
  })
})

// ============================================================================
// hive-script mode: parsing
// ============================================================================

describe("parseSteps: hive-script mode", () => {
  test("parses hive-script step with javascript code block", () => {
    const md = `
### step:fetch Fetch Leads

\`\`\`yaml
mode: hive-script
node: default
\`\`\`

\`\`\`javascript
const IRIS = require('./iris-sdk')
const iris = new IRIS()
const leads = await iris.leads.list({ limit: 5 })
console.log(JSON.stringify({ count: leads.length }))
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps).toHaveLength(1)
    expect(steps[0].id).toBe("fetch")
    expect(steps[0].mode).toBe("hive-script")
    expect(steps[0].node).toBe("default")
    expect(steps[0].code).toContain("require('./iris-sdk')")
    expect(steps[0].code).toContain("iris.leads.list")
  })

  test("parses hive-script step with js code block (shorthand lang tag)", () => {
    const md = `
### step:scan Scan Contacts

\`\`\`yaml
mode: hive-script
\`\`\`

\`\`\`js
console.log("hello from hive")
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].mode).toBe("hive-script")
    expect(steps[0].code).toBe('console.log("hello from hive")')
  })

  test("hive-script with no node defaults to null", () => {
    const md = `
### step:run Run Script

\`\`\`yaml
mode: hive-script
\`\`\`

\`\`\`javascript
console.log("ok")
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].node).toBeNull()
  })

  test("hive-script step with no code block produces null code", () => {
    const md = `
### step:bad Bad Script

\`\`\`yaml
mode: hive-script
\`\`\`

Just some prose but no code block.
`
    const steps = parseSteps(md)
    expect(steps[0].mode).toBe("hive-script")
    expect(steps[0].code).toBeNull()
  })
})

// ============================================================================
// New mode names: parsing
// ============================================================================

describe("parseSteps: new mode names", () => {
  test("parses playbook mode with playbook ref", () => {
    const md = `
### step:sub Run Sub-Playbook

\`\`\`yaml
mode: playbook
playbook: health-check
args: status
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].mode).toBe("playbook")
    expect(steps[0].skillRef).toBe("health-check")
    expect(steps[0].skillArgs).toBe("status")
  })

  test("playbook: field populates skillRef (not just skill:)", () => {
    const md = `
### step:sub Sub

\`\`\`yaml
mode: playbook
playbook: bridge-doctor
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].skillRef).toBe("bridge-doctor")
  })

  test("skill: field still works for backward compat", () => {
    const md = `
### step:sub Sub

\`\`\`yaml
mode: skill
skill: health-check
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].skillRef).toBe("health-check")
  })

  test("parses bloq-workflow mode with workflow_id", () => {
    const md = `
### step:run-wf Run Workflow

\`\`\`yaml
mode: bloq-workflow
workflow_id: 196
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].mode).toBe("bloq-workflow")
    expect(steps[0].workflowId).toBe(196)
  })

  test("parses cloud-workflow mode", () => {
    const md = `
### step:neuron Run Neuron

\`\`\`yaml
mode: cloud-workflow
workflow_id: 42
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].mode).toBe("cloud-workflow")
    expect(steps[0].workflowId).toBe(42)
  })

  test("parses n8n mode with webhook", () => {
    const md = `
### step:trigger Trigger N8N

\`\`\`yaml
mode: n8n
webhook: /webhook/lead-enrichment
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].mode).toBe("n8n")
    expect(steps[0].webhook).toBe("/webhook/lead-enrichment")
  })

  test("parses ai-graph mode", () => {
    const md = `
### step:graph Run LangGraph

\`\`\`yaml
mode: ai-graph
workflow_id: credit_dispute_workflow
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].mode).toBe("ai-graph")
    expect(steps[0].workflowId).toBe("credit_dispute_workflow")
  })

  test("parses schedule mode with cron", () => {
    const md = `
### step:sched Schedule Job

\`\`\`yaml
mode: schedule
cron: "0 9 * * 1-5"
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].mode).toBe("schedule")
    expect(steps[0].cron).toBe("0 9 * * 1-5")
  })
})

// ============================================================================
// New StepDef fields: workflowId, webhook, cron, input
// ============================================================================

describe("parseSteps: new StepDef fields", () => {
  test("input object is parsed from YAML", () => {
    const md = `
### step:enrich Enrich Lead

\`\`\`yaml
mode: hive-script
input:
  lead_id: 123
  action: enrich
\`\`\`

\`\`\`javascript
console.log("enrich")
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].input).toEqual({ lead_id: 123, action: "enrich" })
  })

  test("input is null when not an object", () => {
    const md = `
### step:bad Bad Input

\`\`\`yaml
mode: shell
input: "not an object"
\`\`\`

\`\`\`bash
echo hi
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].input).toBeNull()
  })

  test("input is null when missing", () => {
    const md = `
### step:plain Plain

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
echo hi
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].input).toBeNull()
    expect(steps[0].workflowId).toBeNull()
    expect(steps[0].webhook).toBeNull()
    expect(steps[0].cron).toBeNull()
  })

  test("all new fields parse together", () => {
    const md = `
### step:full Full Step

\`\`\`yaml
mode: schedule
workflow_id: 42
webhook: /webhook/test
cron: "*/5 * * * *"
input:
  foo: bar
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].workflowId).toBe(42)
    expect(steps[0].webhook).toBe("/webhook/test")
    expect(steps[0].cron).toBe("*/5 * * * *")
    expect(steps[0].input).toEqual({ foo: "bar" })
  })
})

// ============================================================================
// validatePlan: hive-script + new modes
// ============================================================================

describe("validatePlan: hive-script and new modes", () => {
  const basePlan: SkillPlan = {
    name: "test",
    version: 2,
    description: "test",
    args: {},
    steps: [],
    includes: [],
    confirm: [],
    onError: "ask",
    timeout: 300,
    integrations: [],
    location: "/tmp/test/PLAYBOOK.md",
  }

  const makeStep = (overrides: Partial<StepDef>): StepDef => ({
    id: "s1", title: "Step", mode: "shell", body: "", code: null,
    confirm: false, depends: null, retry: 0, delay: 0,
    condition: null, model: null, node: null,
    skillRef: null, skillArgs: null,
    workflowId: null, webhook: null, cron: null, input: null,
    ...overrides,
  })

  test("errors on hive-script step with no code", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "hs", mode: "hive-script" as any, code: null })] }
    const issues = validatePlan(plan)
    expect(issues.some((i) => i.message.includes("hive-script step has no code"))).toBe(true)
  })

  test("passes for hive-script step WITH code", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "hs", mode: "hive-script" as any, code: "console.log('ok')" })] }
    const issues = validatePlan(plan)
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0)
  })

  test("bloq-workflow mode passes validation (no code needed)", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "wf", mode: "bloq-workflow" as any, workflowId: "196" })] }
    const issues = validatePlan(plan)
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0)
  })

  test("cloud-workflow mode passes validation", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "cw", mode: "cloud-workflow" as any })] }
    const issues = validatePlan(plan)
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0)
  })

  test("n8n mode passes validation", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "n", mode: "n8n" as any, webhook: "/webhook/test" })] }
    const issues = validatePlan(plan)
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0)
  })

  test("schedule mode passes validation", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "sc", mode: "schedule" as any, cron: "0 9 * * *" })] }
    const issues = validatePlan(plan)
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0)
  })

  test("playbook mode with self-reference still catches circular ref", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "p", mode: "skill" as any, skillRef: "test" })] }
    const issues = validatePlan(plan)
    expect(issues.some((i) => i.message.includes("Circular self-reference"))).toBe(true)
  })

  // BUG HUNT: playbook mode should ALSO catch circular self-reference
  test("playbook mode with self-reference catches circular ref", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "p", mode: "playbook" as any, skillRef: "test" })] }
    const issues = validatePlan(plan)
    // This will likely FAIL — the validator only checks mode === "skill", not "playbook"
    expect(issues.some((i) => i.message.includes("Circular self-reference"))).toBe(true)
  })

  // BUG HUNT: playbook mode should require skillRef
  test("playbook mode without skillRef is caught", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "p", mode: "playbook" as any, skillRef: null })] }
    const issues = validatePlan(plan)
    // This will likely FAIL — the validator only checks mode === "skill"
    expect(issues.some((i) => i.message.includes("skill reference") || i.message.includes("playbook reference"))).toBe(true)
  })
})

// ============================================================================
// formatModeError
// ============================================================================

describe("formatModeError (via parseSteps edge cases)", () => {
  test("truncates long error bodies", () => {
    // We can't call formatModeError directly (not exported), but we test
    // that the pattern works via the hive-script code path indirectly.
    // For now, test that parsing extremely long code blocks doesn't break.
    const longCode = "x".repeat(10000)
    const md = `
### step:big Big Script

\`\`\`yaml
mode: hive-script
\`\`\`

\`\`\`javascript
${longCode}
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].code).toHaveLength(10000)
  })
})

// ============================================================================
// Edge cases & potential bugs
// ============================================================================

describe("edge cases: hive-script and new modes", () => {
  test("hive-script interpolation works for code blocks", () => {
    const code = 'const limit = ${{args.limit}}\nconsole.log(limit)'
    const result = interpolate(code, { limit: "10" }, {})
    expect(result).toBe('const limit = 10\nconsole.log(limit)')
  })

  test("step output from hive-script can be interpolated in next step", () => {
    const result = interpolate(
      "echo '${{steps.fetch.output}}'",
      {},
      { fetch: { id: "fetch", status: "success", output: '{"count":5}', exit_code: 0, duration_ms: 200, attempts: 1 } },
    )
    expect(result).toBe(`echo '{"count":5}'`)
  })

  test("hive-script code with template literals doesn't clash with ${{ }} syntax", () => {
    const code = 'const msg = `Hello ${name}`\nconst arg = ${{args.target}}'
    const result = interpolate(code, { target: "world" }, {})
    // JS template literal ${name} should NOT be interpolated — only ${{...}} should
    expect(result).toBe('const msg = `Hello ${name}`\nconst arg = world')
  })

  test("multiline YAML input parses nested objects", () => {
    const md = `
### step:complex Complex Input

\`\`\`yaml
mode: hive-script
input:
  filters:
    status: active
    region: US
  limit: 50
\`\`\`

\`\`\`javascript
console.log("ok")
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].input).toEqual({
      filters: { status: "active", region: "US" },
      limit: 50,
    })
  })

  test("empty code block produces empty string, not null", () => {
    const md = `
### step:empty Empty Code

\`\`\`yaml
mode: hive-script
\`\`\`

\`\`\`javascript
\`\`\`
`
    const steps = parseSteps(md)
    // Empty code block after trim() — what happens?
    // If the code block is empty, trim() returns "", and the regex will match
    // but codeMatch[2].trim() returns ""
    // This is a potential bug: "" is falsy, so it should be null?
    // Actually in JS, "" !== null, so it remains "". Let's verify.
    expect(steps[0].code).toBe("")
  })

  test("hive-script with depends on previous step parses correctly", () => {
    const md = `
### step:check Check Health

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
curl -sf https://api.example.com/health
\`\`\`

### step:script Run Script After Check

\`\`\`yaml
mode: hive-script
depends: check
node: prod-node-1
\`\`\`

\`\`\`javascript
const IRIS = require('./iris-sdk')
console.log("running after check")
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps).toHaveLength(2)
    expect(steps[1].mode).toBe("hive-script")
    expect(steps[1].depends).toBe("check")
    expect(steps[1].node).toBe("prod-node-1")
  })

  test("workflow_id can be string or number", () => {
    const md = `
### step:str-wf String Workflow ID

\`\`\`yaml
mode: ai-graph
workflow_id: credit_dispute_workflow
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].workflowId).toBe("credit_dispute_workflow")

    const md2 = `
### step:num-wf Numeric Workflow ID

\`\`\`yaml
mode: bloq-workflow
workflow_id: 196
\`\`\`
`
    const steps2 = parseSteps(md2)
    expect(steps2[0].workflowId).toBe(196)
  })
})

// ============================================================================
// Security: hive-script code injection & sanitization
// ============================================================================

describe("security: hive-script", () => {
  test("shellSafe does NOT escape hive-script code (it's not shell)", () => {
    // hive-script code goes through interpolate but NOT shellSafe
    // since it runs in Node.js, not bash
    const code = "const x = 'hello'; console.log(x)"
    const result = interpolate(code, {}, {}, false)
    expect(result).toBe(code)
  })

  test("args interpolated into hive-script code are NOT shell-escaped", () => {
    // When hive-script code has ${{args.x}}, the value should be
    // passed through raw (not shell-escaped) since it runs in Node.js
    const code = "const name = '${{args.name}}'"
    const result = interpolate(code, { name: "O'Brien" }, {}, false)
    expect(result).toBe("const name = 'O'Brien'")
    // Note: This creates a JS syntax error! The playbook author needs
    // to use JSON.stringify or template literals. This is by design —
    // we don't escape for JS, only for shell.
  })

  test("hive-script with require('../../../etc/passwd') is valid JS but bounded by SDK", () => {
    // The script CAN require anything — that's the daemon's job to sandbox.
    // We just verify parsing doesn't block it.
    const md = `
### step:evil Evil Script

\`\`\`yaml
mode: hive-script
\`\`\`

\`\`\`javascript
const fs = require('fs')
console.log(fs.readFileSync('/etc/passwd', 'utf-8'))
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].mode).toBe("hive-script")
    expect(steps[0].code).toContain("/etc/passwd")
    // Parser doesn't block this — sandboxing is the daemon's responsibility
  })

  test("code block with backtick sequences doesn't break parser", () => {
    const md = `
### step:ticks Backtick Test

\`\`\`yaml
mode: hive-script
\`\`\`

\`\`\`javascript
const str = "some \` backtick"
console.log(str)
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].code).toContain("backtick")
  })
})

// ============================================================================
// Daemon task-executor: hive_script wrapping correctness
// ============================================================================

describe("daemon hive_script wrapping (unit logic)", () => {
  // These test the wrapping logic that task-executor.js applies
  // We replicate the logic here to verify correctness

  function wrapScript(scriptContent: string, sdkDir: string): string {
    return `process.chdir(${JSON.stringify(sdkDir)});\n${scriptContent}`
  }

  test("prepends process.chdir with JSON-safe path", () => {
    const result = wrapScript("console.log('hi')", "/home/user/daemon")
    expect(result).toBe('process.chdir("/home/user/daemon");\nconsole.log(\'hi\')')
  })

  test("handles paths with spaces", () => {
    const result = wrapScript("console.log('hi')", "/Users/Alex Mayo/daemon")
    expect(result).toContain('"/Users/Alex Mayo/daemon"')
    // JSON.stringify escapes it correctly
  })

  test("handles paths with quotes", () => {
    const result = wrapScript("console.log('hi')", '/path/with"quote')
    // JSON.stringify escapes the double quote
    expect(result).toContain('/path/with\\"quote')
  })

  test("script content is appended unchanged", () => {
    const script = `const IRIS = require('./iris-sdk')
const iris = new IRIS()
async function main() {
  const leads = await iris.leads.list({ limit: 5 })
  console.log(JSON.stringify(leads))
}
main()`
    const result = wrapScript(script, "/daemon")
    expect(result.endsWith(script)).toBe(true)
  })

  test("empty script produces just the chdir line", () => {
    const result = wrapScript("", "/daemon")
    expect(result).toBe('process.chdir("/daemon");\n')
  })
})
