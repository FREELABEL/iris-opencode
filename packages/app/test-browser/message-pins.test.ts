import { describe, expect, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createRoot } from "solid-js"
import type { Platform } from "@/context/platform"
import { createMessagePinStore, MESSAGE_PINS_KEY, pinFirstLine } from "@/context/message-pins"
import { configureMessagePins, messagePins } from "@opencode-ai/session-ui/message-pins"

// Runs under the browser build of Solid: the persisted store hydrates through createResource.

const web = { platform: "web" } as Platform

// The persist layer keeps an in-memory cache beside localStorage, so every test gets its own chats.
let run = 0
const chats = () => {
  run++
  return { a: `ses_${run}_a`, b: `ses_${run}_b` }
}

const target = (sessionID: string, messageID: string, time: number, text = `message ${messageID}`) => ({
  sessionID,
  messageID,
  turnID: `turn-${messageID}`,
  text,
  time,
})

/** A store inside its own root; dispose it to simulate quitting the app. */
function open(platform: Platform = web) {
  return createRoot((dispose) => ({ pins: createMessagePinStore(platform), dispose }))
}

const stored = () => {
  const key = Object.keys(localStorage).find((k) => k.endsWith(MESSAGE_PINS_KEY))
  return key ? (JSON.parse(localStorage.getItem(key)!) as { sessions: Record<string, { id: string }[]> }) : undefined
}

describe("message pins", () => {
  test("pressing pin pins, pressing again unpins", () => {
    const { a } = chats()
    const { pins, dispose } = open()
    pins.toggle(target(a, "msg_1", 100))
    expect(pins.isPinned(a, "msg_1")).toBe(true)
    expect(pins.list(a)).toEqual([{ id: "msg_1", turn: "turn-msg_1", text: "message msg_1", time: 100 }])

    pins.toggle(target(a, "msg_1", 100))
    expect(pins.isPinned(a, "msg_1")).toBe(false)
    expect(pins.list(a)).toEqual([])
    dispose()
  })

  test("pins are per chat", () => {
    const { a, b } = chats()
    const { pins, dispose } = open()
    pins.toggle(target(a, "msg_1", 100))
    pins.toggle(target(b, "msg_2", 200))

    expect(pins.list(a).map((p) => p.id)).toEqual(["msg_1"])
    expect(pins.list(b).map((p) => p.id)).toEqual(["msg_2"])
    expect(pins.isPinned(b, "msg_1")).toBe(false)

    pins.unpin(a, "msg_1")
    expect(pins.list(a)).toEqual([])
    expect(pins.list(b).map((p) => p.id)).toEqual(["msg_2"])
    dispose()
  })

  test("the list is in message order, whatever order they were pinned in", () => {
    const { a } = chats()
    const { pins, dispose } = open()
    pins.toggle(target(a, "late", 300))
    pins.toggle(target(a, "early", 100))
    pins.toggle(target(a, "mid", 200))
    expect(pins.list(a).map((p) => p.id)).toEqual(["early", "mid", "late"])
    dispose()
  })

  test("pins survive a restart (persistence round trip)", () => {
    const { a, b } = chats()
    const first = open()
    first.pins.toggle(target(a, "msg_1", 100))
    first.pins.toggle(target(a, "msg_2", 200))
    first.pins.toggle(target(a, "msg_3", 300))
    first.pins.toggle(target(b, "msg_9", 50))
    first.pins.toggle(target(a, "msg_2", 200)) // unpinned again before quitting
    first.dispose()

    expect(stored()?.sessions[a]?.map((p) => p.id)).toEqual(["msg_1", "msg_3"])

    const second = open()
    expect(second.pins.list(a).map((p) => p.id)).toEqual(["msg_1", "msg_3"])
    expect(second.pins.list(a)[0]?.turn).toBe("turn-msg_1")
    expect(second.pins.list(b).map((p) => p.id)).toEqual(["msg_9"])
    second.dispose()
  })

  test("pins survive a desktop restart (async app storage, as in IRIS desktop)", async () => {
    const { a } = chats()
    const disk = new Map<string, string>()
    const storage: AsyncStorage = {
      getItem: async (key: string) => disk.get(key) ?? null,
      setItem: async (key: string, value: string) => void disk.set(key, value),
      removeItem: async (key: string) => void disk.delete(key),
      clear: async () => disk.clear(),
      key: async () => null,
      getLength: async () => disk.size,
      length: Promise.resolve(disk.size),
    }
    const desktop = { platform: "desktop", storage: () => storage } as unknown as Platform

    const first = open(desktop)
    await first.pins.ready.promise
    first.pins.toggle(target(a, "msg_1", 100))
    first.pins.toggle(target(a, "msg_2", 200))
    first.pins.toggle(target(a, "msg_3", 300))
    await new Promise((resolve) => setTimeout(resolve, 0))
    first.dispose()
    expect(disk.get(MESSAGE_PINS_KEY)).toContain("msg_3")

    const second = open(desktop)
    await second.pins.ready.promise
    expect(second.pins.list(a).map((p) => p.id)).toEqual(["msg_1", "msg_2", "msg_3"])
    second.dispose()
  })

  test("the last unpin in a chat drops the chat from storage", () => {
    const { a } = chats()
    const { pins, dispose } = open()
    pins.toggle(target(a, "msg_1", 100))
    expect(stored()?.sessions[a]).toHaveLength(1)
    pins.toggle(target(a, "msg_1", 100))
    dispose()
    expect(stored()?.sessions).not.toHaveProperty(a)
  })

  test("the message action row toggles the same store once the app configures it", () => {
    const { a } = chats()
    const { pins, dispose } = open()
    configureMessagePins({ isPinned: pins.isPinned, toggle: pins.toggle })
    messagePins()!.toggle(target(a, "msg_1", 100))
    expect(messagePins()!.isPinned(a, "msg_1")).toBe(true)
    expect(pins.list(a).map((p) => p.id)).toEqual(["msg_1"])
    configureMessagePins(undefined)
    expect(messagePins()).toBeUndefined()
    dispose()
  })
})

describe("pinFirstLine", () => {
  test("first non-empty line, markdown markers stripped", () => {
    expect(pinFirstLine("\n\n## **Plan** for `today`\nsecond line")).toBe("Plan for today")
    expect(pinFirstLine("- item one\n- item two")).toBe("item one")
    expect(pinFirstLine("```ts\ncode\n```")).toBe("code")
    expect(pinFirstLine("rename user_id to owner_id")).toBe("rename user_id to owner_id")
  })

  test("long lines are clipped to 80 characters", () => {
    const line = pinFirstLine("x".repeat(200))
    expect(line.length).toBe(80)
    expect(line.endsWith("…")).toBe(true)
  })
})
