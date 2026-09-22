/**
 * The REAL A2A executor: put the task's text to a standing IRIS platform agent.
 *
 * Same code path as `iris mcp serve`'s iris_agent action:"ask" — the argv comes from the
 * shared buildAgentAskArgs() and the child is the same ~/.iris/bin/iris with the same
 * MCP_CHILD_ENV. It does not reuse mcp-serve's execIris() only because that function
 * cannot be aborted, and A2A CancelTask has to be able to kill the child.
 */
import { buildAgentAskArgs, IRIS_BIN, MCP_CHILD_ENV } from "../cli/cmd/mcp-serve"
import type { Execute } from "./server"

const OPEN = "{}".slice(0, 1)

/**
 * Read `iris chat --json` output. The CLI can print several JSON objects (an error object
 * per failed API call, then a status envelope), so parse line-wise and let the envelope
 * decide — the same rule mcp-serve applies. Anything but an explicit completed turn is a
 * failure, and is thrown so the A2A task ends FAILED rather than COMPLETED-with-nothing.
 */
export function parseAgentAskOutput(out: { stdout: string; stderr: string; exitCode: number }): string {
  const raw = (out.stdout || "").trim()
  if (out.exitCode !== 0 && !raw.startsWith(OPEN)) {
    throw new Error((out.stderr || raw || "agent call failed with no output").trim())
  }
  const objs: Record<string, any>[] = []
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t.startsWith(OPEN)) continue
    try {
      objs.push(JSON.parse(t))
    } catch {}
  }
  const env = objs.find((o) => typeof o.status === "string" || typeof o.response === "string") ?? objs[objs.length - 1]
  if (!env) throw new Error((raw || out.stderr || "agent produced no output").trim())
  if (env.status !== "completed" || env.success === false) {
    const reasons = objs.map((o) => (typeof o.error === "string" ? o.error : null)).filter(Boolean)
    throw new Error(
      `agent did not answer: ${reasons.length ? reasons.join("; ") : typeof env.error === "string" ? env.error : `status=${JSON.stringify(env.status)}`}`,
    )
  }
  return typeof env.response === "string" ? env.response : ""
}

/** A2A contextId → an IRIS chat thread, so one A2A conversation is one agent thread. */
export function threadForContext(contextId: string): string {
  return "a2a_" + contextId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)
}

export function irisAgentExecutor(opts: { agentId: number; timeoutSecs: number; bin?: string }): Execute {
  return async ({ text, contextId, signal }) => {
    if (!text) throw new Error("the message carried no text for the agent to answer")
    const built = buildAgentAskArgs({
      agentId: opts.agentId,
      message: text,
      timeoutSecs: opts.timeoutSecs,
      thread: threadForContext(contextId),
    })
    if (!built.ok) throw new Error(built.error)
    const proc = Bun.spawn([opts.bin ?? IRIS_BIN, ...built.args], {
      env: { ...process.env, ...MCP_CHILD_ENV },
      stdout: "pipe",
      stderr: "pipe",
    })
    const kill = () => proc.kill()
    signal.addEventListener("abort", kill, { once: true })
    // +15s so the CLI's own --timeout fires first and we get its structured error.
    const timer = setTimeout(kill, (opts.timeoutSecs + 15) * 1000)
    try {
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      const exitCode = await proc.exited
      if (signal.aborted) throw new Error("canceled")
      return parseAgentAskOutput({ stdout, stderr, exitCode })
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", kill)
    }
  }
}
