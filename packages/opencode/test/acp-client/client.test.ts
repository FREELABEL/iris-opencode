import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  decidePermission,
  parsePermissionAnswer,
  renderDiff,
  renderUpdate,
  resolveAgentCommand,
  runAcpAgent,
  insideCwd,
  unknownUpdateKind,
} from "../../src/acp/client"

const FAKE = [process.execPath, path.join(import.meta.dir, "fake-agent.ts")]
const req = {
  sessionId: "s",
  toolCall: { toolCallId: "t", title: "rm -rf build", kind: "execute" as const },
  options: [
    { optionId: "a1", name: "Allow", kind: "allow_once" as const },
    { optionId: "a2", name: "Always", kind: "allow_always" as const },
    { optionId: "r1", name: "Reject", kind: "reject_once" as const },
  ],
}

async function tmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-client-"))
  const cwd = path.join(dir, "work")
  await fs.mkdir(cwd)
  await fs.writeFile(path.join(cwd, "a.txt"), "one\ntwo\n")
  return { dir, cwd }
}

describe("acp client — the pure parts", () => {
  test("a known agent resolves through the registry; a missing adapter is named", () => {
    const none = () => null
    expect(resolveAgentCommand("claude", none)).toMatchObject({ argv: ["claude-code-acp"], missing: "claude-code-acp" })
    expect(resolveAgentCommand("gemini", (b) => `/bin/${b}`).argv).toEqual(["gemini", "--experimental-acp"])
    expect(resolveAgentCommand("my-agent --acp", (b) => `/bin/${b}`)).toEqual({ argv: ["my-agent", "--acp"], missing: undefined })
  })

  test("auto prefers an installed third-party agent and falls back to IRIS", () => {
    expect(resolveAgentCommand("auto", (b) => (b === "codex-acp" ? "/x" : null)).spec?.id).toBe("codex")
    expect(resolveAgentCommand("auto", () => null).spec?.id).toBe("iris")
  })

  test("--yes takes allow_once, never allow_always; --no takes reject", () => {
    expect(decidePermission(req, "allow").outcome).toEqual({ outcome: "selected", optionId: "a1" })
    expect(decidePermission(req, "deny").outcome).toEqual({ outcome: "selected", optionId: "r1" })
  })

  test("answers: number, y/n, option name; garbage asks again", () => {
    expect(parsePermissionAnswer(req, "2")?.outcome).toEqual({ outcome: "selected", optionId: "a2" })
    expect(parsePermissionAnswer(req, "n")?.outcome).toEqual({ outcome: "selected", optionId: "r1" })
    expect(parsePermissionAnswer(req, "always")?.outcome).toEqual({ outcome: "selected", optionId: "a2" })
    expect(parsePermissionAnswer(req, "9")).toBeNull()
    expect(parsePermissionAnswer(req, "")).toBeNull()
  })

  test("a diff renders as a patch, a new file says so", () => {
    expect(renderDiff("a.txt", "one\n", "ONE\n")).toContain("-one\n+ONE")
    expect(renderDiff("b.txt", null, "x\n")).toContain("(new file)")
  })

  test("thoughts are hidden unless asked for", () => {
    const u = { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } } as any
    expect(renderUpdate(u)).toBe("")
    expect(renderUpdate(u, { thoughts: true })).toBe("hmm")
  })

  test("update kinds newer than the SDK are passed over, known ones and other messages are not", () => {
    const n = (k: string) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: k } } })
    expect(unknownUpdateKind(n("usage_update"))).toBe("usage_update")
    expect(unknownUpdateKind(n("agent_message_chunk"))).toBeUndefined()
    expect(unknownUpdateKind({ jsonrpc: "2.0", id: 1, result: {} })).toBeUndefined()
  })

  test("paths outside the working directory are refused", () => {
    expect(() => insideCwd("/w", "../etc/passwd")).toThrow()
    expect(() => insideCwd("/w", "/etc/passwd")).toThrow()
    expect(insideCwd("/w", "src/a.ts")).toBe("/w/src/a.ts")
  })
})

describe("acp client — against a real ACP agent over stdio", () => {
  test("streams, shows the diff, asks, and writes only after allow", async () => {
    const { cwd } = await tmp()
    let out = ""
    const questions: string[] = []
    const res = await runAcpAgent({
      argv: FAKE,
      prompt: "make it loud",
      cwd,
      policy: "ask",
      ask: async (q) => (questions.push(q), "y"),
      write: (t) => (out += t),
    })
    expect(res).toMatchObject({ agent: "Fake", stopReason: "end_turn", sessionId: "s1" })
    expect(out).toContain("Hello you said: make it loud.")
    expect(out).toContain("▸ Edit a.txt [edit]")
    expect(out).toContain("-one\n+ONE")
    expect(questions).toHaveLength(1)
    expect(questions[0]).toContain("1) Allow")
    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("ONE\ntwo\n")
  }, 20000)

  test("deny leaves the file untouched; the agent cannot write outside cwd", async () => {
    const { dir, cwd } = await tmp()
    let out = ""
    await runAcpAgent({ argv: FAKE, prompt: "escape", cwd, policy: "deny", ask: async () => "y", write: (t) => (out += t) })
    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("one\ntwo\n")
    expect(out).toContain("[escape refused]")
    expect(out).toContain("failed")
    expect(await fs.exists(path.join(dir, "escaped.txt"))).toBe(false)
  }, 20000)

  test("--json emits session, updates, the permission decision and done", async () => {
    const { cwd } = await tmp()
    let out = ""
    await runAcpAgent({ argv: FAKE, prompt: "hi", cwd, policy: "allow", ask: async () => "", write: (t) => (out += t), json: true })
    const types = out.trim().split("\n").map((l) => JSON.parse(l).type)
    expect(types[0]).toBe("session")
    expect(types).toContain("update")
    expect(types).toContain("permission")
    expect(types.at(-1)).toBe("done")
  }, 20000)
})
