/**
 * A2A (Agent2Agent) protocol — server side, JSON-RPC binding.
 *
 * SPEC PIN: A2A v1.0.1 — github.com/a2aproject/A2A, tag v1.0.1 (2026-05-28).
 *   Wire protocol version "1.0" (A2A-Version header, AgentInterface.protocolVersion).
 *   Every shape below is ProtoJSON of specification/a2a.proto at that tag: camelCase
 *   fields, enums as their FULL names ("TASK_STATE_COMPLETED", "ROLE_USER"), no `kind`
 *   discriminators (those were v0.3), timestamps ISO-8601 UTC.
 *
 * If you bump the pin, re-read "What's new in v1" first. v0.3 → v1.0 changed the wire
 * shape of nearly everything (kind discriminators, enum spelling, the `final` flag on
 * stream events was REMOVED — a stream now ends by closing), and a server that half-moves
 * produces the classic false green: the agent card resolves, the task exchange fails.
 *
 * This module is pure protocol: no CLI, no platform calls. The work is done by the
 * injected `execute` function, which is what makes the whole exchange testable with a
 * fake executor and no network.
 */

export const A2A_SPEC_PIN = "A2A v1.0.1 (github.com/a2aproject/A2A tag v1.0.1, 2026-05-28)"
export const A2A_PROTOCOL_VERSION = "1.0"
export const AGENT_CARD_PATH = "/.well-known/agent-card.json"

// ---------------------------------------------------------------------------
// Types (ProtoJSON of a2a.proto v1.0.1 — only what this server reads or writes)
// ---------------------------------------------------------------------------

export type Role = "ROLE_USER" | "ROLE_AGENT"

export type TaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_AUTH_REQUIRED"

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
])

/** Exactly one of text | raw | url | data, plus optional metadata. */
export type Part = {
  text?: string
  raw?: string
  url?: string
  data?: unknown
  mediaType?: string
  filename?: string
  metadata?: Record<string, unknown>
}

export type Message = {
  messageId: string
  role: Role
  parts: Part[]
  contextId?: string
  taskId?: string
  metadata?: Record<string, unknown>
  extensions?: string[]
  referenceTaskIds?: string[]
}

export type TaskStatus = { state: TaskState; message?: Message; timestamp?: string }

export type Artifact = {
  artifactId: string
  name?: string
  description?: string
  parts: Part[]
  metadata?: Record<string, unknown>
}

export type Task = {
  id: string
  contextId: string
  status: TaskStatus
  artifacts?: Artifact[]
  history?: Message[]
  metadata?: Record<string, unknown>
}

export type StreamResponse =
  | { task: Task }
  | { message: Message }
  | { statusUpdate: { taskId: string; contextId: string; status: TaskStatus; metadata?: Record<string, unknown> } }
  | {
      artifactUpdate: {
        taskId: string
        contextId: string
        artifact: Artifact
        append?: boolean
        lastChunk?: boolean
      }
    }

export type AgentSkill = {
  id: string
  name: string
  description: string
  tags: string[]
  examples?: string[]
  inputModes?: string[]
  outputModes?: string[]
}

export type AgentCard = {
  name: string
  description: string
  version: string
  supportedInterfaces: { url: string; protocolBinding: string; protocolVersion: string; tenant?: string }[]
  provider?: { organization: string; url: string }
  documentationUrl?: string
  capabilities: { streaming?: boolean; pushNotifications?: boolean; extendedAgentCard?: boolean }
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: AgentSkill[]
}

export type ExecuteInput = {
  /** All text-bearing parts of the user message, joined. What a text-only agent answers. */
  text: string
  /** The message as received, for executors that want the structured parts. */
  message: Message
  contextId: string
  taskId: string
  /** Aborted by CancelTask. An executor that ignores it cannot be canceled. */
  signal: AbortSignal
}

/** Returns the whole answer, or streams it as chunks. Throwing marks the task FAILED. */
export type Execute = (input: ExecuteInput) => AsyncIterable<string> | Promise<string>

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  TaskNotFound: -32001,
  TaskNotCancelable: -32002,
  PushNotificationNotSupported: -32003,
  UnsupportedOperation: -32004,
  ContentTypeNotSupported: -32005,
  ExtendedAgentCardNotConfigured: -32007,
  VersionNotSupported: -32009,
} as const

type RpcId = string | number | null

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

function rpcResult(id: RpcId, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result })
}

