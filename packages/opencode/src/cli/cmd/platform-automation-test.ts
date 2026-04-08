import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  requireUserId,
  printDivider,
  printKV,
  dim,
  bold,
  success,
} from "./iris-api"

// ============================================================================
// V6 Automation end-to-end test runner
//
// Mirrors PHP AutomationTestCommand. The PHP version uses an SDK abstraction;
// here we hit the same endpoints directly so the test surface is identical.
// ============================================================================

interface StepResult {
  success: boolean
  [key: string]: unknown
}

interface TestResults {
  test_mode: string
  success: boolean
  steps?: Record<string, StepResult>
  validations?: Record<string, { expected: boolean; actual: boolean; passed: boolean }>
  duration?: number
  automation_id?: number
  error?: string
}

// ----------------------------------------------------------------------------
// Endpoint helpers — keep these in lockstep with platform-automation.ts
// ----------------------------------------------------------------------------

async function apiCreateAutomation(payload: Record<string, unknown>): Promise<any> {
  const res = await irisFetch("/api/v1/workflows/templates", {
    method: "POST",
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`create failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as any
  return body?.data ?? body
}

async function apiExecute(id: number, inputs: Record<string, unknown> = {}): Promise<any> {
  const res = await irisFetch(`/api/v1/workflows/${id}/execute/v6`, {
    method: "POST",
    body: JSON.stringify({ inputs }),
  })
  if (!res.ok) throw new Error(`execute failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as any
  return body?.data ?? body
}

async function apiStatus(runId: string): Promise<any> {
  const res = await irisFetch(`/api/v1/workflows/runs/${runId}`)
  if (!res.ok) throw new Error(`status failed (HTTP ${res.status})`)
  return (await res.json()) as any
}

async function apiGet(userId: number, automationId: number): Promise<any> {
  const res = await irisFetch(`/api/v1/users/${userId}/workflows/${automationId}`)
  if (!res.ok) throw new Error(`get failed (HTTP ${res.status})`)
  return (await res.json()) as any
}

async function apiList(userId: number): Promise<any> {
  const res = await irisFetch(`/api/v1/users/${userId}/workflows`)
  if (!res.ok) throw new Error(`list failed (HTTP ${res.status})`)
  return (await res.json()) as any
}

async function apiDelete(automationId: number): Promise<void> {
  const res = await irisFetch(`/api/v1/workflows/${automationId}`, { method: "DELETE" })
  if (!res.ok && res.status !== 204) throw new Error(`delete failed (HTTP ${res.status})`)
}

async function waitForCompletion(
  runId: string,
  timeoutSeconds: number,
  intervalSeconds: number,
  onProgress?: (s: any) => void,
): Promise<any> {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() < deadline) {
    const status = await apiStatus(runId)
    onProgress?.(status)
    if (status?.status === "completed" || status?.status === "failed") return status
    await new Promise((r) => setTimeout(r, intervalSeconds * 1000))
  }
  throw new Error(`Timed out after ${timeoutSeconds}s waiting for run ${runId}`)
}

// ----------------------------------------------------------------------------
// Local validation — mirrors PHP AutomationsResource::validate() exactly so we
// don't need a server round-trip for the validate test mode.
// ----------------------------------------------------------------------------

function validateAutomationConfig(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!config.name) errors.push("name is required")
  if (!config.agent_id) errors.push("agent_id is required")
  if (!config.goal) errors.push("goal is required")
  const outcomes = config.outcomes as unknown[] | undefined
  if (!Array.isArray(outcomes) || outcomes.length === 0) {
    errors.push("outcomes array is required")
  } else {
    outcomes.forEach((outcome: any, i) => {
      if (!outcome?.type) errors.push(`outcomes[${i}].type is required`)
      if (!outcome?.description) errors.push(`outcomes[${i}].description is required`)
      if (outcome?.type === "email" && !outcome?.destination?.to) {
        errors.push(`outcomes[${i}].destination.to is required for email outcomes`)
      }
    })
  }
  return { valid: errors.length === 0, errors }
}

