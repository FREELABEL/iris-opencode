import { describe, expect, test } from "bun:test"
import { delegationOrigin } from "./hive-delegation-origin"
import { buildTaskPayload } from "./hive-task-create"

const NODE = "01a09d2c-2076-72e5-9292-7f69c00e8407"

describe("delegationOrigin (#188667)", () => {
  test("a command run from an agent session, on a machine with a daemon, carries its origin", () => {
    expect(delegationOrigin({ env: { IRIS_SESSION_ID: "ses_abc123", IRIS_MESSAGE_ID: "msg_def456" }, daemonNodeId: NODE })).toEqual({
      node_id: NODE,
      session_id: "ses_abc123",
      message_id: "msg_def456",
      provider: "opencode",
    })
  })

  test("outside a session there is nothing to report to", () => {
    expect(delegationOrigin({ env: {}, daemonNodeId: NODE })).toBeNull()
  })

  test("without a daemon nothing could deliver the report, so no origin is claimed", () => {
    expect(delegationOrigin({ env: { IRIS_SESSION_ID: "ses_abc123" }, daemonNodeId: null })).toBeNull()
  })

  test("a session id the daemon would refuse is never sent", () => {
    expect(delegationOrigin({ env: { IRIS_SESSION_ID: "ses_1; rm -rf ~" }, daemonNodeId: NODE })).toBeNull()
  })

  test("a malformed message id is dropped, the origin kept", () => {
    expect(delegationOrigin({ env: { IRIS_SESSION_ID: "ses_abc", IRIS_MESSAGE_ID: "a b" }, daemonNodeId: NODE })?.message_id).toBeUndefined()
  })
})

describe("buildTaskPayload with an origin", () => {
  const base = { userId: 193, type: "code_generation", prompt: "do it", config: {} }

  test("the origin rides in metadata, which the API stores as given", () => {
    const origin = { node_id: NODE, session_id: "ses_abc", provider: "opencode" }
    expect(buildTaskPayload({ ...base, origin }).metadata).toEqual({ origin })
  })

  test("no origin, no metadata key", () => {
    expect("metadata" in buildTaskPayload({ ...base, origin: null })).toBe(false)
  })
})
