import { describe, expect, test } from "bun:test"
import { createA2AHandler, type AgentCard, type Execute } from "./server"
import { a2aCall } from "./client"
import { parseAgentAskOutput, threadForContext } from "./iris-agent"
import { buildAgentCard } from "../cli/cmd/a2a"

/**
 * A2A v1.0.1 wire tests. Every exchange goes through the real fetch handler with a FAKE
 * executor — no network, no platform. The point the ticket makes, and these tests hold:
 * a card that resolves proves nothing; a TASK has to round-trip.
 */

const BASE = "http://127.0.0.1:3299"
const TOKEN = "test-token"

function card(): AgentCard {
  return buildAgentCard({ rpcUrl: `${BASE}/a2a`, agentId: 42, agentName: "Tester" })
}

function setup(execute: Execute, extra: { token?: string | null } = {}) {
  const h = createA2AHandler({ card: card(), execute, token: extra.token === null ? undefined : (extra.token ?? TOKEN) })
  // A fetch that routes into the handler, so the client code under test runs unmodified.
  const fetchImpl = ((input: any, init?: any) => h.fetch(new Request(input, init))) as typeof fetch
  return { h, fetchImpl }
}

async function rpc(
  h: ReturnType<typeof createA2AHandler>,
  method: string,
  params: unknown,
  opts: { id?: number | string; version?: string | null; token?: string | null } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (opts.version !== null) headers["A2A-Version"] = opts.version ?? "1.0"
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? TOKEN}`
  return h.fetch(
    new Request(`${BASE}/a2a`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: opts.id ?? 7, method, params }),
    }),
  )
}

function userMessage(text: string, extra: Record<string, unknown> = {}) {
  return { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }], ...extra }
}

async function readSse(res: Response): Promise<any[]> {
  const body = await res.text() // resolves only when the server CLOSES the stream
  return body
    .split("\n\n")
    .filter((b) => b.startsWith("data: "))
    .map((b) => JSON.parse(b.slice(6)))
}

const answer: Execute = async ({ text }) => `answer to: ${text}`

describe("agent card", () => {
  test("has every field v1.0 requires, and advertises a JSONRPC 1.0 interface", async () => {
    const { h } = setup(answer)
    const res = await h.fetch(new Request(`${BASE}/.well-known/agent-card.json`))
    expect(res.status).toBe(200)
    const c = await res.json()
    for (const k of ["name", "description", "version", "supportedInterfaces", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"])
      expect(c).toHaveProperty(k)
    expect(c.supportedInterfaces[0]).toEqual({ url: `${BASE}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" })
    expect(c.capabilities).toEqual({ streaming: true, pushNotifications: false, extendedAgentCard: false })
    expect(c.skills).toHaveLength(1)
    expect(c.skills[0]).toMatchObject({ id: "ask-agent-42", tags: expect.any(Array) })
    expect(c.description).toContain("Authorization: Bearer")
    // v0.3 leftovers that confuse v1.0 clients
    expect(c).not.toHaveProperty("url")
    expect(c).not.toHaveProperty("protocolVersion")
  })

  test("echo test mode is unmistakable on the card", () => {
    const c = buildAgentCard({ rpcUrl: `${BASE}/a2a`, agentId: 0, echo: true })
    expect(c.name).toContain("ECHO TEST")
    expect(c.description).toContain("No IRIS agent is consulted")
  })
})

describe("auth", () => {
  test("card is public, JSON-RPC endpoint is not", async () => {
    const { h } = setup(answer)
    expect((await h.fetch(new Request(`${BASE}/.well-known/agent-card.json`))).status).toBe(200)
    expect((await rpc(h, "SendMessage", { message: userMessage("hi") }, { token: null })).status).toBe(401)
    expect((await rpc(h, "SendMessage", { message: userMessage("hi") }, { token: "wrong" })).status).toBe(401)
    expect((await rpc(h, "SendMessage", { message: userMessage("hi") })).status).toBe(200)
  })
})

