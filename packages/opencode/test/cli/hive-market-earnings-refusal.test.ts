import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText } from "ai"
import { formatPaymentRequired } from "../../src/cli/cmd/iris-api"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRetry } from "../../src/session/retry"

/**
 * #193080: a debit that would spend a seller's protected marketplace earnings is refused with
 * HTTP 402, code EARNINGS_PROTECTED — by fl-api as a flat body, by the IRIS gateway as an
 * OpenAI-style {error:{…}}. Either way the person reads one sentence and the command, never JSON,
 * and the session loop does not retry it.
 */

const SENTENCE =
  "This would use your marketplace earnings ($20.40). Run `iris hive market earnings --allow-spending` to allow it, or add credits."

describe("a refused debit, EARNINGS_PROTECTED", () => {
  test("fl-api's 402 body reads as its sentence and the command", () => {
    const { message, details } = formatPaymentRequired({
      success: false, status: 402, error: "EARNINGS_PROTECTED", code: "EARNINGS_PROTECTED", message: SENTENCE,
      cli_command: "iris hive market earnings --allow-spending", cost: 50, balance: 2040, spendable: 0, protected_earnings_cents: 2040,
    })
    expect(message).toBe(SENTENCE)
    expect(details.join("\n")).toContain("iris hive market earnings --allow-spending")
    expect(details.join("\n")).not.toContain("EARNINGS_PROTECTED")
  })

  test("the gateway's nested OpenAI-style body does not crash the formatter", () => {
    const { message } = formatPaymentRequired({ error: { message: SENTENCE, code: "EARNINGS_PROTECTED", cli_command: "iris hive market earnings --allow-spending" } })
    expect(message).toBe(SENTENCE)
  })
})

describe("iris run against a refused marketplace machine", () => {
  let server: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { error: { message: SENTENCE, type: "EARNINGS_PROTECTED", code: "EARNINGS_PROTECTED", party: "iris", retryable: false, cli_command: "iris hive market earnings --allow-spending" } },
          { status: 402 },
        ),
    })
  })
  afterAll(() => server.stop(true))

  test("is not retried, and the person reads the sentence, not JSON", async () => {
    const model = createOpenAICompatible({ name: "iris", baseURL: `http://127.0.0.1:${server.port}/v1` })("hive/@193/llama3.2:3b")
    const err = await generateText({ model, prompt: "ok", maxRetries: 0 }).catch((e) => e)
    const error = MessageV2.fromError(err, { providerID: "iris" as never })
    expect(SessionRetry.retryable(error as never)).toBeUndefined()
    expect((error as any).data.message).toContain(SENTENCE)
    expect((error as any).data.message).not.toContain('{"error"')
  })
})
