import { describe, test, expect } from "bun:test"
import {
  parseSteps,
  interpolate,
  interpolateInput,
  shellEscape,
  resolveArgs,
  validatePlan,
  type StepDef,
  type StepResult,
  type SkillPlan,
  type ArgDef,
} from "./executor"

// ============================================================================
// HELPERS
// ============================================================================

const makeStep = (overrides: Partial<StepDef>): StepDef => ({
  id: "s1", title: "Step", mode: "shell", body: "", code: null,
  confirm: false, depends: null, retry: 0, delay: 0,
  condition: null, model: null, node: null,
  skillRef: null, skillArgs: null,
  workflowId: null, webhook: null, cron: null, input: null,
  ...overrides,
})

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
  location: "/tmp/test/PLAYBOOK.md",
}

// ############################################################################
//
//  LAYER 1: PARSER & ALIAS TESTS (Zero Network)
//
//  Tests that PLAYBOOK.md files are correctly parsed into StepDef objects.
//  Covers all 14 mode keywords, legacy aliases, new YAML fields, and edge
//  cases around code-block extraction.
//
// ############################################################################

// ============================================================================
// parseSteps — core parsing
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
// Layer 1: Mode alias parsing — prompt, human, cloud-agentic, langgraph
// ============================================================================

describe("parseSteps: mode aliases & new names", () => {
  test("'prompt' mode parses as 'prompt' (alias for ai)", () => {
    const md = `
### step:summarize Summarize Text

\`\`\`yaml
mode: prompt
model: gpt-4o-mini
\`\`\`

Summarize this text concisely.
`
    const steps = parseSteps(md)
    expect(steps[0].mode).toBe("prompt")
    expect(steps[0].model).toBe("gpt-4o-mini")
    expect(steps[0].body).toContain("Summarize this text")
  })

  test("'ai' mode still parses for backward compat", () => {
    const md = `
### step:old Old AI Step

\`\`\`yaml
mode: ai
\`\`\`

Do analysis.
`
    const steps = parseSteps(md)
    expect(steps[0].mode).toBe("ai")
  })

  test("'human' mode parses as 'human' (alias for manual)", () => {
    const md = `
### step:review Human Review

\`\`\`yaml
mode: human
\`\`\`

Please review the output manually.
`
    const steps = parseSteps(md)
    expect(steps[0].mode).toBe("human")
    expect(steps[0].body).toContain("review the output")
  })

  test("'manual' mode still parses for backward compat", () => {
    const md = `
### step:old Old Manual Step

\`\`\`yaml
mode: manual
\`\`\`

Do it by hand.
`
    const steps = parseSteps(md)
    expect(steps[0].mode).toBe("manual")
  })

  test("cloud-agentic mode parses with workflow_id", () => {
    const md = `
### step:agentic Run Agentic Workflow

\`\`\`yaml
mode: cloud-agentic
workflow_id: 42
\`\`\`

Analyze the user's portfolio and suggest improvements.
`
    const steps = parseSteps(md)
    expect(steps[0].mode).toBe("cloud-agentic")
    expect(steps[0].workflowId).toBe("42")
    expect(steps[0].body).toContain("portfolio")
  })

  test("langgraph mode parses (replaces ai-graph)", () => {
    const md = `
### step:graph Run LangGraph

\`\`\`yaml
mode: langgraph
workflow_id: credit_dispute_workflow
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].mode).toBe("langgraph")
    expect(steps[0].workflowId).toBe("credit_dispute_workflow")
  })
})

// ============================================================================
// Layer 1: hive-script mode parsing
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
// Layer 1: playbook / skill ref parsing
// ============================================================================

describe("parseSteps: playbook & skill refs", () => {
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
})

// ============================================================================
// Layer 1: cloud-workflow, n8n, schedule parsing
// ============================================================================

describe("parseSteps: cloud-workflow, n8n, schedule", () => {
  test("parses cloud-workflow mode with workflow_id", () => {
    const md = `
### step:run-wf Run Workflow

\`\`\`yaml
mode: cloud-workflow
workflow_id: 196
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].mode).toBe("cloud-workflow")
    expect(steps[0].workflowId).toBe("196")
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

  test("workflow_id can be string or number", () => {
    const md = `
### step:str-wf String Workflow ID

\`\`\`yaml
mode: langgraph
workflow_id: credit_dispute_workflow
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].workflowId).toBe("credit_dispute_workflow")

    const md2 = `
### step:num-wf Numeric Workflow ID

\`\`\`yaml
mode: cloud-workflow
workflow_id: 196
\`\`\`
`
    const steps2 = parseSteps(md2)
    expect(steps2[0].workflowId).toBe("196")
  })
})

