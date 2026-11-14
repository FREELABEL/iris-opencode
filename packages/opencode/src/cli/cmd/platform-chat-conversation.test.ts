import { test, expect, describe } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { pickConversationId, resolveConversationId } from "./platform-chat"

const src = readFileSync(join(import.meta.dir, "platform-chat.ts"), "utf8")

describe("canonical conversation (#189968)", () => {
  test("default chat joins the server's canonical conversation", async () => {
    const seen: number[] = []
    const id = await resolveConversationId({}, 642, async (a) => (seen.push(a), "conv_642_193"))
    expect(id).toBe("conv_642_193")
    expect(seen).toEqual([642])
  })

  test("an old server (lookup fails / 404) falls back to the server default thread", async () => {
    expect(await resolveConversationId({}, 642, async () => null)).toBeUndefined()
  })

  test("--thread/--conversation wins and never calls the server", async () => {
    let called = false
    const id = await resolveConversationId({ thread: "t-1" }, 642, async () => ((called = true), "x"))
    expect(id).toBe("t-1")
    expect(called).toBe(false)
  })

  test("--fresh keeps its meaning: a novel id, not the canonical one", async () => {
    const id = await resolveConversationId({ fresh: true }, 642, async () => "canonical")
    expect(id).toMatch(/^fresh_/)
  })

  test("pickConversationId reads the plausible response shapes", () => {
    expect(pickConversationId({ conversation_id: "a" })).toBe("a")
    expect(pickConversationId({ data: { thread_id: "b" } })).toBe("b")
    expect(pickConversationId({ data: { id: 7 } })).toBe("7")
    expect(pickConversationId({ message: "not found" })).toBeNull()
    expect(pickConversationId(null)).toBeNull()
  })

  test("--conversation is an alias of --thread", () => {
    expect(src).toMatch(/option\("thread", \{\s*alias: "conversation"/)
  })
})

describe("voice joins the same conversation as text (#189968)", () => {
  const voice = src.slice(src.indexOf("export async function runVoiceChat"), src.indexOf("export const PlatformChatCommand"))

  test("the voice loop resolves the conversation once, before the turn loop", () => {
    const resolve = voice.indexOf("resolveConversationId(")
    expect(resolve).toBeGreaterThan(-1)
    expect(resolve).toBeLessThan(voice.indexOf("while (true)"))
  })

  test("every voice turn sends the thread id", () => {
    const call = voice.slice(voice.indexOf("streamAgentChat({"), voice.indexOf("onEvent:", voice.indexOf("streamAgentChat({")))
    expect(call).toMatch(/\bthreadId\b/)
  })

  test("the handler forwards --thread/--fresh to the voice loop", () => {
    const handler = src.slice(src.indexOf("await runVoiceChat({"), src.indexOf("await runVoiceChat({") + 600)
    expect(handler).toContain("thread: args.thread")
    expect(handler).toContain("fresh: args.fresh")
  })
})
