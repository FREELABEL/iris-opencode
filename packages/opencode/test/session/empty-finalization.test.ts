import { describe, expect, mock, test } from "bun:test"
import path from "path"

/**
 * #185820 — an empty finalization must be RETRIED, not surfaced as a terminal error.
 *
 * The unit tests in retry.test.ts cover the decision. This covers the WIRING: that the
 * processor's loop actually goes round again, because the bug was never in the predicate —
 * it was that the code built a non-retryable error and stopped, and the user typed "continue"
 * by hand to do what the loop should have done.
 *
 * LLM.stream is mocked to fail empty on the first call and answer on the second.
 */

let calls = 0
/** When true the stream NEVER produces output — the "provider is genuinely dead" case. */
let alwaysEmpty = false
/** When true the retry answers but never sends a finish-step (a stream that just ends). */
let retryOmitsFinishStep = false
const emptyStep = {
  type: "finish-step",
  finishReason: "unknown",
  usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
  providerMetadata: undefined,
}
const answerSteps = [
  { type: "text-start", id: "t1", providerMetadata: undefined },
  { type: "text-delta", id: "t1", text: "recovered", providerMetadata: undefined },
  { type: "text-end", id: "t1", providerMetadata: undefined },
  {
    type: "finish-step",
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    providerMetadata: undefined,
  },
]

async function* events(): AsyncGenerator<any> {
  calls++
  yield { type: "start" }
  yield { type: "start-step", request: {}, warnings: [] }
  if (alwaysEmpty || calls === 1) {
    // The failure shape: a step that ends with no text and zero output tokens, and NO error event.
    yield emptyStep
  } else if (retryOmitsFinishStep) {
    // Output, but no finish-step: nothing re-sets `finish`, so a stale value would survive.
    for (const e of answerSteps.filter((e) => e.type !== "finish-step")) yield e
  } else {
    for (const e of answerSteps) yield e
  }
  yield { type: "finish" }
}

mock.module(path.join(__dirname, "../../src/session/llm.ts"), () => ({
  LLM: {
    stream: async () => ({ fullStream: events() }),
  },
}))

const { SessionProcessor } = await import("../../src/session/processor")
const { Session } = await import("../../src/session")
const { Instance } = await import("../../src/project/instance")
const { MessageV2 } = await import("../../src/session/message-v2")
const { Log } = await import("../../src/util/log")
Log.init({ print: false })

const projectRoot = path.join(__dirname, "../..")
const model = {
  id: "iris-ai",
  providerID: "iris",
  limit: { context: 200_000, output: 8_192 },
  info: { id: "iris-ai", cost: { input: 0, output: 0 }, limit: { context: 200_000, output: 8_192 } },
} as any

describe("empty finalization is retried, not reported", () => {
  test("a stream that finishes empty is retried, and the retry's answer is kept", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        calls = 0
        alwaysEmpty = false
        retryOmitsFinishStep = false
        const session = await Session.create({})
        // The assistant message the session builds (prompt.ts): a user parent is required.
        const { Identifier } = await import("../../src/id/id")
        const user: any = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: model.providerID, modelID: model.id },
        } as any)
        const msg: any = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          parentID: user.id,
          sessionID: session.id,
          mode: "build",
          agent: "build",
          path: { cwd: Instance.directory, root: Instance.worktree },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.id,
          providerID: model.providerID,
          time: { created: Date.now() },
        } as any)

        const processor = SessionProcessor.create({
          assistantMessage: msg,
          sessionID: session.id,
          model,
          abort: new AbortController().signal,
        })

        const outcome = await processor.process({} as any)

        expect(calls).toBe(2) // retried exactly once
        expect(processor.message.error).toBeUndefined() // no terminal error surfaced
        expect(outcome).not.toBe("stop")
        const parts = await MessageV2.parts(msg.id)
        const text = parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("")
        expect(text).toContain("recovered")

      },
    })
  }, 30000)
})

describe("a genuinely empty provider still ends the turn", () => {
  test("after the cap it stops, reports the error, and says how many attempts it made", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        calls = 0
        retryOmitsFinishStep = false
        alwaysEmpty = true
        const { SessionRetry } = await import("../../src/session/retry")
        const session = await Session.create({})
        const { Identifier } = await import("../../src/id/id")
        const user: any = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: model.providerID, modelID: model.id },
        } as any)
        const msg: any = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          parentID: user.id,
          sessionID: session.id,
          mode: "build",
          agent: "build",
          path: { cwd: Instance.directory, root: Instance.worktree },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.id,
          providerID: model.providerID,
          time: { created: Date.now() },
        } as any)

        const processor = SessionProcessor.create({
          assistantMessage: msg,
          sessionID: session.id,
          model,
          abort: new AbortController().signal,
        })
        const outcome = await processor.process({} as any)

        // Bounded: the first attempt plus the retries, and no more.
        expect(calls).toBe(SessionRetry.EMPTY_FINALIZATION_MAX_RETRIES + 1)
        expect(outcome).toBe("stop")
        const message: any = processor.message
        expect(message.error).toBeDefined()
        // The message names the model and how many attempts were made — the old text claimed
        // "every upstream attempt failed" without ever having retried.
        expect(message.error.data.message).toContain("iris-ai")
        expect(message.error.data.message).toContain(`${SessionRetry.EMPTY_FINALIZATION_MAX_RETRIES + 1} attempts`)

      },
    })
  }, 60000)
})

describe("the discarded attempt leaves nothing behind", () => {
  test("a retry that answers without a finish-step does not inherit the empty attempt's finish", async () => {
    // The retry resets `finish` before going round again. Without that, a stream that ends
    // without a finish-step keeps "unknown" from the attempt that was thrown away — the
    // message then reports a finish reason belonging to a response nobody ever saw.
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        calls = 0
        alwaysEmpty = false
        retryOmitsFinishStep = true
        const session = await Session.create({})
        const { Identifier } = await import("../../src/id/id")
        const user: any = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: model.providerID, modelID: model.id },
        } as any)
        const msg: any = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          parentID: user.id,
          sessionID: session.id,
          mode: "build",
          agent: "build",
          path: { cwd: Instance.directory, root: Instance.worktree },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.id,
          providerID: model.providerID,
          time: { created: Date.now() },
        } as any)

        const processor = SessionProcessor.create({
          assistantMessage: msg,
          sessionID: session.id,
          model,
          abort: new AbortController().signal,
        })
        await processor.process({} as any)

        expect(calls).toBe(2)
        const message: any = processor.message
        expect(message.finish).toBeUndefined()
        expect(message.error).toBeUndefined()
      },
    })
  }, 60000)
})
