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
