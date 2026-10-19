import { streamAgentChat, resolveUserId } from "./iris-api"
import { resolveConversationId } from "./platform-chat"

/**
 * `iris agents ask <agent> "<prompt>" [--from <agentId>] [--json]` (#182785).
 *
 * One question, one answer, nothing else on stdout — the shape a script or another agent can
 * consume. It is `iris chat -a` underneath: the same V6 stream (streamAgentChat) and the same
 * conversation resolution (resolveConversationId: --thread > --fresh > the agent's canonical
 * conversation > server default), so an ask lands in the thread a person chatting with that
 * agent would see. What it adds is provenance: `metadata: {from_agent_id?, via: "cli", at}` in
 * the request body, so the receiving side can tell an agent-to-agent ask from a person typing.
 */

export interface AskOptions {
  agentId: number
  prompt: string
  /** The asking agent, when an agent is the one asking. */
  from?: number | null
  thread?: string
  fresh?: boolean
  timeoutSecs?: number
  /** Injectable clock so the stamped `at` is testable. */
  now?: () => Date
}

export interface AskResult {
  ok: boolean
  answer: string
  agent_id: number
  conversation_id: string | null
  error?: string
  timedOut?: boolean
}

export function askProvenance(from: number | null | undefined, at: Date): Record<string, unknown> {
  return {
    ...(typeof from === "number" && Number.isInteger(from) && from > 0 ? { from_agent_id: from } : {}),
    via: "cli",
    at: at.toISOString(),
  }
}

export async function askAgent(opts: AskOptions): Promise<AskResult> {
  const conversation = await resolveConversationId({ thread: opts.thread, fresh: opts.fresh }, opts.agentId)
  let reported: string | null = null
  const r = await streamAgentChat({
    agentId: opts.agentId,
    message: opts.prompt,
    userId: await resolveUserId(),
    threadId: conversation,
    timeoutSecs: opts.timeoutSecs,
    metadata: askProvenance(opts.from, (opts.now ?? (() => new Date()))()),
    onEvent: (evt) => {
      // Prefer the conversation the server says it used over the one we asked for.
      const id = (evt as Record<string, unknown>).conversation_id ?? (evt as Record<string, unknown>).thread_id
      if (typeof id === "string" && id) reported = id
    },
  })
  return {
    ok: r.ok,
    answer: r.content,
    agent_id: opts.agentId,
    conversation_id: reported ?? conversation ?? null,
    ...(r.ok ? {} : { error: r.error ?? "Ask failed — no answer delivered.", timedOut: r.timedOut }),
  }
}