// ----------------------------------------------------------------------------
// Test fixture builder
// ----------------------------------------------------------------------------

function buildTestAutomation(agentId: number, testEmail: string): Record<string, unknown> {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19)
  return {
    name: `SDK Test Automation - ${ts}`,
    description: "Automated test created by automation:test command",
    agent_id: agentId,
    goal: `Use the callIntegration tool with integration="gmail" and action="send_email" to send a test email to ${testEmail}. The email should confirm that the V6 automation system is working correctly.`,
    outcomes: [
      {
        type: "email",
        description: "Test email sent via Gmail",
        destination: {
          to: testEmail,
          subject: `V6 Automation SDK Test - ${ts}`,
        },
      },
    ],
    success_criteria: ["Email delivered successfully", "callIntegration tool returned success=true"],
    max_iterations: 10,
  }
}

// ============================================================================
// Test mode runners
// ============================================================================

async function runQuickTest(
  agentId: number,
  testEmail: string,
  noCleanup: boolean,
  log: (line: string) => void,
): Promise<TestResults> {
  const startTime = Date.now()
  const results: TestResults = { test_mode: "quick", success: true, steps: {} }

  // 1. Create
  log(bold("1. Creating test automation"))
  let automation: any
  try {
    automation = await apiCreateAutomation(buildTestAutomation(agentId, testEmail))
    results.steps!.create = { success: true, automation_id: automation.id, name: automation.name }
    log(`  ${success("✓")} Created automation #${automation.id}`)
  } catch (err) {
    results.success = false
    results.steps!.create = { success: false, error: (err as Error).message }
    log(`  ${UI.Style.TEXT_DANGER}✗ ${(err as Error).message}${UI.Style.TEXT_NORMAL}`)
    results.duration = (Date.now() - startTime) / 1000
    return results
  }

  // 2. Execute
  log(bold("2. Executing automation"))
  let run: any
  try {
    run = await apiExecute(automation.id)
    results.steps!.execute = { success: true, run_id: run.run_id, status: run.status }
    log(`  ${success("✓")} Execution started: ${run.run_id}`)
  } catch (err) {
    results.success = false
    results.steps!.execute = { success: false, error: (err as Error).message }
    log(`  ${UI.Style.TEXT_DANGER}✗ ${(err as Error).message}${UI.Style.TEXT_NORMAL}`)
  }

  // 3. Status
  if (run?.run_id) {
    log(bold("3. Checking status"))
    try {
      const status = await apiStatus(run.run_id)
      results.steps!.status = { success: true, status: status.status, progress: status.progress }
      log(`  ${success("✓")} Status: ${status.status} (${status.progress}%)`)
    } catch (err) {
      results.steps!.status = { success: false, error: (err as Error).message }
    }
  }

  // Cleanup
  if (!noCleanup) {
    try {
      await apiDelete(automation.id)
      log(`  ${success("✓")} Cleaned up test automation`)
    } catch (err) {
      log(`  ${UI.Style.TEXT_WARNING ?? UI.Style.TEXT_HIGHLIGHT}⚠ Failed to cleanup: ${(err as Error).message}${UI.Style.TEXT_NORMAL}`)
    }
  }

  results.duration = (Date.now() - startTime) / 1000
  return results
}

