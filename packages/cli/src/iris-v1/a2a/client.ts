/**
 * A2A (Agent2Agent) protocol — minimal client, JSON-RPC binding.
 *
 * SPEC PIN: A2A v1.0.1 — github.com/a2aproject/A2A, tag v1.0.1 (2026-05-28). Sends
 * `A2A-Version: 1.0`. See ./server.ts for the wire-shape notes.
 *
 * Deliberately hand-written rather than the official SDK: it is ~150 lines, has no
 * dependencies, and the interop test runs it against the SDK's own server so it cannot
 * quietly drift into a dialect only we speak.
 */
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, type AgentCard, type Message, type Part, type Task } from "./server"

export type A2ACallOptions = {
  /** Agent base URL (card at <url>/.well-known/agent-card.json) or a direct URL to a card .json. */
  url: string
  text: string
  token?: string
  stream?: boolean
  contextId?: string
  fetchImpl?: typeof fetch
  /** Called for every stream event, in order. Only used with `stream: true`. */
  onEvent?: (ev: Record<string, any>) => void
}

export type A2ACallResult = {
  card: AgentCard
  endpoint: string
  /** Present when the agent answered with a Task (the usual case). */
  task?: Task
  /** Present when the agent answered with a bare Message instead of a Task. */
  message?: Message
  /** The answer as text: artifact text, else the status/reply message text. */
  text: string
}

export class A2AError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

export function cardUrlFor(url: string): string {
  if (/\.json(\?|$)/.test(url)) return url
  return url.replace(/\/+$/, "") + AGENT_CARD_PATH
}

/** Pick the JSON-RPC interface, preferring protocolVersion 1.0 — the same rule the SDK uses. */
export function pickJsonRpcInterface(card: AgentCard): { url: string; protocolVersion: string } {
  const ifaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : []
  const rpc = ifaces.filter((i) => String(i.protocolBinding).toUpperCase() === "JSONRPC")
  const best = rpc.find((i) => i.protocolVersion === A2A_PROTOCOL_VERSION) ?? rpc[0]
  if (!best) {
    const legacy = (card as any).url && !ifaces.length
    throw new A2AError(
      legacy
        ? "Agent card has no supportedInterfaces — it looks like an A2A v0.3 card; this client speaks v1.0"
        : `Agent card offers no JSONRPC interface (have: ${ifaces.map((i) => i.protocolBinding).join(", ") || "none"})`,
    )
  }
  return best
}

function partsText(parts: Part[] | undefined): string {
  return (parts ?? [])
    .map((p) => (typeof p.text === "string" ? p.text : p.data !== undefined ? JSON.stringify(p.data) : p.url ?? ""))
    .join("")
}

export function taskText(task: Task): string {
  const fromArtifacts = (task.artifacts ?? []).map((a) => partsText(a.parts)).join("\n")
  if (fromArtifacts) return fromArtifacts
  if (task.status?.message) return partsText(task.status.message.parts)
  const lastAgent = [...(task.history ?? [])].reverse().find((m) => m.role === "ROLE_AGENT")
  return lastAgent ? partsText(lastAgent.parts) : ""
}

async function* sseEvents(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "")
      const data = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n")
      if (data) yield data
    }
  }
}

function rpcFail(error: any): never {
  throw new A2AError(`A2A error ${error?.code}: ${error?.message ?? "unknown"}`, error?.code, error?.data)
}

export async function a2aCall(opts: A2ACallOptions): Promise<A2ACallResult> {
  const f = opts.fetchImpl ?? fetch
  const cardRes = await f(cardUrlFor(opts.url), { headers: { Accept: "application/json" } })
  if (!cardRes.ok) throw new A2AError(`Could not fetch agent card (${cardRes.status}) from ${cardUrlFor(opts.url)}`)
  const card = (await cardRes.json()) as AgentCard
  const iface = pickJsonRpcInterface(card)

  const message: Message = {
    messageId: crypto.randomUUID(),
    role: "ROLE_USER",
    parts: [{ text: opts.text }],
    ...(opts.contextId ? { contextId: opts.contextId } : {}),
  }
  const id = 1
  const body = {
    jsonrpc: "2.0",
    id,
    method: opts.stream ? "SendStreamingMessage" : "SendMessage",
    params: { message, configuration: { acceptedOutputModes: ["text/plain"] } },
  }
  const res = await f(iface.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: opts.stream ? "text/event-stream" : "application/json",
      "A2A-Version": A2A_PROTOCOL_VERSION,
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  if (res.status === 401) throw new A2AError(`401 Unauthorized from ${iface.url} — pass --token`)
  const ctype = res.headers.get("content-type") ?? ""

  if (!ctype.startsWith("text/event-stream")) {
    const text = await res.text()
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      throw new A2AError(`HTTP ${res.status} from ${iface.url}: ${text.slice(0, 300) || "(empty)"}`)
    }
    if (json.error) rpcFail(json.error)
    if (json.id !== id) throw new A2AError(`JSON-RPC id mismatch: sent ${id}, got ${JSON.stringify(json.id)}`)
    const result = json.result ?? {}
    if (result.task) return { card, endpoint: iface.url, task: result.task, text: taskText(result.task) }
    if (result.message) return { card, endpoint: iface.url, message: result.message, text: partsText(result.message.parts) }
    throw new A2AError(`SendMessage result is neither {task} nor {message}: ${JSON.stringify(result).slice(0, 300)}`)
  }

  // Streaming: the first event is the Task (or a bare Message); then status and artifact
  // updates. v1.0 has no `final` flag — the server closes the stream when the task is done.
  let task: Task | undefined
  let message_: Message | undefined
  const artifacts = new Map<string, { artifactId: string; name?: string; parts: Part[] }>()
  for await (const data of sseEvents(res)) {
    const ev = JSON.parse(data)
    if (ev.error) rpcFail(ev.error)
    if (ev.id !== id) throw new A2AError(`JSON-RPC id mismatch in stream: sent ${id}, got ${JSON.stringify(ev.id)}`)
    const r = ev.result ?? {}
    opts.onEvent?.(r)
    if (r.task) {
      task = r.task
      for (const a of r.task.artifacts ?? []) artifacts.set(a.artifactId, structuredClone(a))
    } else if (r.message) {
      message_ = r.message
    } else if (r.statusUpdate && task) {
      task.status = r.statusUpdate.status
    } else if (r.artifactUpdate) {
      const a = r.artifactUpdate.artifact
      const prev = artifacts.get(a.artifactId)
      if (prev && r.artifactUpdate.append) prev.parts.push(...a.parts)
      else artifacts.set(a.artifactId, structuredClone(a))
    }
  }
  if (message_ && !task) return { card, endpoint: iface.url, message: message_, text: partsText(message_.parts) }
  if (!task) throw new A2AError("Stream ended without a Task or Message")
  task.artifacts = [...artifacts.values()].map((a) => ({ ...a, parts: [{ text: partsText(a.parts) }] }))
  return { card, endpoint: iface.url, task, text: taskText(task) }
}
