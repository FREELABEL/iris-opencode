import { describe, expect, test } from "bun:test"
import { buildHiveRunBody } from "./hive-run-body"

const NODE = "01a09d2c-2076-72e5-9292-7f69c00e8407"
const base = { userId: 193, nodeId: "01a10379-0c9f-73c5-bf83-157496a21589", title: "iris hive run: uptime", script: "#!/bin/bash\nuptime", timeoutSec: 60 }

describe("buildHiveRunBody (#188667)", () => {
  test("run from a session, the task carries the origin its report goes back to", () => {
    const origin = { node_id: NODE, session_id: "ses_abc", message_id: "msg_def", provider: "opencode" as const }
    expect(buildHiveRunBody({ ...base, origin }).metadata).toEqual({ origin })
  })

  test("outside a session there is no metadata key at all", () => {
    expect("metadata" in buildHiveRunBody({ ...base, origin: null })).toBe(false)
  })

  test("the rest of the request is what hive run always sent", () => {
    expect(buildHiveRunBody({ ...base, priority: 7 })).toEqual({
      user_id: 193,
      title: "iris hive run: uptime",
      type: "sandbox_execute",
      node_id: base.nodeId,
      prompt: "#!/bin/bash\nuptime",
      config: { timeout_seconds: 60 },
      timeout_seconds: 60,
      priority: 7,
    })
  })
})