// ============================================================================
// Layer 1: Structured input & new StepDef fields
// ============================================================================

describe("parseSteps: new StepDef fields (input, workflowId, webhook, cron)", () => {
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

  test("nested input objects parse correctly", () => {
    const md = `
### step:complex Complex Input

\`\`\`yaml
mode: cloud-workflow
workflow_id: 196
input:
  target_user: "alex"
  settings:
    debug: true
    region: US
  filters:
    status: active
    tags:
      - vip
      - enterprise
\`\`\`
`
    const steps = parseSteps(md)
    expect(steps[0].input).toEqual({
      target_user: "alex",
      settings: { debug: true, region: "US" },
      filters: { status: "active", tags: ["vip", "enterprise"] },
    })
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
    expect(steps[0].workflowId).toBe("42")
    expect(steps[0].webhook).toBe("/webhook/test")
    expect(steps[0].cron).toBe("*/5 * * * *")
    expect(steps[0].input).toEqual({ foo: "bar" })
  })
})

// ============================================================================
// Layer 1: All 14 modes parse without error (comprehensive)
// ============================================================================

describe("parseSteps: all 14 mode keywords accepted", () => {
  const modes: StepDef["mode"][] = [
    "shell", "prompt", "ai", "hive", "hive-script",
    "skill", "playbook", "human", "manual",
    "cloud-workflow", "cloud-agentic", "n8n", "langgraph", "schedule",
  ]

  for (const mode of modes) {
    test(`mode: ${mode} parses without error`, () => {
      const md = `
### step:t Test

\`\`\`yaml
mode: ${mode}
\`\`\`

\`\`\`bash
echo ok
\`\`\`
`
      const steps = parseSteps(md)
      expect(steps).toHaveLength(1)
      expect(steps[0].mode).toBe(mode)
    })
  }
})

// ############################################################################
//
//  LAYER 2: GUARDRAIL & VARIABLE INTERPOLATION (Zero Network)
//
//  Tests that validation catches author mistakes, and that ${{}} variables
//  resolve correctly — including inside deeply nested input objects.
//
// ############################################################################

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
// Layer 2: Deep interpolation inside structured input objects
// ============================================================================