async function runFullTest(
  userId: number,
  agentId: number,
  testEmail: string,
  timeout: number,
  noCleanup: boolean,
  log: (line: string) => void,
): Promise<TestResults> {
  const startTime = Date.now()
  const results: TestResults = { test_mode: "full", success: true, steps: {} }

  // 1. Create
  log(bold("1. Creating test automation"))
  let automation: any
  try {
    automation = await apiCreateAutomation(buildTestAutomation(agentId, testEmail))
    results.steps!.create = { success: true, automation_id: automation.id }
    log(`  ${success("✓")} Created automation #${automation.id}`)
  } catch (err) {
    results.success = false
    results.steps!.create = { success: false, error: (err as Error).message }
    return results
  }

  // 2. List - confirm it shows up
  log(bold("2. Listing automations"))
  try {
    const list = await apiList(userId)
    const all = list?.data ?? []
    const found = all.some((a: any) => a.id === automation.id)
    results.steps!.list = { success: found }
    log(found ? `  ${success("✓")} Found in list` : `  ${UI.Style.TEXT_DANGER}✗ Not found in list${UI.Style.TEXT_NORMAL}`)
  } catch (err) {
    results.steps!.list = { success: false, error: (err as Error).message }
  }

  // 3. Execute
  log(bold("3. Executing automation"))
  let run: any
  try {
    run = await apiExecute(automation.id)
    results.steps!.execute = { success: true, run_id: run.run_id }
    log(`  ${success("✓")} Execution started: ${run.run_id}`)
  } catch (err) {
    results.success = false
    results.steps!.execute = { success: false, error: (err as Error).message }
    return results
  }

  // 4. Monitor
  log(bold("4. Monitoring execution"))
  log(`  ${dim(`Waiting up to ${timeout}s…`)}`)
  try {
    const finalStatus = await waitForCompletion(run.run_id, timeout, 2, (status) => {
      const ts = new Date().toISOString().slice(11, 19)
      log(`  ${dim(`[${ts}]`)} ${status.status} - ${status.progress ?? 0}%`)
    })
    const ok = finalStatus.status === "completed"
    results.steps!.monitor = {
      success: ok,
      final_status: finalStatus.status,
      progress: finalStatus.progress,
      iterations: finalStatus?.results?.iterations ?? null,
      outcomes_delivered: finalStatus?.results?.outcomes_delivered ?? [],
    }
    if (ok) log(`  ${success("✓")} Completed`)
    else {
      log(`  ${UI.Style.TEXT_DANGER}✗ Final status: ${finalStatus.status}${UI.Style.TEXT_NORMAL}`)
      results.success = false
    }

    // 5. Verify outcomes
    log(bold("5. Verifying outcomes"))
    const outcomes = finalStatus?.results?.outcomes_delivered ?? []
    results.steps!.outcomes = { success: outcomes.length > 0, count: outcomes.length, outcomes }
    log(`  ${success("✓")} Delivered ${outcomes.length} outcome(s)`)
  } catch (err) {
    results.success = false
    results.steps!.monitor = { success: false, error: (err as Error).message }
    log(`  ${UI.Style.TEXT_DANGER}✗ ${(err as Error).message}${UI.Style.TEXT_NORMAL}`)
  }

  // Cleanup
  if (!noCleanup) {
    try {
      await apiDelete(automation.id)
      log(`  ${success("✓")} Cleaned up test automation`)
    } catch (err) {
      log(`  ⚠ Failed to cleanup: ${(err as Error).message}`)
    }
  }

  results.duration = (Date.now() - startTime) / 1000
  return results
}

async function runCreateOnlyTest(
  agentId: number,
  testEmail: string,
  log: (line: string) => void,
): Promise<TestResults> {
  const results: TestResults = { test_mode: "create-only", success: true, steps: {} }

  log(bold("Creating test automation"))
  try {
    const automation = await apiCreateAutomation(buildTestAutomation(agentId, testEmail))
    results.steps!.create = {
      success: true,
      automation_id: automation.id,
      name: automation.name,
      agent_id: automation.agent_id,
      execution_mode: automation.execution_mode,
    }
    log(`  ${success("✓")} Created automation #${automation.id}`)
  } catch (err) {
    results.success = false
    results.steps!.create = { success: false, error: (err as Error).message }
    log(`  ${UI.Style.TEXT_DANGER}✗ ${(err as Error).message}${UI.Style.TEXT_NORMAL}`)
  }

  return results
}

