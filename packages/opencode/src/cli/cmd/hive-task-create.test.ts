import { describe, expect, test } from "bun:test"
import {
  buildTaskPayload,
  checkTaskRequest,
  describeApiError,
  describeTask,
  exitCodeForStatus,
  parseConfigArg,
  pickResultPayload,
  PROMPT_IS_PAYLOAD,
} from "./hive-task-create"

const noFiles = (p: string): string => {
  throw new Error(`ENOENT: ${p}`)
}

describe("checkTaskRequest", () => {
  test("mcp_call with a server in the config is accepted", () => {
    expect(checkTaskRequest({ type: "mcp_call", config: { server: "argent" } })).toEqual({ ok: true })
  })

  test("mcp_call with NO server is refused here, not one round trip later", () => {
    // The daemon falls back to reading the server name out of the prompt, so a task with
    // neither is dispatched, reaches the node, and fails there complaining about an allowlist
    // — which sends you to edit a file that is already correct.
    const r = checkTaskRequest({ type: "mcp_call", config: {} })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("server name")
    expect(r.hint).toContain("mcp-servers.json")
  })

  test("a prompt-carrying type without --prompt is refused, with what the prompt should be", () => {
    // This is the whole reason the map exists: the API only requires a non-empty string, so a
    // placeholder passes, the node runs an empty script and reports SUCCESS.
    const r = checkTaskRequest({ type: "sandbox_execute", config: {} })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.hint).toContain("shell script body")
    expect(r.hint).toContain("reports success")
  })

  test("the same type WITH a prompt is fine", () => {
    expect(checkTaskRequest({ type: "sandbox_execute", prompt: "echo hi", config: {} })).toEqual({ ok: true })
  })

  test("whitespace is not a prompt", () => {
    expect(checkTaskRequest({ type: "discover", prompt: "   ", config: {} }).ok).toBe(false)
  })

  test("an unknown type is NOT refused locally", () => {
    // The enum lives in the API and grows there. Gating on a copy would make every new
    // server-side task type unusable from the CLI until someone updated this file.
    expect(checkTaskRequest({ type: "some_type_shipped_yesterday", config: {} })).toEqual({ ok: true })
  })

  test("a missing type is refused", () => {
    expect(checkTaskRequest({ type: "", config: {} }).ok).toBe(false)
  })

  test("every prompt-payload hint says what to put in the prompt", () => {
    for (const [type, hint] of Object.entries(PROMPT_IS_PAYLOAD)) {
      expect(hint.length, `${type} hint`).toBeGreaterThan(10)
    }
  })
})

describe("parseConfigArg", () => {
  test("no --config means an empty config, not an error", () => {
    expect(parseConfigArg(undefined, noFiles)).toEqual({ ok: true, config: {} })
  })

  test("inline JSON is parsed", () => {
    const r = parseConfigArg('{"server":"argent","tool":"list_devices"}', noFiles)
    expect(r).toEqual({ ok: true, config: { server: "argent", tool: "list_devices" } })
  })

  test("@file is read from disk", () => {
    const r = parseConfigArg("@/tmp/cfg.json", () => '{"server":"argent"}')
    expect(r).toEqual({ ok: true, config: { server: "argent" } })
  })

  test("an unreadable @file names the file", () => {
    const r = parseConfigArg("@/tmp/nope.json", noFiles)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("/tmp/nope.json")
  })

  test("broken JSON gets the shell-quoting hint, because that is the actual cause", () => {
    const r = parseConfigArg("{server: argent}", noFiles)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.hint).toContain("Single-quote")
  })

  test("a JSON array is refused even though Laravel would accept it", () => {
    // `config` validates as `array` server-side, so a list is stored happily and then ignored
    // by every executor — they all read named keys.
    const r = parseConfigArg('["server","argent"]', noFiles)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("array")
  })

  test("a bare scalar is refused", () => {
    expect(parseConfigArg("42", noFiles).ok).toBe(false)
  })
})

describe("describeTask", () => {
  test("names the server and tool, so a task list is readable", () => {
    expect(describeTask("mcp_call", { server: "argent", tool: "list_devices" })).toBe("mcp_call argent:list_devices")
  })

  test("no tool means discovery, and says so", () => {
    expect(describeTask("mcp_call", { server: "argent" })).toBe("mcp_call argent (tools/list)")
  })

  test("other types describe as themselves", () => {
    expect(describeTask("remotion", {})).toBe("remotion")
  })
})