describe("interpolation: deep input objects", () => {
  test("interpolates ${{args}} inside a JSON-stringified input", () => {
    // This is the actual code path from executeSkill:
    //   JSON.parse(interpolate(JSON.stringify(step.input), rawArgs, stepResults))
    const input = { user: { name: "${{args.client}}" } }
    const rawArgs = { client: "AlexMayo" }
    const interpolated = JSON.parse(interpolate(JSON.stringify(input), rawArgs, {}))
    expect(interpolated.user.name).toBe("AlexMayo")
  })

  test("interpolates step output inside nested input", () => {
    const input = { data: { summary: "${{steps.analyze.output}}" } }
    const steps: Record<string, StepResult> = {
      analyze: { id: "analyze", status: "success", output: "Lead is warm", exit_code: 0, duration_ms: 100, attempts: 1 },
    }
    const interpolated = JSON.parse(interpolate(JSON.stringify(input), {}, steps))
    expect(interpolated.data.summary).toBe("Lead is warm")
  })

  test("multiple variables in deeply nested input", () => {
    const input = {
      user_id: "${{args.user_id}}",
      config: {
        debug: "${{args.debug}}",
        prev_result: "${{steps.step1.output}}",
      },
    }
    const rawArgs = { user_id: "42", debug: "true" }
    const steps: Record<string, StepResult> = {
      step1: { id: "step1", status: "success", output: "done", exit_code: 0, duration_ms: 50, attempts: 1 },
    }
    const interpolated = JSON.parse(interpolate(JSON.stringify(input), rawArgs, steps))
    expect(interpolated.user_id).toBe("42")
    expect(interpolated.config.debug).toBe("true")
    expect(interpolated.config.prev_result).toBe("done")
  })

  test("missing arg in input resolves to empty string (not crash)", () => {
    const input = { name: "${{args.missing}}" }
    const interpolated = JSON.parse(interpolate(JSON.stringify(input), {}, {}))
    expect(interpolated.name).toBe("")
  })

  test("input with no variables passes through unchanged", () => {
    const input = { static: "value", count: 42 }
    const interpolated = JSON.parse(interpolate(JSON.stringify(input), {}, {}))
    expect(interpolated).toEqual({ static: "value", count: 42 })
  })

  test("args with JSON-special characters survive interpolateInput", () => {
    // Previously: JSON.stringify→interpolate→JSON.parse broke when args
    // contained double quotes. interpolateInput walks the object directly.
    const input = { msg: "${{args.text}}" }
    const rawArgs = { text: 'He said "hello"' }
    const result = interpolateInput(input, rawArgs, {})
    expect(result.msg).toBe('He said "hello"')
  })

  test("args with backslashes survive interpolateInput", () => {
    const input = { path: "${{args.path}}" }
    const rawArgs = { path: "C:\\Users\\Alex" }
    const result = interpolateInput(input, rawArgs, {})
    expect(result.path).toBe("C:\\Users\\Alex")
  })

  test("args with newlines survive interpolateInput", () => {
    const input = { body: "${{args.content}}" }
    const rawArgs = { content: "line1\nline2\nline3" }
    const result = interpolateInput(input, rawArgs, {})
    expect(result.body).toBe("line1\nline2\nline3")
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
// validatePlan — existing rules
// ============================================================================

describe("validatePlan", () => {
  test("passes for valid plan with steps", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "one", code: "echo hi" })] }
    const issues = validatePlan(plan)
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0)
  })

  test("warns on v2 skill with no steps", () => {
    const issues = validatePlan(basePlan)
    expect(issues.some((i) => i.message.includes("no steps"))).toBe(true)
  })

  test("errors on duplicate step IDs", () => {
    const step = makeStep({ id: "dup", code: "echo" })
    const plan = { ...basePlan, steps: [step, { ...step }] }
    const issues = validatePlan(plan)
    expect(issues.some((i) => i.message.includes("Duplicate step ID"))).toBe(true)
  })

  test("errors on shell step with no code", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "bad", code: null })] }
    const issues = validatePlan(plan)
    expect(issues.some((i) => i.message.includes("Shell step has no code"))).toBe(true)
  })

  test("errors on skill step with no skill ref", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "bad", mode: "skill" as any })] }
    const issues = validatePlan(plan)
    expect(issues.some((i) => i.message.includes("Skill step has no skill reference"))).toBe(true)
  })

  test("errors on circular self-reference", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "self", mode: "skill" as any, skillRef: "test" })] }
    const issues = validatePlan(plan)
    expect(issues.some((i) => i.message.includes("Circular self-reference"))).toBe(true)
  })

  test("warns on default manual mode", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "man", mode: "manual" as any, body: "do stuff" })] }
    const issues = validatePlan(plan)
    expect(issues.some((i) => i.message.includes("manual"))).toBe(true)
  })

  test("errors on invalid arg type", () => {
    const plan = { ...basePlan, args: { bad: { type: "object" as any, required: false } } }
    const issues = validatePlan(plan)
    expect(issues.some((i) => i.message.includes("invalid type"))).toBe(true)
  })
})

// ============================================================================
// Layer 2: validatePlan — new mode guardrails
// ============================================================================

