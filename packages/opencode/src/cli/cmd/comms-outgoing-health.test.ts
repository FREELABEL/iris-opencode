import { describe, expect, test } from "bun:test"
import { summariseOutgoing } from "./comms-outgoing-health"
import type { UnloggedSend } from "./comms-send"

const send = (over: Partial<UnloggedSend> = {}): UnloggedSend => ({
  at: "2026-09-14T21:30:00.000Z",
  channel: "apple_mail",
  to: "rodney@entropyconsulting.me",
  subject: "s",
  message: "m",
  reason: "comms/log returned 500",
  ...over,
})

const base = { spool: [], bridgeOk: true, senders: [{ slug: "a", verified: true }] }

describe("summariseOutgoing", () => {
  test("a clean outbox is ok", () => {
    const r = summariseOutgoing(base)
    expect(r.ok).toBe(true)
    expect(r.lines[0]).toContain("none")
  })

  test("an unlogged send is NOT ok — it is the whole point of the check", () => {
    const r = summariseOutgoing({ ...base, spool: [send({ leadId: 10394 })] })
    expect(r.ok).toBe(false)
    expect(r.healable).toHaveLength(1)
    expect(r.needsLead).toHaveLength(0)
  })

  test("separates what it can repair alone from what needs a human", () => {
    const r = summariseOutgoing({ ...base, spool: [send({ leadId: 10394 }), send({ at: "b" }), send({ at: "c", leadId: 0 })] })
    expect(r.healable.map((e) => e.leadId)).toEqual([10394])
    // leadId 0 is not a lead. Treating a falsy id as present is how a repair writes to nowhere.
    expect(r.needsLead).toHaveLength(2)
  })

  test("an unreachable bridge is reported but does not fail the check", () => {
    // pulse runs on machines that do not send. A missing bridge there is not a fault.
    const r = summariseOutgoing({ ...base, bridgeOk: false, bridgeDetail: "connection refused" })
    expect(r.ok).toBe(true)
    expect(r.lines.join(" ")).toContain("UNREACHABLE")
    expect(r.lines.join(" ")).toContain("connection refused")
  })

  test("unknown senders read as unknown, never as zero", () => {
    const r = summariseOutgoing({ ...base, senders: null })
    expect(r.sendersKnown).toBe(false)
    expect(r.lines.join(" ")).toContain("unknown")
    expect(r.lines.join(" ")).not.toContain("0 usable")
  })

  test("names the identities that cannot send", () => {
    const r = summariseOutgoing({
      ...base,
      senders: [
        { slug: "alex-mayo-freelabel", verified: true },
        { slug: "alex-mayo-pathways", verified: false },
        { slug: "gate-probe-tmp", verified: true, status: "archived" },
      ],
    })
    expect(r.sendersUsable).toBe(1)
    expect(r.lines.join(" ")).toContain("alex-mayo-pathways")
    expect(r.lines.join(" ")).toContain("gate-probe-tmp")
  })

  test("accepts is_verified as well as verified, because the API has used both", () => {
    const r = summariseOutgoing({ ...base, senders: [{ slug: "x", is_verified: true }] })
    expect(r.sendersUsable).toBe(1)
    expect(r.sendersUnusable).toHaveLength(0)
  })
})
