import { test, expect, describe } from "bun:test"
import {
  scheduleArgs,
  validTime,
  validTimezone,
  chooseNode,
  buildSchedulePayload,
  playbookScheduleRows,
} from "./platform-playbook-schedule"

const DECLARED = {
  action: { type: "string", default: "report", enum: ["report", "write"] },
  email: { type: "string", default: "none", enum: ["none", "preview", "send"] },
  bloq: { type: "number", default: 544 },
  email_to: { type: "string", default: "" },
}

describe("scheduleArgs — checked before anything is saved (#191367)", () => {
  test("named values pass through, typed by the declaration", () => {
    expect(scheduleArgs(["action=write", "--bloq=12", "--email", "send"], DECLARED, "meal-plan-day")).toEqual({
      action: "write",
      bloq: 12,
      email: "send",
    })
  })

  test("defaults are not pinned into the schedule", () => {
    expect(scheduleArgs(["action=write"], DECLARED, "meal-plan-day")).toEqual({ action: "write" })
  })

  test("an undeclared flag is refused — the #1063 failure, caught at create time", () => {
    expect(() => scheduleArgs(["--source=feed"], DECLARED, "discover-feed")).toThrow(/Unknown argument: source/)
    expect(() => scheduleArgs(["--source=feed"], DECLARED, "discover-feed")).toThrow(/declares: action, email, bloq, email_to/)
  })

  test("a value outside an enum is refused", () => {
    expect(() => scheduleArgs(["email=yes"], DECLARED, "meal-plan-day")).toThrow(/Must be one of: none, preview, send/)
  })

  test("a bare positional is refused, because a stored schedule should say what each value means", () => {
    expect(() => scheduleArgs(["write"], DECLARED, "meal-plan-day")).toThrow(/Give each value a name/)
  })

  test("a misspelled name=value is reported as unknown, with the likely meaning", () => {
    expect(() => scheduleArgs(["emial=send"], DECLARED, "meal-plan-day")).toThrow(/Unknown argument: emial/)
    expect(() => scheduleArgs(["emial=send"], DECLARED, "meal-plan-day")).toThrow(/Did you mean: emial → email/)
  })

  test("no guess when nothing is close", () => {
    let msg = ""
    try { scheduleArgs(["source=feed"], DECLARED, "discover-feed") } catch (e: any) { msg = e.message }
    expect(msg).toMatch(/Unknown argument: source/)
    expect(msg).not.toMatch(/Did you mean/)
  })
})

describe("time and timezone", () => {
  test("24-hour times only", () => {
    expect(validTime("06:00")).toBe(true)
    expect(validTime("6:05")).toBe(true)
    expect(validTime("24:00")).toBe(false)
    expect(validTime("6am")).toBe(false)
    expect(validTime("06:60")).toBe(false)
  })
  test("real IANA zones only", () => {
    expect(validTimezone("America/Chicago")).toBe(true)
    expect(validTimezone("Central")).toBe(false)
  })
})

describe("chooseNode — never guesses which machine runs someone's mornings", () => {
  const nodes: any[] = [
    { id: "aaa-1", name: "iris-hive-001", connection_status: "online", last_heartbeat_at: "2026-10-27T10:00:00Z" },
    { id: "bbb-2", name: "office-mac", connection_status: "offline", last_heartbeat_at: "2026-10-20T10:00:00Z" },
  ]
  test("a named online node", () => {
    expect(chooseNode(nodes, "iris-hive-001", null)).toEqual({ node: nodes[0] })
  })
  test("a named offline node is refused, with the online choices", () => {
    const r = chooseNode(nodes, "office-mac", null) as { error: string }
    expect(r.error).toMatch(/offline/)
    expect(r.error).toMatch(/Online nodes: iris-hive-001/)
  })
  test("an unknown name is refused", () => {
    expect((chooseNode(nodes, "nope", null) as any).error).toMatch(/No node matches "nope"/)
  })
  test("unnamed → this machine when it is a registered online node", () => {
    expect(chooseNode(nodes, undefined, "aaa-1")).toEqual({ node: nodes[0] })
  })
  test("unnamed and this machine is not a node → ask, do not pick one", () => {
    expect((chooseNode(nodes, undefined, null) as any).error).toMatch(/--node <name>/)
  })
})

describe("buildSchedulePayload — the shape the scheduler already runs (#191214)", () => {
  const p = buildSchedulePayload({
    playbook: "meal-plan-day",
    args: { action: "write" },
    nodeId: "aaa-1",
    agentId: 704,
    at: "06:00",
    timezone: "America/Chicago",
    frequency: "daily",
  }) as any

  test("a direct playbook_run pinned to the node, with the playbook's args", () => {
    expect(p.data.type).toBe("hive_task_dispatch")
    expect(p.data.task_type).toBe("playbook_run")
    expect(p.data.dispatch_mode).toBe("direct")
    expect(p.data.prompt).toBe("meal-plan-day")
    expect(p.data.node_id).toBe("aaa-1")
    expect(p.data.playbook_args).toEqual({ action: "write" })
  })
  test("mirrored under params, as `schedules create` stores it", () => {
    expect(p.data.params.task_type).toBe("playbook_run")
    expect(p.data.params.playbook_args).toEqual({ action: "write" })
  })
  test("schedule fields", () => {
    expect(p).toMatchObject({ agent_id: 704, time: "06:00", timezone: "America/Chicago", frequency: "daily", task_name: "Playbook: meal-plan-day" })
  })
  test("no cwd unless one was given", () => {
    expect("cwd" in p.data).toBe(false)
  })
})

describe("playbookScheduleRows", () => {
  test("keeps only playbook runs and says how the last one went", () => {
    const rows = playbookScheduleRows([
      { id: 1, frequency: "daily", scheduled_time: "09:17:00", timezone: "America/New_York", data: { task_type: "playbook_run", prompt: "discover-feed", playbook_args: { hours: 24 } }, last_result: { task: { status: "failed", node: { name: "mac" } } } },
      { id: 2, data: { task_type: "clip_cutter" } },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 1, playbook: "discover-feed", when: "daily 09:17 America/New_York", node: "mac", last: "failed", args: "hours=24" })
  })
})