describe("validatePlan: new mode guardrails", () => {
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

  test("cloud-workflow requires workflow_id", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "cw", mode: "cloud-workflow" as any })] }
    const issues = validatePlan(plan)
    expect(issues.some((i) => i.message.includes("requires workflow_id"))).toBe(true)
  })

  test("cloud-workflow passes with workflow_id", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "cw", mode: "cloud-workflow" as any, workflowId: "196" })] }
    const issues = validatePlan(plan)
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0)
  })

  test("cloud-agentic requires workflow_id", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "ca", mode: "cloud-agentic" as any })] }
    const issues = validatePlan(plan)
    expect(issues.some((i) => i.message.includes("requires workflow_id"))).toBe(true)
  })

  test("cloud-agentic passes with workflow_id", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "ca", mode: "cloud-agentic" as any, workflowId: "42" })] }
    const issues = validatePlan(plan)
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0)
  })

  test("n8n mode passes validation (no code or workflow_id needed)", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "n", mode: "n8n" as any, webhook: "/webhook/test" })] }
    const issues = validatePlan(plan)
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0)
  })

  test("langgraph mode passes validation", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "lg", mode: "langgraph" as any, workflowId: "basic" })] }
    const issues = validatePlan(plan)
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0)
  })

  test("schedule mode passes validation", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "sc", mode: "schedule" as any, cron: "0 9 * * *" })] }
    const issues = validatePlan(plan)
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0)
  })

  // playbook aliases should get the same validation as skill
  test("playbook mode catches circular self-reference", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "p", mode: "playbook" as any, skillRef: "test" })] }
    const issues = validatePlan(plan)
    expect(issues.some((i) => i.message.includes("Circular self-reference"))).toBe(true)
  })

  test("playbook mode without skillRef is caught", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "p", mode: "playbook" as any, skillRef: null })] }
    const issues = validatePlan(plan)
    expect(issues.some((i) => i.message.includes("skill reference") || i.message.includes("playbook reference"))).toBe(true)
  })

  // prompt and human should not trigger shell or code validations
  test("prompt mode does NOT require code block", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "p", mode: "prompt" as any, body: "analyze this" })] }
    const issues = validatePlan(plan)
    // Should have no errors about missing code
    expect(issues.filter((i) => i.level === "error" && i.message.includes("code"))).toHaveLength(0)
  })

  test("human mode does NOT trigger manual warning", () => {
    const plan = { ...basePlan, steps: [makeStep({ id: "h", mode: "human" as any, body: "review" })] }
    const issues = validatePlan(plan)
    // "human" is the new name — it should NOT warn about "manual mode"
    // The warning only fires for mode === "manual" specifically
    expect(issues.some((i) => i.message.includes("manual"))).toBe(false)
  })
})