describe("buildTaskPayload", () => {
  test("the minimal mcp_call dispatch the playbook needs", () => {
    const p = buildTaskPayload({ userId: 7, type: "mcp_call", nodeId: "abc-123", config: { server: "argent" } })
    expect(p).toEqual({
      user_id: 7,
      title: "iris hive: mcp_call argent (tools/list)",
      type: "mcp_call",
      prompt: "mcp_call argent (tools/list)",
      config: { server: "argent" },
      node_id: "abc-123",
    })
  })

  test("an empty config is omitted rather than sent as {}", () => {
    const p = buildTaskPayload({ userId: 1, type: "inbox_scan", config: {} })
    expect("config" in p).toBe(false)
  })

  test("timeout and priority are clamped to the API's own bounds", () => {
    const p = buildTaskPayload({ userId: 1, type: "mcp_call", config: { server: "s" }, timeoutSec: 99999, priority: 42 })
    expect(p.timeout_seconds).toBe(3600)
    expect(p.priority).toBe(10)
    const low = buildTaskPayload({ userId: 1, type: "mcp_call", config: { server: "s" }, timeoutSec: 1, priority: 0 })
    expect(low.timeout_seconds).toBe(30)
    expect(low.priority).toBe(1)
  })

  test("fallback is opt-in — naming a node PINS it by default", () => {
    const pinned = buildTaskPayload({ userId: 1, type: "mcp_call", nodeId: "n", config: { server: "s" } })
    expect("allow_node_fallback" in pinned).toBe(false)
    const loose = buildTaskPayload({ userId: 1, type: "mcp_call", nodeId: "n", config: { server: "s" }, allowFallback: true })
    expect(loose.allow_node_fallback).toBe(true)
  })

  test("required capabilities become the map the router expects", () => {
    const p = buildTaskPayload({ userId: 1, type: "remotion", config: {}, requiredCapabilities: ["youtube", "gpu"] })
    expect(p.required_capabilities).toEqual({ youtube: true, gpu: true })
  })

  test("a long title is truncated to the column width, not rejected by the API", () => {
    const p = buildTaskPayload({ userId: 1, type: "mcp_call", config: { server: "s" }, title: "x".repeat(400) })
    expect(String(p.title).length).toBe(255)
  })

  test("an explicit prompt survives untouched", () => {
    const p = buildTaskPayload({ userId: 1, type: "discover", prompt: "import-yt-feed", config: {} })
    expect(p.prompt).toBe("import-yt-feed")
  })
})

describe("describeApiError", () => {
  test("a 422 field error is rendered per field", () => {
    const body = JSON.stringify({ message: "The given data was invalid.", errors: { type: ["The selected type is invalid."] } })
    const out = describeApiError(422, body)
    expect(out).toContain("The API rejected the task")
    expect(out).toContain("type: The selected type is invalid.")
  })

  test("a rejected --type gets examples, because Laravel's message alone is useless", () => {
    // Measured: the server says only "The selected type is invalid." — no enum, no hint. A
    // person reading that has nowhere to go except the controller source.
    const body = JSON.stringify({ errors: { type: ["The selected type is invalid."] } })
    const out = describeApiError(422, body)
    expect(out).toContain("common types:")
    expect(out).toContain("mcp_call")
  })

  test("a rejected field that is NOT type gets no type hint", () => {
    const body = JSON.stringify({ errors: { prompt: ["The prompt field is required."] } })
    expect(describeApiError(422, body)).not.toContain("common types:")
  })

  test("a non-JSON body is still shown", () => {
    expect(describeApiError(500, "<html>Server Error</html>")).toContain("Server Error")
  })

  test("an empty body still says what happened", () => {
    expect(describeApiError(503, "")).toContain("HTTP 503")
  })
})

describe("exitCodeForStatus", () => {
  test("completed is 0", () => {
    expect(exitCodeForStatus("completed")).toBe(0)
    expect(exitCodeForStatus("succeeded")).toBe(0)
  })

  test("timeout is 124 so CI can retry only those", () => {
    expect(exitCodeForStatus("timeout")).toBe(124)
  })

  test("an unknown or missing status is a FAILURE, never a silent success", () => {
    expect(exitCodeForStatus(undefined)).toBe(1)
    expect(exitCodeForStatus("who_knows")).toBe(1)
  })
})

describe("pickResultPayload", () => {
  test("an mcp_call result is rendered as JSON", () => {
    const r = pickResultPayload({ result: { ok: true, server: "argent", result: { content: [{ type: "text", text: "hi" }] } } })
    expect(r.kind).toBe("json")
    expect(r.text).toContain("\"server\": \"argent\"")
  })

  test("a shell-shaped result prints as plain text", () => {
    const r = pickResultPayload({ result: { output: "line one\nline two" } })
    expect(r).toEqual({ kind: "text", text: "line one\nline two" })
  })

  test("the node's real envelope prints the output, not the escaped envelope", () => {
    // Exactly what the live fleet returned on the first real mcp_call: the whole answer is a
    // JSON document inside `output` as a string, duplicated in `stdout`, alongside metadata.
    // Rendering the envelope as JSON printed it with every newline as \n — unreadable.
    const r = pickResultPayload({
      result: {
        data: null,
        files: [],
        output: "{\n  \"tools\": []\n}",
        stdout: "{\n  \"tools\": []\n}",
        stderr: null,
        metadata: { exit_code: 0, executed_by_node_name: "Alex-Mayo-Bisnow-23812.local" },
        duration_ms: 4176,
      },
    })
    expect(r.kind).toBe("text")
    expect(r.text).toContain("\"tools\"")
    expect(r.text).not.toContain("\\n")
    expect(r.exitCode).toBe(0)
    // The machine that ran it reports its OWN hostname, which is not the name it is registered
    // under — and with --allow-fallback it may not even be the machine that was asked.
    expect(r.node).toBe("Alex-Mayo-Bisnow-23812.local")
  })

  test("stderr comes back separately so a failure is not buried in the output", () => {
    const r = pickResultPayload({ result: { output: "partial", stderr: "boom", metadata: { exit_code: 2 } } })
    expect(r.kind).toBe("text")
    expect(r.stderr).toBe("boom")
    expect(r.exitCode).toBe(2)
  })

  test("an envelope carrying a structured payload of its own stays JSON — nothing is hidden", () => {
    const r = pickResultPayload({ result: { output: "hi", files: [], summary: { ok: true } } })
    expect(r.kind).toBe("json")
    expect(r.text).toContain("\"ok\": true")
  })

  test("a node that returned NOTHING is reported as nothing, not as an empty success", () => {
    expect(pickResultPayload({ result: null }).kind).toBe("none")
    expect(pickResultPayload({}).kind).toBe("none")
  })
})