async function runExistingTest(
  userId: number,
  automationId: number,
  timeout: number,
  log: (line: string) => void,
): Promise<TestResults> {
  const results: TestResults = {
    test_mode: "existing",
    automation_id: automationId,
    success: true,
    steps: {},
  }

  // 1. Get
  log(bold(`1. Getting automation #${automationId}`))
  try {
    const automation = await apiGet(userId, automationId)
    const a = automation?.data ?? automation
    results.steps!.get = { success: true, name: a.name, agent_id: a.agent_id }
    log(`  ${success("✓")} Found: ${a.name}`)
  } catch (err) {
    results.success = false
    results.steps!.get = { success: false, error: (err as Error).message }
    return results
  }

  // 2. Execute
  log(bold("2. Executing automation"))
  let run: any
  try {
    run = await apiExecute(automationId)
    results.steps!.execute = { success: true, run_id: run.run_id }
    log(`  ${success("✓")} Execution started: ${run.run_id}`)
  } catch (err) {
    results.success = false
    results.steps!.execute = { success: false, error: (err as Error).message }
    return results
  }

  // 3. Monitor
  log(bold("3. Monitoring execution"))
  try {
    const finalStatus = await waitForCompletion(run.run_id, timeout, 2, (status) => {
      const ts = new Date().toISOString().slice(11, 19)
      log(`  ${dim(`[${ts}]`)} ${status.status} - ${status.progress ?? 0}%`)
    })
    const ok = finalStatus.status === "completed"
    results.steps!.monitor = {
      success: ok,
      final_status: finalStatus.status,
      outcomes_delivered: (finalStatus?.results?.outcomes_delivered ?? []).length,
    }
    if (!ok) results.success = false
  } catch (err) {
    results.success = false
    results.steps!.monitor = { success: false, error: (err as Error).message }
  }

  return results
}

async function runValidationTest(log: (line: string) => void): Promise<TestResults> {
  const results: TestResults = { test_mode: "validate", success: true, validations: {} }

  log(bold("Running validation tests"))

  // Test 1: Valid config should pass
  const valid = validateAutomationConfig({
    name: "Valid Test",
    agent_id: 55,
    goal: "Test goal",
    outcomes: [{ type: "email", description: "Test", destination: { to: "test@example.com" } }],
  })
  results.validations!.valid_config = { expected: true, actual: valid.valid, passed: valid.valid === true }
  log(valid.valid ? `  ${success("✓")} Valid config test passed` : `  ${UI.Style.TEXT_DANGER}✗ Valid config test failed${UI.Style.TEXT_NORMAL}`)

  // Test 2: Missing name should fail
  const missingName = validateAutomationConfig({
    agent_id: 55,
    goal: "Test",
    outcomes: [{ type: "email", description: "x" }],
  })
  results.validations!.missing_name = {
    expected: false,
    actual: missingName.valid,
    passed: missingName.valid === false,
  }
  log(
    !missingName.valid
      ? `  ${success("✓")} Missing name validation passed`
      : `  ${UI.Style.TEXT_DANGER}✗ Missing name validation failed${UI.Style.TEXT_NORMAL}`,
  )

  // Test 3: Missing outcome description should fail
  const missingDesc = validateAutomationConfig({
    name: "Test",
    agent_id: 55,
    goal: "Test",
    outcomes: [{ type: "email" }],
  })
  results.validations!.invalid_outcomes = {
    expected: false,
    actual: missingDesc.valid,
    passed: missingDesc.valid === false,
  }
  log(
    !missingDesc.valid
      ? `  ${success("✓")} Invalid outcomes validation passed`
      : `  ${UI.Style.TEXT_DANGER}✗ Invalid outcomes validation failed${UI.Style.TEXT_NORMAL}`,
  )

  results.success = Object.values(results.validations!).every((v) => v.passed)
  return results
}

// ============================================================================
// Display
// ============================================================================