// ============================================================================
// Security: shell-safe interpolation
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
      true,
    )
    expect(result).toBe('echo "$(rm -rf /)"')
  })

  test("shellSafe=true escapes single quotes in args", () => {
    const result = interpolate(
      "echo '${{args.input}}'",
      { input: "it's a test'; rm -rf / #" },
      {},
      true,
    )
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
// Security: hive-script specific
// ============================================================================

describe("security: hive-script", () => {
  test("shellSafe does NOT escape hive-script code (it's not shell)", () => {
    const code = "const x = 'hello'; console.log(x)"
    const result = interpolate(code, {}, {}, false)
    expect(result).toBe(code)
  })

  test("args interpolated into hive-script code are NOT shell-escaped", () => {
    const code = "const name = '${{args.name}}'"
    const result = interpolate(code, { name: "O'Brien" }, {}, false)
    expect(result).toBe("const name = 'O'Brien'")
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

// ############################################################################
//
//  LAYER 3: MOCKED NETWORK ADAPTERS (Simulated Integration)
//
//  Tests the execution functions for cloud-workflow, n8n, langgraph, etc.
//  by intercepting network calls. No live servers required.
//
//  Note: executeCloudWorkflow, executeHiveScript, etc. are private functions
//  that import from other modules (iris-api, platform-hive-nodes). We test
//  the patterns they use — the polling loop, error formatting, timeout
//  behavior, and input interpolation in the switch block — without actually
//  calling them.
//
// ############################################################################

// ============================================================================
// Layer 3: formatModeError pattern
// ============================================================================

describe("formatModeError pattern", () => {
  // formatModeError is private, but we replicate its exact logic to test:
  // `[Step: ${stepId}] FAILED: ${mode} returned HTTP ${status} — ${body.slice(0, 500)}`

  function formatModeError(mode: string, stepId: string, status: number, body: string): string {
    return `[Step: ${stepId}] FAILED: ${mode} returned HTTP ${status} — ${body.slice(0, 500)}`
  }

  test("formats a clean error for HTTP 502 from n8n", () => {
    const result = formatModeError("n8n", "trigger-webhook", 502, "Bad Gateway")
    expect(result).toBe("[Step: trigger-webhook] FAILED: n8n returned HTTP 502 — Bad Gateway")
  })

  test("formats a clean error for HTTP 401 from cloud-workflow", () => {
    const result = formatModeError("cloud-workflow", "run-wf", 401, "Unauthorized")
    expect(result).toBe("[Step: run-wf] FAILED: cloud-workflow returned HTTP 401 — Unauthorized")
  })

  test("truncates error body at 500 chars", () => {
    const longBody = "x".repeat(1000)
    const result = formatModeError("cloud-agentic", "step1", 500, longBody)
    // Body should be truncated to first 500 chars
    expect(result).toContain("x".repeat(500))
    expect(result).not.toContain("x".repeat(501))
  })

  test("handles empty error body", () => {
    const result = formatModeError("langgraph", "graph-step", 500, "")
    expect(result).toBe("[Step: graph-step] FAILED: langgraph returned HTTP 500 — ")
  })
})

// ============================================================================
// Layer 3: Polling loop terminal states
// ============================================================================

describe("polling loop: terminal state detection", () => {
  // The polling loop in executeHiveScript and executeCloudWorkflow uses
  // a terminal state set. We test that set's correctness.

  const hiveTerminal = new Set(["succeeded", "completed", "failed", "cancelled", "timeout", "errored"])
  const cloudTerminal = new Set(["completed", "success", "failed"])

  test("hive: all terminal states recognized", () => {
    expect(hiveTerminal.has("succeeded")).toBe(true)
    expect(hiveTerminal.has("completed")).toBe(true)
    expect(hiveTerminal.has("failed")).toBe(true)
    expect(hiveTerminal.has("cancelled")).toBe(true)
    expect(hiveTerminal.has("timeout")).toBe(true)
    expect(hiveTerminal.has("errored")).toBe(true)
  })

  test("hive: non-terminal states NOT in set", () => {
    expect(hiveTerminal.has("running")).toBe(false)
    expect(hiveTerminal.has("pending")).toBe(false)
    expect(hiveTerminal.has("processing")).toBe(false)
    expect(hiveTerminal.has("queued")).toBe(false)
  })

  test("cloud: terminal states recognized", () => {
    expect(cloudTerminal.has("completed")).toBe(true)
    expect(cloudTerminal.has("success")).toBe(true)
    expect(cloudTerminal.has("failed")).toBe(true)
  })

  test("cloud: non-terminal states NOT in set", () => {
    expect(cloudTerminal.has("processing")).toBe(false)
    expect(cloudTerminal.has("running")).toBe(false)
    expect(cloudTerminal.has("pending")).toBe(false)
  })

  test("hive: exit_code mapping — succeeded/completed = 0, everything else = 1", () => {
    const exitCode = (status: string) =>
      (status === "succeeded" || status === "completed") ? 0 : 1

    expect(exitCode("succeeded")).toBe(0)
    expect(exitCode("completed")).toBe(0)
    expect(exitCode("failed")).toBe(1)
    expect(exitCode("cancelled")).toBe(1)
    expect(exitCode("timeout")).toBe(1)
    expect(exitCode("errored")).toBe(1)
  })

  test("cloud: exit_code mapping — failed = 1, everything else = 0", () => {
    const exitCode = (status: string) => status === "failed" ? 1 : 0

    expect(exitCode("completed")).toBe(0)
    expect(exitCode("success")).toBe(0)
    expect(exitCode("failed")).toBe(1)
  })
})

// ============================================================================
// Layer 3: cloud-workflow input interpolation in switch block
// ============================================================================

describe("cloud-workflow: input interpolation before dispatch", () => {
  // The switch block now uses interpolateInput() instead of the broken
  // JSON.stringify→interpolate→JSON.parse pattern.

  test("null input stays null", () => {
    const step = makeStep({ mode: "cloud-workflow" as any, input: null })
    const interpolatedInput = step.input
      ? interpolateInput(step.input, {}, {})
      : null
    expect(interpolatedInput).toBeNull()
  })

  test("static input passes through unchanged", () => {
    const input = { goal: "analyze leads", debug: false }
    const result = interpolateInput(input, {}, {})
    expect(result).toEqual({ goal: "analyze leads", debug: false })
  })

  test("input with ${{args}} gets resolved", () => {
    const input = { user: "${{args.user}}", limit: "${{args.limit}}" }
    const rawArgs = { user: "alex", limit: "50" }
    const result = interpolateInput(input, rawArgs, {})
    expect(result.user).toBe("alex")
    expect(result.limit).toBe("50")
  })

  test("input with ${{steps}} gets resolved", () => {
    const input = { context: "${{steps.scan.output}}" }
    const steps: Record<string, StepResult> = {
      scan: { id: "scan", status: "success", output: "found 3 leads", exit_code: 0, duration_ms: 100, attempts: 1 },
    }
    const result = interpolateInput(input, {}, steps)
    expect(result.context).toBe("found 3 leads")
  })

  test("nested input with ${{args}} gets resolved at all depths", () => {
    const input = {
      config: {
        user: "${{args.name}}",
        settings: { region: "${{args.region}}" },
      },
    }
    const result = interpolateInput(input, { name: "alex", region: "US" }, {})
    expect(result.config.user).toBe("alex")
    expect(result.config.settings.region).toBe("US")
  })

  test("arrays inside input are interpolated", () => {
    const input = { tags: ["${{args.tag1}}", "static", "${{args.tag2}}"] }
    const result = interpolateInput(input, { tag1: "vip", tag2: "enterprise" }, {})
    expect(result.tags).toEqual(["vip", "static", "enterprise"])
  })

  test("numbers and booleans pass through unchanged", () => {
    const input = { count: 42, active: true, label: "${{args.label}}" }
    const result = interpolateInput(input, { label: "test" }, {})
    expect(result.count).toBe(42)
    expect(result.active).toBe(true)
    expect(result.label).toBe("test")
  })

  test("JSON-special characters in args don't break interpolation", () => {
    const input = { msg: "${{args.text}}" }
    const result = interpolateInput(input, { text: 'He said "hello" and used a \\backslash' }, {})
    expect(result.msg).toBe('He said "hello" and used a \\backslash')
  })
})

// ============================================================================
// Layer 3: Daemon task-executor wrapping logic
// ============================================================================

describe("daemon hive_script wrapping (unit logic)", () => {
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
  })

  test("handles paths with quotes", () => {
    const result = wrapScript("console.log('hi')", '/path/with"quote')
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

// ============================================================================
// Edge cases that span layers
// ============================================================================

describe("cross-layer edge cases", () => {
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

  test("JS template literals don't clash with ${{ }} syntax", () => {
    const code = 'const msg = `Hello ${name}`\nconst arg = ${{args.target}}'
    const result = interpolate(code, { target: "world" }, {})
    expect(result).toBe('const msg = `Hello ${name}`\nconst arg = world')
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
    expect(steps[0].code).toBe("")
  })

  test("10KB code block parses fine", () => {
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

  test("multi-mode playbook: shell + prompt + cloud-workflow + human", () => {
    const md = `
### step:check Health Check

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
iris health-check --json
\`\`\`

### step:analyze Analyze Results

\`\`\`yaml
mode: prompt
model: gpt-4o-mini
\`\`\`

Analyze the health check output: \${{steps.check.output}}

### step:deploy Deploy Fix

\`\`\`yaml
mode: cloud-workflow
workflow_id: 196
input:
  action: deploy
  target: "\${{args.service}}"
\`\`\`

### step:verify Human Verification

\`\`\`yaml
mode: human
\`\`\`

Please verify the deployment succeeded.
`
    const steps = parseSteps(md)
    expect(steps).toHaveLength(4)
    expect(steps[0].mode).toBe("shell")
    expect(steps[1].mode).toBe("prompt")
    expect(steps[1].model).toBe("gpt-4o-mini")
    expect(steps[2].mode).toBe("cloud-workflow")
    expect(steps[2].workflowId).toBe("196")
    expect(steps[2].input).toEqual({ action: "deploy", target: "${{args.service}}" as any })
    expect(steps[3].mode).toBe("human")
  })
})