function rpcError(id: RpcId, err: RpcError): Response {
  const error: Record<string, unknown> = { code: err.code, message: err.message }
  if (err.data !== undefined) error.data = err.data
  // JSON-RPC errors travel as HTTP 200 — the error is in the body, not the status line.
  return Response.json({ jsonrpc: "2.0", id, error })
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export type A2AHandlerOptions = {
  card: AgentCard
  execute: Execute
  /** When set, the JSON-RPC endpoint requires `Authorization: Bearer <token>`. The card stays public. */
  token?: string
  /** Path the JSON-RPC endpoint is served on. Must match the card's interface url. Default "/a2a". */
  rpcPath?: string
  /** In-memory store cap. Oldest TERMINAL tasks are evicted first. Default 1000. */
  maxTasks?: number
  /** When set, requests whose Host header is not in this list get 403 (DNS-rebinding guard). */
  allowedHosts?: string[]
}

type Listener = (ev: StreamResponse) => void

type TaskRecord = {
  task: Task
  controller: AbortController
  listeners: Set<Listener>
  done: Promise<void>
  createdAt: number
}

const TEXT_INPUT_TYPES = [/^text\//i, /^application\/json$/i]
const OUTPUT_TYPE_OK = [/^text\/plain$/i, /^text\/\*$/i, /^\*\/\*$/, /^text\/markdown$/i]

function now(): string {
  return new Date().toISOString()
}

function uuid(): string {
  return crypto.randomUUID()
}

function isRecord(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a)
  const bb = new TextEncoder().encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!
  return diff === 0
}

/** Validate the message shape and pull out the text a text-only agent can answer. */
export function messageText(message: Message): string {
  const out: string[] = []
  for (const p of message.parts) {
    if (typeof p.text === "string") out.push(p.text)
    else if (p.data !== undefined) out.push(JSON.stringify(p.data))
    else if (typeof p.url === "string") out.push(`[attachment${p.filename ? ` ${p.filename}` : ""}: ${p.url}]`)
    else if (typeof p.raw === "string") {
      try {
        out.push(Buffer.from(p.raw, "base64").toString("utf-8"))
      } catch {
        out.push(`[binary attachment${p.filename ? ` ${p.filename}` : ""}]`)
      }
    }
  }
  return out.join("\n").trim()
}

function validateMessage(m: unknown): Message {
  if (!isRecord(m)) throw new RpcError(ErrorCode.InvalidParams, "params.message is required")
  if (typeof m.messageId !== "string" || !m.messageId)
    throw new RpcError(ErrorCode.InvalidParams, "message.messageId is required")
  if (m.role !== "ROLE_USER" && m.role !== "ROLE_AGENT")
    throw new RpcError(ErrorCode.InvalidParams, 'message.role must be "ROLE_USER" or "ROLE_AGENT"')
  if (!Array.isArray(m.parts) || m.parts.length === 0)
    throw new RpcError(ErrorCode.InvalidParams, "message.parts must be a non-empty array")
  m.parts.forEach((p: unknown, i: number) => {
    if (!isRecord(p)) throw new RpcError(ErrorCode.InvalidParams, `message.parts[${i}] must be an object`)
    const kinds = ["text", "raw", "url", "data"].filter((k) => p[k] !== undefined)
    if (kinds.length !== 1)
      throw new RpcError(
        ErrorCode.InvalidParams,
        `message.parts[${i}] must carry exactly one of text | raw | url | data (got ${kinds.length ? kinds.join(", ") : "none"})`,
      )
    if ((p.raw !== undefined || p.url !== undefined) && typeof p.mediaType === "string") {
      if (!TEXT_INPUT_TYPES.some((re) => re.test(p.mediaType)))
        throw new RpcError(
          ErrorCode.ContentTypeNotSupported,
          `message.parts[${i}] has mediaType ${p.mediaType}; this agent accepts text/* and application/json`,
        )
    }
  })
  if (m.contextId !== undefined && typeof m.contextId !== "string")
    throw new RpcError(ErrorCode.InvalidParams, "message.contextId must be a string")
  if (m.taskId !== undefined && typeof m.taskId !== "string")
    throw new RpcError(ErrorCode.InvalidParams, "message.taskId must be a string")
  return m as Message
}

function snapshot(rec: TaskRecord, opts: { historyLength?: number; includeArtifacts?: boolean } = {}): Task {
  const t = rec.task
  const out: Task = { id: t.id, contextId: t.contextId, status: structuredClone(t.status) }
  if (opts.includeArtifacts !== false && t.artifacts?.length) out.artifacts = structuredClone(t.artifacts)
  const hl = opts.historyLength
  if (t.history?.length && hl !== 0) {
    const h = typeof hl === "number" && hl > 0 ? t.history.slice(-hl) : t.history
    out.history = structuredClone(h)
  }
  if (t.metadata) out.metadata = structuredClone(t.metadata)
  return out
}

function optionalInt(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== "number" || !Number.isInteger(v)) throw new RpcError(ErrorCode.InvalidParams, `${name} must be an integer`)
  return v
}