describe("SendMessage — a real task exchange", () => {
  test("blocking by default: returns a COMPLETED task whose artifact carries the answer", async () => {
    const { h } = setup(answer)
    const res = await rpc(h, "SendMessage", { message: userMessage("what is MRR?") }, { id: 11 })
    const body = await res.json()
    expect(body.jsonrpc).toBe("2.0")
    expect(body.id).toBe(11) // same value AND type as sent
    expect(body.error).toBeUndefined()
    const task = body.result.task
    expect(task).toBeDefined()
    expect("messageId" in task).toBe(false) // SDK tells Task from Message by this key
    expect(task.status.state).toBe("TASK_STATE_COMPLETED")
    expect(task.status.timestamp).toMatch(/Z$/)
    expect(task.artifacts).toHaveLength(1)
    expect(task.artifacts[0].parts).toEqual([{ text: "answer to: what is MRR?" }])
    expect(task.history.map((m: any) => m.role)).toEqual(["ROLE_USER", "ROLE_AGENT"])
    expect(task.contextId).toBeTruthy()
    // no v0.3 discriminators anywhere
    expect(JSON.stringify(body)).not.toContain('"kind"')
  })

  test("string ids are echoed as strings", async () => {
    const { h } = setup(answer)
    const body = await (await rpc(h, "SendMessage", { message: userMessage("x") }, { id: "abc" })).json()
    expect(body.id).toBe("abc")
  })

  test("contextId from the client is kept; executor sees it", async () => {
    let seen = ""
    const { h } = setup(async ({ contextId }) => ((seen = contextId), "ok"))
    const body = await (await rpc(h, "SendMessage", { message: userMessage("x", { contextId: "ctx-1" }) })).json()
    expect(body.result.task.contextId).toBe("ctx-1")
    expect(seen).toBe("ctx-1")
  })

  test("executor throwing ends the task FAILED with the reason in status.message", async () => {
    const { h } = setup(async () => {
      throw new Error("agent timed out")
    })
    const task = (await (await rpc(h, "SendMessage", { message: userMessage("x") })).json()).result.task
    expect(task.status.state).toBe("TASK_STATE_FAILED")
    expect(task.status.message.parts[0].text).toContain("agent timed out")
    expect(task.artifacts).toBeUndefined()
  })

  test("returnImmediately:true returns before the work finishes; GetTask sees it complete", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { h } = setup(async () => (await gate, "late"))
    const first = (await (await rpc(h, "SendMessage", { message: userMessage("x"), configuration: { returnImmediately: true } })).json()).result.task
    expect(["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"]).toContain(first.status.state)
    release()
    await Bun.sleep(5)
    const got = (await (await rpc(h, "GetTask", { id: first.id })).json()).result
    expect(got.status.state).toBe("TASK_STATE_COMPLETED")
    expect(got.artifacts[0].parts[0].text).toBe("late")
  })

  test("historyLength:0 omits history", async () => {
    const { h } = setup(answer)
    const task = (await (await rpc(h, "SendMessage", { message: userMessage("x"), configuration: { historyLength: 0 } })).json()).result.task
    expect(task.history).toBeUndefined()
  })

  test("a message on a finished task is refused with UnsupportedOperation (-32004)", async () => {
    const { h } = setup(answer)
    const task = (await (await rpc(h, "SendMessage", { message: userMessage("x") })).json()).result.task
    const body = await (await rpc(h, "SendMessage", { message: userMessage("more", { taskId: task.id }) })).json()
    expect(body.error.code).toBe(-32004)
  })

  test("acceptedOutputModes that exclude text → ContentTypeNotSupported (-32005)", async () => {
    const { h } = setup(answer)
    const body = await (await rpc(h, "SendMessage", { message: userMessage("x"), configuration: { acceptedOutputModes: ["image/png"] } })).json()
    expect(body.error.code).toBe(-32005)
  })

  test("a part with two payloads is invalid params (-32602)", async () => {
    const { h } = setup(answer)
    const body = await (await rpc(h, "SendMessage", { message: { messageId: "m", role: "ROLE_USER", parts: [{ text: "a", url: "b" }] } })).json()
    expect(body.error.code).toBe(-32602)
  })
})

