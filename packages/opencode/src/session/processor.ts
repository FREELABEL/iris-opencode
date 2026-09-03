import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission/next"
import { Beacon } from "@/telemetry/beacon"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false

    // ── Trace spine (#178533) ────────────────────────────────────────────
    // The reasoning chain was already being tracked here — every tool part
    // carries a status and a start/end time — it just never left the machine,
    // so nobody could tell whether a client's run made it to the end. These
    // spans ship the SHAPE of that chain: tool name, duration, outcome. Never
    // an argument value, never prompt/response text (that is PHI territory and
    // belongs on audit_events, not telemetry).
    //
    // The session id doubles as the trace id — it is 30 chars, fits the
    // column, and lets a trace be joined back to a session you can open.
    const traceID = input.sessionID
    const runSpanID = Beacon.newSpanId()

    /** Emit one tool span. Swallows everything — telemetry must not break a run. */
    function toolSpan(part: MessageV2.ToolPart | undefined, outcome: Beacon.Outcome, startedAt?: number) {
      if (!part) return
      Beacon.span("tool_call", {
        trace_id: traceID,
        span_id: Beacon.newSpanId(),
        parent_span_id: runSpanID,
        tool_name: part.tool,
        outcome,
        duration_ms: startedAt !== undefined ? Math.max(0, Date.now() - startedAt) : undefined,
        model: input.model?.id,
      })
    }

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        Beacon.span("run_start", {
          trace_id: traceID,
          span_id: runSpanID,
          model: input.model?.id,
          provider: input.model?.providerID,
        })
        needsCompaction = false
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true
        while (true) {
          try {
            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            const stream = await LLM.stream(streamInput)

            for await (const value of stream.fullStream) {
              input.abort.throwIfAborted()
              switch (value.type) {
                case "start":
                  SessionStatus.set(input.sessionID, { type: "busy" })
                  break

                case "reasoning-start":
                  if (value.id in reasoningMap) {
                    continue
                  }
                  reasoningMap[value.id] = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "reasoning-delta":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text += value.text
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    if (part.text) await Session.updatePart({ part, delta: value.text })
                  }
                  break

                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()

                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                case "tool-input-start":
                  const part = await Session.updatePart({
                    id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: value.id,
                    state: {
                      status: "pending",
                      input: {},
                      raw: "",
                    },
                  })
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  break

                case "tool-input-delta":
                  break

                case "tool-input-end":
                  break

                case "tool-call": {
                  const match = toolcalls[value.toolCallId]
                  if (match) {
                    const part = await Session.updatePart({
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        input: value.input,
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    toolcalls[value.toolCallId] = part as MessageV2.ToolPart

                    const parts = await MessageV2.parts(input.assistantMessage.id)
                    const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

                    if (
                      lastThree.length === DOOM_LOOP_THRESHOLD &&
                      lastThree.every(
                        (p) =>
                          p.type === "tool" &&
                          p.tool === value.toolName &&
                          p.state.status !== "pending" &&
                          JSON.stringify(p.state.input) === JSON.stringify(value.input),
                      )
                    ) {
                      const agent = await Agent.get(input.assistantMessage.agent)
                      await PermissionNext.ask({
                        permission: "doom_loop",
                        patterns: [value.toolName],
                        sessionID: input.assistantMessage.sessionID,
                        metadata: {
                          tool: value.toolName,
                          input: value.input,
                        },
                        always: [value.toolName],
                        ruleset: agent.permission,
                      })
                    }
                  }
                  break
                }
                case "tool-result": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        input: value.input,
                        output: value.output.output,
                        metadata: value.output.metadata,
                        title: value.output.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments: value.output.attachments,
                      },
                    })

                    toolSpan(match, "ok", match.state.time.start)
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                case "tool-error": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input,
                        error: (value.error as any).toString(),
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })

                    // A denied permission is a user decision, not a failure —
                    // recording it as an error would make the tool look broken.
                    const rejected = value.error instanceof PermissionNext.RejectedError
                    toolSpan(match, rejected ? "aborted" : "error", match.state.time.start)

                    if (rejected) {
                      blocked = shouldBreak
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  snapshot = await Snapshot.track()
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                case "finish-step":
                  const usage = Session.getUsage({
                    model: input.model,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  input.assistantMessage.finish = value.finishReason
                  input.assistantMessage.cost += usage.cost
                  input.assistantMessage.tokens = usage.tokens
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    reason: value.finishReason,
                    snapshot: await Snapshot.track(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(input.assistantMessage)
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot)
                    if (patch.files.length) {
                      await Session.updatePart({
                        id: Identifier.ascending("part"),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })
                    }
                    snapshot = undefined
                  }
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.parentID,
                  })
                  if (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model })) {
                    needsCompaction = true
                  }
                  break

                case "text-start":
                  currentText = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "text-delta":
                  if (currentText) {
                    currentText.text += value.text
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    if (currentText.text)
                      await Session.updatePart({
                        part: currentText,
                        delta: value.text,
                      })
                  }
                  break

                case "text-end":
                  if (currentText) {
                    currentText.text = currentText.text.trimEnd()
                    const textOutput = await Plugin.trigger(
                      "experimental.text.complete",
                      {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                      },
                      { text: currentText.text },
                    )
                    currentText.text = textOutput.text
                    currentText.time = {
                      start: Date.now(),
                      end: Date.now(),
                    }
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePart(currentText)
                  }
                  currentText = undefined
                  break

                case "finish":
                  break

                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
              if (needsCompaction) break
            }
          } catch (e: any) {
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            const retry = SessionRetry.retryable(error)
            if (retry !== undefined) {
              attempt++
              const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
              SessionStatus.set(input.sessionID, {
                type: "retry",
                attempt,
                message: retry,
                next: Date.now() + delay,
              })
              await SessionRetry.sleep(delay, input.abort).catch(() => {})
              continue
            }
            input.assistantMessage.error = error
            Bus.publish(Session.Event.Error, {
              sessionID: input.assistantMessage.sessionID,
              error: input.assistantMessage.error,
            })
          }
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts(input.assistantMessage.id)
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              // Never reached a terminal state — these are the calls that
              // vanish today. 'aborted' distinguishes them from real errors.
              toolSpan(part as MessageV2.ToolPart, "aborted")
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }
          // Guard against silent empty finalization (bug #157647). A free / opencode-gateway
          // model whose upstream stream dies mid-flight (e.g. rate-limit / ResourceExhausted)
          // can finalize with finish="unknown", zero output tokens and NO output parts, yet
          // never emit an "error" stream event — so the upstream failure is swallowed, error
          // stays null, and the UI renders an empty bubble with only a duration. Treat this as
          // a hard failure: attach an error the UI already knows how to render (APIError shape,
          // read at `message.error.data.message`) and publish session.error so programmatic
          // callers (e.g. `iris run`) exit non-zero instead of reading it as success.
          if (!input.assistantMessage.error) {
            const finish = input.assistantMessage.finish
            const badFinish = finish === undefined || finish === "unknown" || finish === "error"
            const hasOutput = p.some(
              (part) =>
                (part.type === "text" && part.text.trim().length > 0) ||
                (part.type === "reasoning" && part.text.trim().length > 0) ||
                part.type === "tool",
            )
            if (badFinish && !hasOutput && input.assistantMessage.tokens.output === 0) {
              log.error("empty finalization", {
                finish: finish ?? "unknown",
                model: input.model?.id,
                provider: input.model?.providerID,
                sessionID: input.assistantMessage.sessionID,
                messageID: input.assistantMessage.id,
              })
              // #178291: the old text was a generic "the upstream provider may be
              // rate-limited or exhausted", which was accurate but unactionable —
              // it named neither the model that failed nor a way forward, so a
              // credentials problem and a rate limit read identically and we spent
              // a day chasing the wrong one. Name the model and provider the CLI
              // actually asked for, and point at the command that lists alternatives.
              //
              // The upstream identity (e.g. OpenCode Zen) and HTTP status live
              // server-side; the proxy records them to telemetry and, since the
              // failover work (#178556), only lets a stream finish empty once EVERY
              // provider has failed. So by the time a user sees this, "try another
              // model" is genuinely the right next step.
              const who = input.model?.id
                ? `${input.model.id}${input.model.providerID ? ` (${input.model.providerID})` : ""}`
                : "The model"
              input.assistantMessage.error = new MessageV2.APIError(
                {
                  message:
                    `${who} returned no output (finish reason: ${finish ?? "unknown"}). ` +
                    `Every upstream attempt failed — most often a rate limit or an exhausted/invalid API key. ` +
                    `Check with: iris doctor    ·    Pick another model: iris models`,
                  isRetryable: false,
                },
                {},
              ).toObject()
              Bus.publish(Session.Event.Error, {
                sessionID: input.assistantMessage.sessionID,
                error: input.assistantMessage.error,
              })
            }
          }
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)

          // Terminal span for the run. A trace with no run_end is a run that
          // died without reporting — which is exactly the population the
          // traces endpoint surfaces as "unfinished". Flushed on the way out
          // so the last spans are not lost if the process exits next.
          Beacon.span("run_end", {
            trace_id: traceID,
            span_id: Beacon.newSpanId(),
            parent_span_id: runSpanID,
            outcome: input.assistantMessage.error ? "error" : blocked ? "aborted" : "ok",
            duration_ms: Math.max(0, input.assistantMessage.time.completed - (input.assistantMessage.time.created ?? input.assistantMessage.time.completed)),
            model: input.model?.id,
            provider: input.model?.providerID,
          })
          void Beacon.flush()

          if (needsCompaction) return "compact"
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          return "continue"
        }
      },
    }
    return result
  }
}
