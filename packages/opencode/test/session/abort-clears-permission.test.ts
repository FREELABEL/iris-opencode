import { describe, expect, mock, test } from "bun:test"
import path from "path"
import { streamText, tool, jsonSchema } from "ai"

/**
 * #191784 — stopping a session must clear the permission request its tool is waiting on.
 *
 * Before the fix, SessionPrompt.cancel only aborted the run. The tool's permission ask is a
 * promise parked in PermissionNext's pending map that the abort never reaches, so the request
 * stayed listed, still accepted a reply, and the tool (and the turn) never finished.
 *
 * LLM.stream is mocked with the real `streamText` over a mock model that calls one tool; the
 * tool asks permission exactly the way Tool.Context.ask does. The turn is then stopped the way
 * the server's abort route stops it: abort the run's signal, then SessionPrompt.cancel.
 */

let abortSignal: AbortSignal | undefined
let toolSettled: "pending" | "resolved" | "rejected" = "pending"
let askSessionID = ""

const { PermissionNext } = await import("../../src/permission/next")

/** A LanguageModelV2 that answers with one `bash` tool call (ai/test needs msw, not installed). */
function mockModel(): any {
  const chunks = [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "call_1", toolName: "bash" },
    { type: "tool-input-end", id: "call_1" },
    { type: "tool-call", toolCallId: "call_1", toolName: "bash", input: JSON.stringify({ command: "ls" }) },
    { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  ]
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "mock",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("not used")
    },
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(c)
          controller.close()
        },
      }),
    }),
  }
}

mock.module(path.join(__dirname, "../../src/session/llm.ts"), () => ({
  LLM: {
    stream: async () =>
      streamText({
        abortSignal,
        model: mockModel(),
        prompt: "run ls",
        tools: {
          bash: tool({
            inputSchema: jsonSchema<{ command: string }>({
              type: "object",
              properties: { command: { type: "string" } },
            }),
            async execute(args) {
              try {
                await PermissionNext.ask({
                  sessionID: askSessionID,
                  permission: "bash",
                  patterns: [args.command],
                  metadata: {},
                  always: [],
                  ruleset: [],
                })
                toolSettled = "resolved"
              } catch (e) {
                toolSettled = "rejected"
                throw e
              }
              return { output: "ran", title: "", metadata: {} }
            },
          }),
        },
      }),
  },
}))

const { SessionProcessor } = await import("../../src/session/processor")
const { SessionPrompt } = await import("../../src/session/prompt")
const { Session } = await import("../../src/session")
const { MessageV2 } = await import("../../src/session/message-v2")
const { Instance } = await import("../../src/project/instance")
const { Identifier } = await import("../../src/id/id")
const { Bus } = await import("../../src/bus")
const { Log } = await import("../../src/util/log")
const { tmpdir } = await import("../fixture/fixture")
Log.init({ print: false })

const model = {
  id: "iris-ai",
  providerID: "iris",
  limit: { context: 200_000, output: 8_192 },
  info: { id: "iris-ai", cost: { input: 0, output: 0 }, limit: { context: 200_000, output: 8_192 } },
} as any

async function until(check: () => Promise<boolean> | boolean, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return false
}

async function assistantFor(sessionID: string) {
  const user: any = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: model.providerID, modelID: model.id },
  } as any)
  return (await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    parentID: user.id,
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.id,
    providerID: model.providerID,
    time: { created: Date.now() },
  } as any)) as any
}

describe("stopping a session clears its pending permission (#191784)", () => {
  test("abort rejects the request, publishes the reject, refuses a late reply, and ends the tool once as aborted", async () => {
    // Not a git repo, so the processor skips snapshotting (slow on a real checkout).
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        toolSettled = "pending"
        const session = await Session.create({})
        const other = await Session.create({})
        askSessionID = session.id
        const msg = await assistantFor(session.id)

        // A pending request on another session must survive this session's abort.
        const otherAsk = PermissionNext.ask({
          sessionID: other.id,
          permission: "edit",
          patterns: ["x.ts"],
          metadata: {},
          always: [],
          ruleset: [],
        }).catch((e) => e)

        const replied: any[] = []
        const unsubReplied = Bus.subscribe(PermissionNext.Event.Replied, (e) => {
          replied.push(e.properties)
        })
        const toolErrors: any[] = []
        const unsubParts = Bus.subscribe(MessageV2.Event.PartUpdated, (e) => {
          const part = e.properties.part
          if (part.type === "tool" && part.state.status === "error") toolErrors.push(part.state.error)
        })

        const controller = new AbortController()
        abortSignal = controller.signal
        const processor = SessionProcessor.create({
          assistantMessage: msg,
          sessionID: session.id,
          model,
          abort: controller.signal,
        })
        const done = processor.process({} as any)

        // The tool is parked on its permission ask.
        expect(await until(async () => (await PermissionNext.list()).some((p) => p.sessionID === session.id))).toBe(
          true,
        )
        const request = (await PermissionNext.list()).find((p) => p.sessionID === session.id)!

        // Stop the session the way POST /session/:id/abort does.
        controller.abort()
        SessionPrompt.cancel(session.id)

        // The turn ends (before the fix it hung on the parked tool).
        const finished = await Promise.race([
          done.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
        ])
        expect(finished).toBe(true)

        const pending = await PermissionNext.list()
        expect(pending.some((p) => p.id === request.id)).toBe(false)
        // Only that session's requests were cleared.
        expect(pending.some((p) => p.sessionID === other.id)).toBe(true)

        // Same event a user reject publishes, so clients drop the prompt.
        expect(replied).toContainEqual({ sessionID: session.id, requestID: request.id, reply: "reject" })
        expect(replied.some((r) => r.sessionID === other.id)).toBe(false)

        // A late reply finds nothing (the HTTP route turns this into a 404).
        expect(await PermissionNext.reply({ requestID: request.id, reply: "once" })).toBe(false)

        // The tool's ask settled, and the tool part ended exactly once, as aborted.
        expect(toolSettled as string).toBe("rejected")
        await new Promise((r) => setTimeout(r, 50))
        expect(toolErrors).toEqual(["Tool execution aborted"])
        const parts = await MessageV2.parts(msg.id)
        const toolPart: any = parts.find((p) => p.type === "tool")
        expect(toolPart.state.status).toBe("error")
        expect(toolPart.state.error).toBe("Tool execution aborted")

        unsubReplied()
        unsubParts()
        await PermissionNext.rejectSession(other.id)
        await otherAsk
      },
    })
  }, 30000)
})
