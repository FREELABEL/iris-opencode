import { describe, expect, test } from "bun:test"
import { CHAT_WITH, agentForIrisId, askComposer, type ChatWithDetail } from "./chat-with"

// #192931 — Chat on an agent's card selects it in the composer, across the shell/chat boundary.

const agents = [
  { name: "build" },
  { name: "iris-legal-reviewer", description: "Legal Reviewer (IRIS agent #311) — reviews" },
  { name: "iris-clinical-reviewer", description: "Clinical Reviewer (IRIS agent #313)" },
]

describe("agentForIrisId", () => {
  test("finds the synced agent by the id in its description", () => {
    expect(agentForIrisId(agents, 313)?.name).toBe("iris-clinical-reviewer")
  })
  test("#31 is not #313 or #311", () => {
    expect(agentForIrisId(agents, 31)).toBeUndefined()
  })
})

describe("askComposer", () => {
  const composer = (target: EventTarget, onAsk: (id: number) => string | null) =>
    target.addEventListener(CHAT_WITH, (e) => {
      const d = (e as CustomEvent<ChatWithDetail>).detail
      d.reply(onAsk(d.id))
    })

  test("nobody answers: no chat is open", async () => {
    expect(await askComposer(313, { target: new EventTarget(), waitMs: 20 })).toBeUndefined()
  })

  test("a composer that holds the agent answers with its name", async () => {
    const t = new EventTarget()
    composer(t, (id) => agentForIrisId(agents, id)?.name ?? null)
    expect(await askComposer(313, { target: t, waitMs: 20 })).toBe("iris-clinical-reviewer")
    expect(await askComposer(999, { target: t, waitMs: 20 })).toBeNull()
  })

  test("refresh reaches the composer, so it can re-read its agent list", async () => {
    const t = new EventTarget()
    const seen: (boolean | undefined)[] = []
    t.addEventListener(CHAT_WITH, (e) => {
      const d = (e as CustomEvent<ChatWithDetail>).detail
      seen.push(d.refresh)
      d.reply(null)
    })
    await askComposer(811, { target: t, waitMs: 20 })
    await askComposer(811, { refresh: true, target: t, waitMs: 20 })
    expect(seen).toEqual([undefined, true])
  })

  test("one composer that holds it outweighs another that does not", async () => {
    const t = new EventTarget()
    composer(t, () => null)
    composer(t, () => "iris-legal-reviewer")
    expect(await askComposer(311, { target: t, waitMs: 20 })).toBe("iris-legal-reviewer")
  })
})
