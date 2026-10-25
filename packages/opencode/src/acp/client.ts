/**
 * The other half of ACP (#191163). `iris acp` makes IRIS an agent that Zed, Buzz or T3 Code can
 * drive. This file makes IRIS the CLIENT: it starts a real coding agent — Claude Code, Codex,
 * Gemini, opencode, or IRIS itself — speaks the Agent Client Protocol to it, streams its answer,
 * prints every file change it proposes, and stops at a permission prompt before anything risky.
 *
 * The agent runs under its own login, settings and billing. We never hold a provider key: that is
 * the point of the protocol ("your subscriptions, billing, and features still depend on each
 * provider"), and it means there is no second set of books to reconcile.
 *
 * Nothing here downloads an agent. An adapter that is not installed is reported with the command
 * that installs it; running `npx -y <adapter>` on the user's behalf would be installing arbitrary
 * code the user never chose (competitive-gap-analysis, step:security).
 */
import { spawn, type ChildProcess } from "node:child_process"
import { Readable, Writable } from "node:stream"
import fs from "node:fs/promises"
import path from "node:path"
import { createTwoFilesPatch } from "diff"
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk"

export interface AcpAgentSpec {
  id: string
  name: string
  /** argv; argv[0] is looked up on PATH */
  command: string[]
  /** what has to be on PATH for this agent to run at all (the adapter, and the agent it wraps) */
  requires: string[]
  install: string
  note?: string
}

/**
 * Agents that speak ACP, natively or through an adapter. Order is the order `iris acp agents`
 * prints and the order `--agent auto` tries.
 */
export const ACP_AGENTS: AcpAgentSpec[] = [
  {
    id: "claude",
    name: "Claude Code",
    command: ["claude-code-acp"],
    requires: ["claude-code-acp"],
    install: "npm install -g @zed-industries/claude-code-acp",
    note: "adapter; uses your Claude Code login and settings",
  },
  {
    id: "codex",
    name: "Codex",
    command: ["codex-acp"],
    requires: ["codex-acp"],
    install: "npm install -g @zed-industries/codex-acp",
    note: "adapter; uses your Codex / ChatGPT login",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    command: ["gemini", "--experimental-acp"],
    requires: ["gemini"],
    install: "npm install -g @google/gemini-cli",
    note: "native",
  },
  {
    id: "opencode",
    name: "opencode",
    command: ["opencode", "acp"],
    requires: ["opencode"],
    install: "npm install -g opencode-ai",
    note: "native",
  },
  {
    id: "iris",
    name: "IRIS",
    command: ["iris", "acp"],
    requires: ["iris"],
    install: "curl -fsSL https://heyiris.io/install | bash",
    note: "native; this CLI",
  },
]

export type Which = (bin: string) => string | null

export function findAgent(id: string): AcpAgentSpec | undefined {
  const key = id.toLowerCase()
  return ACP_AGENTS.find((a) => a.id === key || a.name.toLowerCase() === key)
}

export function agentInstalled(spec: AcpAgentSpec, which: Which): boolean {
  return spec.requires.every((bin) => which(bin) !== null)
}

/**
 * `--agent` → argv. A known id resolves through the registry; anything else is taken as a raw
 * command line ("my-agent --acp"), so an agent we have never heard of still works.
 */
export function resolveAgentCommand(
  agent: string,
  which: Which,
): { spec?: AcpAgentSpec; argv: string[]; missing?: string } {
  if (agent === "auto") {
    const spec = ACP_AGENTS.find((a) => a.id !== "iris" && agentInstalled(a, which)) ?? findAgent("iris")!
    return { spec, argv: spec.command }
  }
  const spec = findAgent(agent)
  if (spec) {
    const missing = spec.requires.find((bin) => which(bin) === null)
    return { spec, argv: spec.command, missing }
  }
  const argv = agent.split(/\s+/).filter(Boolean)
  return { argv, missing: which(argv[0]) === null ? argv[0] : undefined }
}

// ---------------------------------------------------------------------------------------------
// Rendering. Pure: an update in, the lines to print out. The command decides where they go.
// ---------------------------------------------------------------------------------------------