export function createA2AHandler(opts: A2AHandlerOptions) {
  const rpcPath = opts.rpcPath ?? "/a2a"
  const maxTasks = opts.maxTasks ?? 1000
  const tasks = new Map<string, TaskRecord>()

  function evict() {
    if (tasks.size <= maxTasks) return
    for (const [id, rec] of tasks) {
      if (tasks.size <= maxTasks) break
      if (TERMINAL_STATES.has(rec.task.status.state)) tasks.delete(id)
    }
  }

  function emit(rec: TaskRecord, ev: StreamResponse) {
    for (const l of rec.listeners) l(ev)
  }

  function setStatus(rec: TaskRecord, state: TaskState, message?: Message) {
    rec.task.status = { state, timestamp: now(), ...(message ? { message } : {}) }
    emit(rec, { statusUpdate: { taskId: rec.task.id, contextId: rec.task.contextId, status: structuredClone(rec.task.status) } })
  }

  function agentMessage(rec: TaskRecord, text: string): Message {
    return {
      messageId: uuid(),
      role: "ROLE_AGENT",
      parts: [{ text }],
      contextId: rec.task.contextId,
      taskId: rec.task.id,
    }
  }

  function startTask(message: Message, onCreate?: (rec: TaskRecord) => void): TaskRecord {
    if (message.taskId) {
      const existing = tasks.get(message.taskId)
      if (!existing) throw new RpcError(ErrorCode.TaskNotFound, `Task not found: ${message.taskId}`)
      // Every task this agent runs goes straight to a terminal state — it never parks in
      // INPUT_REQUIRED — so a follow-up message on an existing task has nothing to join.
      // Continue a conversation with the same contextId and a new task instead.
      throw new RpcError(
        ErrorCode.UnsupportedOperation,
        TERMINAL_STATES.has(existing.task.status.state)
          ? `Task ${message.taskId} is in terminal state ${existing.task.status.state} and cannot accept further messages; send a new message with the same contextId instead`
          : `Task ${message.taskId} is still running and does not accept additional input`,
      )
    }
    const contextId = message.contextId || uuid()
    const id = uuid()
    const userMsg: Message = { ...message, contextId, taskId: id }
    const controller = new AbortController()
    const rec: TaskRecord = {
      task: {
        id,
        contextId,
        status: { state: "TASK_STATE_SUBMITTED", timestamp: now() },
        history: [userMsg],
      },
      controller,
      listeners: new Set(),
      done: Promise.resolve(),
      createdAt: Date.now(),
    }
    tasks.set(id, rec)
    evict()
    onCreate?.(rec)
    rec.done = run(rec, userMsg)
    return rec
  }

  async function run(rec: TaskRecord, userMsg: Message): Promise<void> {
    // Yield once so a streaming caller has enqueued the initial Task event before any
    // update — the spec requires the Task to be the first thing on the stream.
    await Promise.resolve()
    const signal = rec.controller.signal
    const artifactId = uuid()
    let text = ""
    let chunks = 0
    try {
      setStatus(rec, "TASK_STATE_WORKING")
      const produced = opts.execute({
        text: messageText(userMsg),
        message: userMsg,
        contextId: rec.task.contextId,
        taskId: rec.task.id,
        signal,
      })
      const pushChunk = (chunk: string, lastChunk: boolean) => {
        if (signal.aborted || (!chunk && !lastChunk)) return
        text += chunk
        emit(rec, {
          artifactUpdate: {
            taskId: rec.task.id,
            contextId: rec.task.contextId,
            artifact: { artifactId, name: "response", parts: [{ text: chunk }] },
            append: chunks > 0,
            lastChunk,
          },
        })
        chunks++
      }
      if (typeof (produced as any)?.[Symbol.asyncIterator] === "function") {
        for await (const chunk of produced as AsyncIterable<string>) {
          if (signal.aborted) break
          pushChunk(String(chunk), false)
        }
        // An iterator cannot say which chunk is its last, so the end is marked with an
        // empty appended chunk. A stream consumer concatenating parts is unaffected.
        pushChunk("", true)
      } else {
        pushChunk(String(await (produced as Promise<string>)), true)
      }
      if (signal.aborted) return // CancelTask already set CANCELED
      rec.task.artifacts = [{ artifactId, name: "response", parts: [{ text }] }]
      const reply = agentMessage(rec, text)
      rec.task.history = [...(rec.task.history ?? []), reply]
      setStatus(rec, "TASK_STATE_COMPLETED")
    } catch (e) {
      if (signal.aborted) return
      const why = e instanceof Error ? e.message : String(e)
      setStatus(rec, "TASK_STATE_FAILED", agentMessage(rec, why || "the agent failed with no message"))
    } finally {
      rec.listeners.clear()
    }
  }

  function cancel(id: string): Task {
    const rec = tasks.get(id)
    if (!rec) throw new RpcError(ErrorCode.TaskNotFound, `Task not found: ${id}`)
    if (TERMINAL_STATES.has(rec.task.status.state))
      throw new RpcError(ErrorCode.TaskNotCancelable, `Task ${id} is already ${rec.task.status.state}`)
    rec.controller.abort()
    setStatus(rec, "TASK_STATE_CANCELED")
    const snap = snapshot(rec)
    rec.listeners.clear()
    return snap
  }

  /**
   * An SSE response whose first event is `first` (a Task snapshot), followed by every
   * update to `rec`, closed when the task reaches a terminal state. v1.0 has no `final`
   * flag — closing the stream IS the end signal.
   */
  function sseFor(id: RpcId, rec: TaskRecord, first: StreamResponse): Response {
    const enc = new TextEncoder()
    let listener: Listener | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (ev: StreamResponse) =>
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result: ev })}\n\n`))
        send(first)
        if (TERMINAL_STATES.has(rec.task.status.state)) {
          controller.close()
          return
        }
        listener = (ev) => {
          try {
            send(ev)
          } catch {
            // client went away mid-write
          }
          if ("statusUpdate" in ev && TERMINAL_STATES.has(ev.statusUpdate.status.state)) {
            rec.listeners.delete(listener!)
            try {
              controller.close()
            } catch {}
          }
        }
        rec.listeners.add(listener)
      },
      cancel() {
        // Client disconnected. That ends the SUBSCRIPTION, not the task — cancelling
        // work is what CancelTask is for.
        if (listener) rec.listeners.delete(listener)
      },
    })
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    })
  }

  function checkOutputModes(configuration: unknown) {
    if (!isRecord(configuration)) return
    const modes = configuration.acceptedOutputModes
    if (Array.isArray(modes) && modes.length > 0 && !modes.some((m) => typeof m === "string" && OUTPUT_TYPE_OK.some((re) => re.test(m))))
      throw new RpcError(
        ErrorCode.ContentTypeNotSupported,
        `This agent answers in text/plain; acceptedOutputModes ${JSON.stringify(modes)} excludes it`,
      )
  }

  async function dispatch(id: RpcId, method: string, params: Record<string, any>): Promise<Response> {
    switch (method) {
      case "SendMessage": {
        const message = validateMessage(params.message)
        checkOutputModes(params.configuration)
        const historyLength = optionalInt(params.configuration?.historyLength, "configuration.historyLength")
        const rec = startTask(message)
        // Blocking is the DEFAULT (returnImmediately false/unset): wait for a terminal state.
        if (params.configuration?.returnImmediately !== true) await rec.done
        return rpcResult(id, { task: snapshot(rec, { historyLength }) })
      }
      case "SendStreamingMessage": {
        const message = validateMessage(params.message)
        checkOutputModes(params.configuration)
        let response: Response | undefined
        startTask(message, (rec) => {
          response = sseFor(id, rec, { task: snapshot(rec) })
        })
        return response!
      }
      case "GetTask": {
        if (typeof params.id !== "string") throw new RpcError(ErrorCode.InvalidParams, "params.id is required")
        const rec = tasks.get(params.id)
        if (!rec) throw new RpcError(ErrorCode.TaskNotFound, `Task not found: ${params.id}`)
        return rpcResult(id, snapshot(rec, { historyLength: optionalInt(params.historyLength, "historyLength") }))
      }
      case "ListTasks": {
        const pageSize = Math.min(Math.max(optionalInt(params.pageSize, "pageSize") ?? 50, 1), 100)
        const offset = params.pageToken ? Number.parseInt(String(params.pageToken), 10) : 0
        if (!Number.isInteger(offset) || offset < 0) throw new RpcError(ErrorCode.InvalidParams, "pageToken is invalid")
        const after = typeof params.statusTimestampAfter === "string" ? Date.parse(params.statusTimestampAfter) : NaN
        const all = [...tasks.values()]
          .filter((r) => !params.contextId || r.task.contextId === params.contextId)
          .filter((r) => !params.status || params.status === "TASK_STATE_UNSPECIFIED" || r.task.status.state === params.status)
          .filter((r) => Number.isNaN(after) || Date.parse(r.task.status.timestamp ?? "") > after)
          .sort((a, b) => b.createdAt - a.createdAt)
        const page = all.slice(offset, offset + pageSize)
        const historyLength = optionalInt(params.historyLength, "historyLength")
        return rpcResult(id, {
          tasks: page.map((r) => snapshot(r, { historyLength, includeArtifacts: params.includeArtifacts === true })),
          nextPageToken: offset + pageSize < all.length ? String(offset + pageSize) : "",
          pageSize,
          totalSize: all.length,
        })
      }
      case "CancelTask": {
        if (typeof params.id !== "string") throw new RpcError(ErrorCode.InvalidParams, "params.id is required")
        return rpcResult(id, cancel(params.id))
      }
      case "SubscribeToTask": {
        if (typeof params.id !== "string") throw new RpcError(ErrorCode.InvalidParams, "params.id is required")
        const rec = tasks.get(params.id)
        if (!rec) throw new RpcError(ErrorCode.TaskNotFound, `Task not found: ${params.id}`)
        if (TERMINAL_STATES.has(rec.task.status.state))
          throw new RpcError(ErrorCode.UnsupportedOperation, `Task ${params.id} is in terminal state ${rec.task.status.state}`)
        return sseFor(id, rec, { task: snapshot(rec) })
      }
      case "CreateTaskPushNotificationConfig":
      case "GetTaskPushNotificationConfig":
      case "ListTaskPushNotificationConfigs":
      case "DeleteTaskPushNotificationConfig":
        throw new RpcError(ErrorCode.PushNotificationNotSupported, "Push notifications are not supported by this agent")
      case "GetExtendedAgentCard":
        throw new RpcError(ErrorCode.ExtendedAgentCardNotConfigured, "This agent has no extended agent card")
      default:
        throw new RpcError(ErrorCode.MethodNotFound, `Method not found: ${method}`)
    }
  }

  async function handleRpc(req: Request, url: URL): Promise<Response> {
    let body: unknown
    try {
      body = JSON.parse(await req.text())
    } catch {
      return rpcError(null, new RpcError(ErrorCode.ParseError, "Parse error"))
    }
    if (!isRecord(body)) return rpcError(null, new RpcError(ErrorCode.InvalidRequest, "Request must be a single JSON-RPC object"))
    const rawId = body.id
    const id: RpcId = typeof rawId === "string" || typeof rawId === "number" ? rawId : null
    if (body.jsonrpc !== "2.0" || typeof body.method !== "string" || id === null)
      return rpcError(id, new RpcError(ErrorCode.InvalidRequest, "Invalid JSON-RPC 2.0 request (jsonrpc, method and id are required)"))

    // Spec §3.x: clients MUST send A2A-Version; an empty value means 0.3. Also accepted as
    // a query parameter. We speak 1.0 only, so 0.3 (or anything else) is refused rather
    // than answered in a shape the client did not ask for.
    const version = (req.headers.get("A2A-Version") ?? url.searchParams.get("A2A-Version") ?? "").trim()
    if (!/^1\.0(\.\d+)?$/.test(version)) {
      return rpcError(
        id,
        new RpcError(
          ErrorCode.VersionNotSupported,
          `A2A version ${version ? `"${version}"` : "0.3 (no A2A-Version header)"} is not supported; this agent speaks ${A2A_PROTOCOL_VERSION}`,
          { supportedVersions: [A2A_PROTOCOL_VERSION] },
        ),
      )
    }

    const params = body.params === undefined ? {} : body.params
    if (!isRecord(params)) return rpcError(id, new RpcError(ErrorCode.InvalidParams, "params must be an object"))
    try {
      return await dispatch(id, body.method, params)
    } catch (e) {
      if (e instanceof RpcError) return rpcError(id, e)
      return rpcError(id, new RpcError(ErrorCode.InternalError, e instanceof Error ? e.message : String(e)))
    }
  }

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (opts.allowedHosts && !opts.allowedHosts.includes(req.headers.get("host") ?? ""))
      return new Response("Forbidden host", { status: 403 })

    if (url.pathname === AGENT_CARD_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 })
      // Discovery is public by design — a client has to read the card to learn how to auth.
      return Response.json(opts.card, { headers: { "Access-Control-Allow-Origin": "*" } })
    }

    if (url.pathname === rpcPath) {
      if (opts.token) {
        const auth = req.headers.get("authorization") ?? ""
        if (!constantTimeEqual(auth, `Bearer ${opts.token}`))
          return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="a2a"' } })
      }
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } })
      return handleRpc(req, url)
    }

    return new Response("Not Found", { status: 404 })
  }

  return { fetch, tasks }
}