describe("SendStreamingMessage", () => {
  test("Task first, then WORKING, artifact chunks, COMPLETED — and the stream closes", async () => {
    const { h } = setup(async function* () {
      yield "hel"
      yield "lo"
    })
    const res = await rpc(h, "SendStreamingMessage", { message: userMessage("x") }, { id: 3 })
    expect(res.headers.get("content-type")).toStartWith("text/event-stream")
    const events = await readSse(res) // would hang forever if the stream never closed
    expect(events.every((e) => e.id === 3 && e.jsonrpc === "2.0")).toBe(true)
    const kinds = events.map((e) => Object.keys(e.result)[0])
    expect(kinds[0]).toBe("task")
    expect(events[0].result.task.status.state).toBe("TASK_STATE_SUBMITTED")
    expect(kinds).toEqual(["task", "statusUpdate", "artifactUpdate", "artifactUpdate", "artifactUpdate", "statusUpdate"])
    expect(events[1].result.statusUpdate.status.state).toBe("TASK_STATE_WORKING")
    const chunks = events.filter((e) => e.result.artifactUpdate).map((e) => e.result.artifactUpdate)
    expect(chunks.map((c) => c.artifact.parts[0].text).join("")).toBe("hello")
    expect(chunks.map((c) => c.append)).toEqual([false, true, true])
    expect(chunks.at(-1)!.lastChunk).toBe(true)
    expect(events.at(-1).result.statusUpdate.status.state).toBe("TASK_STATE_COMPLETED")
    // v1.0 removed `final`
    expect(JSON.stringify(events)).not.toContain('"final"')

    const taskId = events[0].result.task.id
    const got = (await (await rpc(h, "GetTask", { id: taskId })).json()).result
    expect(got.status.state).toBe("TASK_STATE_COMPLETED")
    expect(got.artifacts[0].parts[0].text).toBe("hello")
  })

  test("CancelTask on a running streaming task → CANCELED, stream closes, executor sees abort", async () => {
    let aborted = false
    let started!: () => void
    const running = new Promise<void>((r) => (started = r))
    const { h } = setup(async function* ({ signal }) {
      yield "partial"
      started()
      await new Promise<void>((r) => signal.addEventListener("abort", () => r()))
      aborted = true
    })
    const res = await rpc(h, "SendStreamingMessage", { message: userMessage("x") })
    const eventsP = readSse(res)
    await running
    const taskId = [...h.tasks.keys()].at(-1)!
    const canceled = (await (await rpc(h, "CancelTask", { id: taskId })).json()).result
    expect(canceled.status.state).toBe("TASK_STATE_CANCELED")
    const events = await eventsP
    expect(events.at(-1).result.statusUpdate.status.state).toBe("TASK_STATE_CANCELED")
    expect(aborted).toBe(true)
    // canceling a terminal task is TaskNotCancelable
    expect((await (await rpc(h, "CancelTask", { id: taskId })).json()).error.code).toBe(-32002)
  })

  test("SubscribeToTask on a finished task → UnsupportedOperation (-32004)", async () => {
    const { h } = setup(answer)
    const task = (await (await rpc(h, "SendMessage", { message: userMessage("x") })).json()).result.task
    expect((await (await rpc(h, "SubscribeToTask", { id: task.id })).json()).error.code).toBe(-32004)
  })
})