export function renderDiff(file: string, oldText: string | null | undefined, newText: string): string {
  const patch = createTwoFilesPatch(file, file, oldText ?? "", newText, oldText == null ? "(new file)" : "", "", {
    context: 3,
  })
  // drop the "Index:" / "====" preamble; keep ---/+++ and hunks
  return patch
    .split("\n")
    .filter((l) => !l.startsWith("Index:") && !/^=+$/.test(l))
    .join("\n")
    .trimEnd()
}

type Update = SessionNotification["update"]
type ToolContent = NonNullable<Extract<Update, { sessionUpdate: "tool_call" }>["content"]>[number]

function renderToolContent(content: ToolContent[] | null | undefined): string[] {
  const out: string[] = []
  for (const c of content ?? []) {
    if (c.type === "diff") out.push(renderDiff(c.path, c.oldText, c.newText))
    else if (c.type === "content" && c.content.type === "text" && c.content.text.trim()) out.push(c.content.text.trimEnd())
  }
  return out
}

export interface RenderOptions {
  thoughts?: boolean
}

/**
 * Returns text to write as-is. Message chunks come back unterminated so a streamed answer reads as
 * one paragraph; everything else is a whole line.
 */
export function renderUpdate(update: Update, opts: RenderOptions = {}): string {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return update.content.type === "text" ? update.content.text : ""
    case "agent_thought_chunk":
      return opts.thoughts && update.content.type === "text" ? update.content.text : ""
    case "tool_call": {
      const head = `\n▸ ${update.title}${update.kind ? ` [${update.kind}]` : ""}`
      return [head, ...renderToolContent(update.content)].join("\n") + "\n"
    }
    case "tool_call_update": {
      const lines = renderToolContent(update.content)
      if (update.status === "failed") lines.unshift(`✗ ${update.title ?? update.toolCallId} failed`)
      return lines.length ? lines.join("\n") + "\n" : ""
    }
    case "plan":
      return (
        "\nplan:\n" +
        update.entries
          .map((e) => `  ${e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "·"} ${e.content}`)
          .join("\n") +
        "\n"
      )
    default:
      return ""
  }
}

// ---------------------------------------------------------------------------------------------
// Permission. The agent asks; the user (or the --yes policy) answers with one of ITS options.
// ---------------------------------------------------------------------------------------------

export type PermissionPolicy = "ask" | "allow" | "deny"

export function describePermission(req: RequestPermissionRequest): string {
  const t = req.toolCall
  const lines = [`\n? ${t.title ?? "the agent wants to run a tool"}${t.kind ? ` [${t.kind}]` : ""}`]
  lines.push(...renderToolContent(t.content as ToolContent[] | undefined))
  req.options.forEach((o, i) => lines.push(`  ${i + 1}) ${o.name}`))
  return lines.join("\n")
}

/** Pick an option without asking: "allow" takes allow_once (never allow_always), "deny" takes reject_once. */
export function decidePermission(
  req: RequestPermissionRequest,
  policy: Exclude<PermissionPolicy, "ask">,
): RequestPermissionResponse {
  const want = policy === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"]
  for (const kind of want) {
    const o = req.options.find((x) => x.kind === kind)
    if (o) return { outcome: { outcome: "selected", optionId: o.optionId } }
  }
  return { outcome: { outcome: "cancelled" } }
}

/** "2", "y", "n", or an option name → a response; anything unrecognised is null (ask again). */
export function parsePermissionAnswer(req: RequestPermissionRequest, answer: string): RequestPermissionResponse | null {
  const a = answer.trim().toLowerCase()
  if (!a) return null
  if (a === "y" || a === "yes") return decidePermission(req, "allow")
  if (a === "n" || a === "no") return decidePermission(req, "deny")
  const n = Number(a)
  const o = Number.isInteger(n) ? req.options[n - 1] : req.options.find((x) => x.name.toLowerCase() === a)
  return o ? { outcome: { outcome: "selected", optionId: o.optionId } } : null
}

// ---------------------------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------------------------

