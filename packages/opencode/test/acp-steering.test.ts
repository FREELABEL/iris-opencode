import { describe, expect, test } from "bun:test"
import { ACP, initializeResponse } from "../src/acp/agent"

/**
 * Buzz's steering extension. Without it, a message sent while IRIS is working makes buzz-acp
 * cancel the running turn and re-prompt with both messages merged — measured 2026-09-26, a
 * user's follow-up threw away a multi-minute build. The contract (buzz-acp @02753722):
 *   - advertise `_meta.steering.supported: true` at the TOP level of the initialize result
 *   - answer `_session/steering` with `{ outcome: "injected" }` while a turn runs
 *   - -32601 means "not supported" (buzz cancels + merges); any OTHER error means "deliver it
 *     as a normal next prompt" — so "no turn running" must never be -32601
 */

function makeAgent() {
  const calls: any[] = []
  const sdk = {
    session: {
      prompt: async (input: any) => {
        calls.push(input)
        return { data: {} }
      },
    },
  }
  const agent = new ACP.Agent({} as any, { sdk } as any)
  // A session the manager knows about, without the real create() round-trip.
  ;(agent as any).sessionManager = {
    get: (id: string) => ({ id, cwd: "/tmp/work", modeId: undefined }),
  }
  return { agent, calls, running: (agent as any).running as Set<string> }
}

const steer = { sessionId: "ses_1", prompt: [{ type: "text", text: "STEER-MARK" }] }

describe("ACP steering", () => {
  test("initialize advertises steering where buzz-acp reads it", () => {
    const res = initializeResponse({ protocolVersion: 1 }, "1.2.3") as any
    expect(res._meta?.steering?.supported).toBe(true)
  })

  test("a steer during a running turn is injected, not replied to", async () => {
    const { agent, calls, running } = makeAgent()
    running.add("ses_1")
    const out = await agent.extMethod("session/steering", steer)
    expect(out).toEqual({ outcome: "injected" })
    expect(calls).toHaveLength(1)
    expect(calls[0].noReply).toBe(true)
    expect(calls[0].sessionID).toBe("ses_1")
    expect(JSON.stringify(calls[0].parts)).toContain("STEER-MARK")
  })

  test("the underscored spelling is accepted too (newer SDKs pass it through)", async () => {
    const { agent, running } = makeAgent()
    running.add("ses_1")
    expect(await agent.extMethod("_session/steering", steer)).toEqual({ outcome: "injected" })
  })

  test("no running turn → an error that is NOT -32601, and nothing is written", async () => {
    const { agent, calls } = makeAgent()
    const err = await agent.extMethod("session/steering", steer).catch((e) => e)
    expect(err.code).toBeDefined()
    expect(err.code).not.toBe(-32601)
    expect(calls).toHaveLength(0)
  })

  test("a turn that ends mid-steer is refused so buzz redelivers it", async () => {
    const { agent, running } = makeAgent()
    running.add("ses_1")
    ;(agent as any).sdk.session.prompt = async () => {
      running.delete("ses_1") // the loop finished while we were inserting
      return { data: {} }
    }
    const err = await agent.extMethod("session/steering", steer).catch((e) => e)
    expect(err.code).not.toBe(-32601)
  })

  test("unknown extension methods are method-not-found", async () => {
    const { agent } = makeAgent()
    const err = await agent.extMethod("session/whatever", {}).catch((e) => e)
    expect(err.code).toBe(-32601)
  })

  test("prompt() clears the running flag even when the turn throws", async () => {
    const { agent, running } = makeAgent()
    ;(agent as any).runPrompt = async () => {
      expect(running.has("ses_1")).toBe(true)
      throw new Error("model exploded")
    }
    await agent.prompt({ sessionId: "ses_1", prompt: [] } as any).catch(() => {})
    expect(running.has("ses_1")).toBe(false)
  })
})
