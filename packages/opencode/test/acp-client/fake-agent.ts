// A scripted ACP agent for tests: streams two chunks, proposes one edit, asks permission, and
// writes the file through the CLIENT's fs only if it was allowed. Speaks real ACP over stdio.
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import { Readable, Writable } from "node:stream"

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
)
new AgentSideConnection(
  (conn) => ({
    async initialize() {
      return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [], agentInfo: { name: "Fake", version: "0" } } as any
    },
    async authenticate() {
      return {} as any
    },
    async newSession() {
      return { sessionId: "s1" }
    },
    async cancel() {},
    async prompt(p: any) {
      const sessionId = p.sessionId
      const text = (p.prompt[0] as any).text as string
      const say = (t: string) =>
        conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } })
      // a kind newer than our SDK — must not surface as an error
      await (conn as any).sessionUpdate({ sessionId, update: { sessionUpdate: "usage_update", used: 1, size: 2 } }).catch(() => {})
      await say("Hello ")
      await say(`you said: ${text}.`)
      const old = (await conn.readTextFile({ sessionId, path: "a.txt" })).content
      const edit = { type: "diff" as const, path: "a.txt", oldText: old, newText: old.replace("one", "ONE") }
      await conn.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit a.txt", kind: "edit", status: "pending", content: [edit] },
      })
      const perm = await conn.requestPermission({
        sessionId,
        toolCall: { toolCallId: "t1", title: "Edit a.txt", kind: "edit" },
        options: [
          { optionId: "ok", name: "Allow", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "nope", name: "Reject", kind: "reject_once" },
        ],
      })
      const allowed = perm.outcome.outcome === "selected" && perm.outcome.optionId !== "nope"
      if (allowed) await conn.writeTextFile({ sessionId, path: "a.txt", content: edit.newText })
      if (text.includes("escape")) {
        try {
          await conn.writeTextFile({ sessionId, path: "../escaped.txt", content: "x" })
        } catch {
          await say(" [escape refused]")
        }
      }
      await conn.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: allowed ? "completed" : "failed", title: "Edit a.txt" },
      })
      return { stopReason: "end_turn" }
    },
  }) as any,
  stream,
)