/** A path the agent names must stay inside the working directory. */
export function insideCwd(cwd: string, p: string): string {
  const abs = path.resolve(cwd, p)
  const rel = path.relative(cwd, abs)
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path outside the working directory: ${p}`)
  return abs
}

/** Update kinds this SDK version validates. Anything else is passed over rather than rejected. */
export const KNOWN_UPDATES = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
  "current_mode_update",
])

/** The sessionUpdate kind of a session/update notification this SDK would reject, else undefined. */
export function unknownUpdateKind(msg: unknown): string | undefined {
  const m = msg as { method?: string; params?: { update?: { sessionUpdate?: unknown } } }
  if (m?.method !== "session/update") return undefined
  const kind = m.params?.update?.sessionUpdate
  return typeof kind === "string" && !KNOWN_UPDATES.has(kind) ? kind : undefined
}

export interface RunOptions {
  argv: string[]
  prompt: string
  cwd: string
  policy: PermissionPolicy
  /** asks the user; only called when policy is "ask" */
  ask: (question: string) => Promise<string>
  write: (text: string) => void
  /** raw updates, one JSON object per line, instead of rendered text */
  json?: boolean
  thoughts?: boolean
  signal?: AbortSignal
}

export interface RunResult {
  agent?: string
  stopReason: string
  sessionId: string
  exitCode: number | null
}

export async function runAcpAgent(opts: RunOptions): Promise<RunResult> {
  const child: ChildProcess = spawn(opts.argv[0], opts.argv.slice(1), {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  })
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)))
  const spawnError = new Promise<never>((_, reject) => child.on("error", reject))

  const raw = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
  )
  const emit = (obj: unknown) => opts.write(JSON.stringify(obj) + "\n")
  // Agents are newer than the SDK: they send update kinds it rejects (usage_update,
  // config_option_update), one stderr error each. Let them by; --json still sees them.
  const stream = {
    writable: raw.writable,
    readable: raw.readable.pipeThrough(
      new TransformStream({
        transform(msg, controller) {
          const kind = unknownUpdateKind(msg)
          if (kind === undefined) return controller.enqueue(msg)
          if (opts.json) emit({ type: "update", ...(msg as { params: object }).params })
        },
      }),
    ),
  }

  const client: Client = {
    async sessionUpdate(params) {
      if (opts.json) return emit({ type: "update", ...params })
      const text = renderUpdate(params.update, { thoughts: opts.thoughts })
      if (text) opts.write(text)
    },
    async requestPermission(params) {
      if (opts.policy !== "ask") {
        const res = decidePermission(params, opts.policy)
        if (opts.json) emit({ type: "permission", request: params, response: res })
        else opts.write(`${describePermission(params)}\n  → ${opts.policy === "allow" ? "allowed once" : "denied"} (--${opts.policy === "allow" ? "yes" : "no"})\n`)
        return res
      }
      const question = describePermission(params) + "\n  choose [1-" + params.options.length + ", y, n]: "
      for (;;) {
        if (opts.signal?.aborted) return { outcome: { outcome: "cancelled" } }
        const res = parsePermissionAnswer(params, await opts.ask(question))
        if (res) return res
      }
    },
    async readTextFile(params) {
      const content = await fs.readFile(insideCwd(opts.cwd, params.path), "utf8")
      if (params.line == null && params.limit == null) return { content }
      const lines = content.split("\n")
      const start = Math.max(0, (params.line ?? 1) - 1)
      return { content: lines.slice(start, params.limit == null ? undefined : start + params.limit).join("\n") }
    },
    async writeTextFile(params) {
      // The agent asked (requestPermission) before it got here; the write itself is not re-asked.
      const file = insideCwd(opts.cwd, params.path)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, params.content)
      return {}
    },
  }

  const conn = new ClientSideConnection(() => client, stream)
  try {
    const init = await Promise.race([
      conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      }),
      spawnError,
    ])
    const agentName = (init as { agentInfo?: { name?: string } }).agentInfo?.name
    const session = await conn.newSession({ cwd: opts.cwd, mcpServers: [] })
    if (opts.json) emit({ type: "session", agent: agentName, sessionId: session.sessionId })

    const onAbort = () => void conn.cancel({ sessionId: session.sessionId }).catch(() => {})
    opts.signal?.addEventListener("abort", onAbort, { once: true })
    const res = await conn.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: opts.prompt }] })
    opts.signal?.removeEventListener("abort", onAbort)
    if (opts.json) emit({ type: "done", stopReason: res.stopReason })
    else opts.write("\n")

    child.stdin?.end()
    const timer = setTimeout(() => child.kill("SIGTERM"), 2000)
    const exitCode = await exited
    clearTimeout(timer)
    return { agent: agentName, stopReason: res.stopReason, sessionId: session.sessionId, exitCode }
  } catch (err) {
    child.kill("SIGTERM")
    throw err
  }
}
