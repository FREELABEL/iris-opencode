import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText } from "ai"
import { MessageV2 } from "./message-v2"
import { SessionRetry } from "./retry"

/**
 * #192146: `iris run -m iris/hive/<model>` took 85 s to fail, as ten retries of an instant failure.
 * The gateway now refuses an unreachable machine with HTTP 424. This pins why that status: a real
 * SDK call against a fake gateway, then the same two functions the session loop uses to decide.
 */
const REASON = "hive/m: your machine could not be reached. The tunnel is not connected. Nothing was sent to a cloud model."

let server: ReturnType<typeof Bun.serve>
let status = 424

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({ error: { message: REASON, type: "hive_unreachable", code: "hive_unreachable" } }, { status }),
  })
})
afterAll(() => server.stop(true))

async function decide() {
  const model = createOpenAICompatible({ name: "iris", baseURL: `http://127.0.0.1:${server.port}/v1` })("hive/m")
  const err = await generateText({ model, prompt: "ok", maxRetries: 0 }).catch((e) => e)
  const error = MessageV2.fromError(err, { providerID: "iris" as never })
  return { error, retry: SessionRetry.retryable(error as never) }
}

describe("the gateway's refusal of an unreachable machine", () => {
  test("424 is not retried, and the person reads the reason", async () => {
    status = 424
    const { error, retry } = await decide()
    expect(retry).toBeUndefined()
    expect((error as any).data.message).toContain("tunnel is not connected")
  })

  test("a 5xx is retried: why the refusal must not be one", async () => {
    status = 502
    expect((await decide()).retry).toBeDefined()
  })
})