describe("errors", () => {
  test("GetTask / CancelTask of an unknown id → TaskNotFound (-32001)", async () => {
    const { h } = setup(answer)
    expect((await (await rpc(h, "GetTask", { id: "nope" })).json()).error.code).toBe(-32001)
    expect((await (await rpc(h, "CancelTask", { id: "nope" })).json()).error.code).toBe(-32001)
  })

  test("missing A2A-Version means 0.3 → VersionNotSupported (-32009); 0.3 likewise", async () => {
    const { h } = setup(answer)
    const a = await (await rpc(h, "SendMessage", { message: userMessage("x") }, { version: null, id: 5 })).json()
    expect(a.error.code).toBe(-32009)
    expect(a.id).toBe(5)
    expect((await (await rpc(h, "SendMessage", { message: userMessage("x") }, { version: "0.3" })).json()).error.code).toBe(-32009)
  })

  test("unknown method → -32601; push config → -32003; extended card → -32007", async () => {
    const { h } = setup(answer)
    expect((await (await rpc(h, "message/send", {})).json()).error.code).toBe(-32601)
    expect((await (await rpc(h, "CreateTaskPushNotificationConfig", {})).json()).error.code).toBe(-32003)
    expect((await (await rpc(h, "GetExtendedAgentCard", {})).json()).error.code).toBe(-32007)
  })

  test("malformed JSON → -32700 with id null", async () => {
    const { h } = setup(answer)
    const res = await h.fetch(
      new Request(`${BASE}/a2a`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "A2A-Version": "1.0" }, body: "{nope" }),
    )
    const body = await res.json()
    expect(body.error.code).toBe(-32700)
    expect(body.id).toBeNull()
  })

  test("ListTasks filters by contextId", async () => {
    const { h } = setup(answer)
    await rpc(h, "SendMessage", { message: userMessage("a", { contextId: "c1" }) })
    await rpc(h, "SendMessage", { message: userMessage("b", { contextId: "c2" }) })
    const r = (await (await rpc(h, "ListTasks", { contextId: "c1" })).json()).result
    expect(r.totalSize).toBe(1)
    expect(r.tasks[0].contextId).toBe("c1")
    expect(r.tasks[0].artifacts).toBeUndefined() // includeArtifacts defaults false
    expect(r.nextPageToken).toBe("")
  })

  test("store is capped; terminal tasks are evicted", async () => {
    const h = createA2AHandler({ card: card(), execute: answer, maxTasks: 3 })
    for (let i = 0; i < 6; i++) await rpc(h, "SendMessage", { message: userMessage(String(i)) })
    expect(h.tasks.size).toBe(3)
  })
})

describe("iris a2a call — our client against our server", () => {
  test("non-streaming: fetches the card, sends a task, returns the artifact text", async () => {
    const { fetchImpl } = setup(answer)
    const r = await a2aCall({ url: BASE, text: "ping", token: TOKEN, fetchImpl })
    expect(r.task?.status.state).toBe("TASK_STATE_COMPLETED")
    expect(r.text).toBe("answer to: ping")
    expect(r.endpoint).toBe(`${BASE}/a2a`)
  })

  test("streaming: reassembles chunks into the answer", async () => {
    const { fetchImpl } = setup(async function* () {
      yield "a"
      yield "b"
    })
    const seen: string[] = []
    const r = await a2aCall({ url: BASE, text: "x", token: TOKEN, stream: true, fetchImpl, onEvent: (e) => seen.push(Object.keys(e)[0]!) })
    expect(r.text).toBe("ab")
    expect(r.task?.status.state).toBe("TASK_STATE_COMPLETED")
    expect(seen[0]).toBe("task")
  })

  test("no token → a clear 401 error, not a silent empty answer", async () => {
    const { fetchImpl } = setup(answer)
    await expect(a2aCall({ url: BASE, text: "x", fetchImpl })).rejects.toThrow(/401/)
  })
})

describe("real executor output parsing (iris chat --json)", () => {
  test("completed envelope → response text", () => {
    expect(parseAgentAskOutput({ stdout: '{"status":"completed","response":"pong"}\n', stderr: "", exitCode: 0 })).toBe("pong")
  })
  test("error object + failed envelope → throws with the reason (task will be FAILED)", () => {
    const stdout = '{"error":"Agent not found","status":404}\n{"status":"failed"}\n'
    expect(() => parseAgentAskOutput({ stdout, stderr: "", exitCode: 1 })).toThrow(/Agent not found/)
  })
  test("contextId maps to a sanitized thread name", () => {
    expect(threadForContext("ab c/;$d")).toBe("a2a_abcd")
  })
})