function displayResults(results: TestResults): void {
  console.log()
  printDivider()
  console.log(`  ${bold("Test Results")}`)
  if (results.success) {
    console.log(`  ${success("✓")} All tests passed`)
  } else {
    console.log(`  ${UI.Style.TEXT_DANGER}✗ Some tests failed${UI.Style.TEXT_NORMAL}`)
  }

  if (results.steps) {
    console.log()
    console.log(`  ${dim("Step Results:")}`)
    for (const [step, data] of Object.entries(results.steps)) {
      const icon = data.success ? success("✓") : `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}`
      console.log(`  ${icon} ${step}`)
      if (!data.success && data.error) console.log(`     ${dim(`Error: ${data.error}`)}`)
    }
  }

  if (results.validations) {
    console.log()
    console.log(`  ${dim("Validation Results:")}`)
    for (const [name, data] of Object.entries(results.validations)) {
      const icon = data.passed ? success("✓") : `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}`
      console.log(`  ${icon} ${name}`)
    }
  }

  if (results.duration !== undefined) {
    console.log()
    console.log(`  ${dim(`Duration: ${results.duration.toFixed(2)}s`)}`)
  }
  printDivider()
}

// ============================================================================
// Root command
// ============================================================================

export const PlatformAutomationTestCommand = cmd({
  command: "automation:test",
  aliases: ["automation-test"],
  describe: "test and evaluate V6 Automations end-to-end",
  builder: (yargs) =>
    yargs
      .option("mode", {
        describe: "test mode (quick, full, create-only, existing, validate)",
        choices: ["quick", "full", "create-only", "existing", "validate"] as const,
      })
      .option("quick", { describe: "quick smoke test", type: "boolean", default: false })
      .option("full", { describe: "full integration test", type: "boolean", default: false })
      .option("create-only", { describe: "test creation only", type: "boolean", default: false })
      .option("automation-id", { describe: "test an existing automation by ID", type: "number" })
      .option("agent-id", { describe: "agent ID to use for created tests", type: "number", default: 55 })
      .option("test-email", { describe: "email address for test", type: "string", default: "test@freelabel.net" })
      .option("no-cleanup", { describe: "do not delete test automation after run", type: "boolean", default: false })
      .option("timeout", { describe: "timeout in seconds", type: "number", default: 60 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId()
    if (!userId) return

    // Mode resolution — flags override --mode arg, --automation-id implies "existing"
    let mode: string
    if (args.quick) mode = "quick"
    else if (args.full) mode = "full"
    else if (args["create-only"]) mode = "create-only"
    else if (args["automation-id"]) mode = "existing"
    else mode = (args.mode as string) ?? "quick"

    if (!args.json) {
      UI.empty()
      prompts.intro(`◈  V6 Automation Test — mode: ${mode}`)
    }

    const lines: string[] = []
    const log = (line: string) => {
      if (args.json) lines.push(line)
      else console.log(line)
    }

    let results: TestResults
    try {
      switch (mode) {
        case "quick":
          results = await runQuickTest(
            args["agent-id"] as number,
            args["test-email"] as string,
            args["no-cleanup"] as boolean,
            log,
          )
          break
        case "full":
          results = await runFullTest(
            userId,
            args["agent-id"] as number,
            args["test-email"] as string,
            args.timeout as number,
            args["no-cleanup"] as boolean,
            log,
          )
          break
        case "create-only":
          results = await runCreateOnlyTest(
            args["agent-id"] as number,
            args["test-email"] as string,
            log,
          )
          break
        case "existing":
          results = await runExistingTest(
            userId,
            args["automation-id"] as number,
            args.timeout as number,
            log,
          )
          break
        case "validate":
          results = await runValidationTest(log)
          break
        default:
          throw new Error(`Unknown test mode: ${mode}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results = { test_mode: mode, success: false, error: msg }
      if (args.json) {
        console.log(JSON.stringify(results, null, 2))
      } else {
        prompts.log.error(`Test failed: ${msg}`)
      }
      process.exitCode = 1
      return
    }

    if (args.json) {
      console.log(JSON.stringify(results, null, 2))
    } else {
      displayResults(results)
      prompts.outro(results.success ? "Done" : "Failed")
    }

    if (!results.success) process.exitCode = 1
  },
})
