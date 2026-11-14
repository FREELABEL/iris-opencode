import { describe, expect, test } from "bun:test"
import { gatedExec, hasWriteVerb, recipientCount, previewParams, dryRunResult } from "../../src/cli/cmd/integration-write-gate"

// #189462 — on 2026-10-14 `iris integrations exec mailjet send_transactional_email` without --apply
// delivered 177 real emails. These drive the one decision function with a fake network and count
// what actually reached it: call(true) is a server PLAN (executes nothing), call(false) is the action.

function fakeServer(plan: any) {
  const calls: boolean[] = []
  const call = async (dryRun: boolean) => {
    calls.push(dryRun)
    if (dryRun) return plan
    return { success: true, data: { message_ids: ["REAL"] }, message: "Email sent" }
  }
  return { calls, call, executed: () => calls.filter((d) => d === false).length }
}

const sendPlan = (effect: string, ok = true) => ({
  success: true, dry_run: true, ok, problems: [],
  would_run: { integration: "mailjet", action: "send_transactional_email", effect, integration_id: 138 },
})

describe("gatedExec — a send without --apply never reaches the action", () => {
  test("(a) send_transactional_email without --apply: only a plan is requested, nothing is sent", async () => {
    const s = fakeServer(sendPlan("write"))
    const out = await gatedExec("send_transactional_email", { apply: false, forceDryRun: false }, s.call)
    expect(out.kind).toBe("rehearsed")
    expect(s.executed()).toBe(0)
    expect(s.calls).toEqual([true])
  })

  test("(a') even when the server's plan calls the send a read, a name with a write verb is not run", async () => {
    // The server can make a rehearsal stricter, never looser.
    const s = fakeServer(sendPlan("read"))
    const out = await gatedExec("send_transactional_email", { apply: false, forceDryRun: false }, s.call)
    expect(out.kind).toBe("rehearsed")
    expect(s.executed()).toBe(0)
  })

  test("(a'') the plan request failing still sends nothing", async () => {
    const calls: boolean[] = []
    const out = await gatedExec("send_email_with_template", { apply: false, forceDryRun: false }, async (d) => {
      calls.push(d)
      throw new Error("HTTP 500")
    })
    expect(out.kind).toBe("rehearsed")
    expect(calls).toEqual([true])
  })

  test("a server that ignores dry_run is reported, not presented as a clean rehearsal", async () => {
    const s = fakeServer({ success: true, data: { message_ids: ["X"] } })
    const out = await gatedExec("send_transactional_email", { apply: false, forceDryRun: false }, s.call)
    expect(out).toEqual({ kind: "rehearsed", plan: null, server_ignored_dry_run: true })
    expect(s.executed()).toBe(0)
  })

  test("a refusal from the planner is returned as such and nothing runs", async () => {
    const s = fakeServer({ success: false, error: "You have 2 connected mailjet accounts…", code: "account_ambiguous" })
    const out = await gatedExec("send_transactional_email", { apply: false, forceDryRun: false }, s.call)
    expect(out.kind).toBe("refused")
    expect(s.executed()).toBe(0)
  })
})

describe("gatedExec — --apply and reads", () => {
  test("(b) send_transactional_email WITH --apply runs it, once, without a plan round-trip", async () => {
    const s = fakeServer(sendPlan("write"))
    const out = await gatedExec("send_transactional_email", { apply: true, forceDryRun: false }, s.call)
    expect(out.kind).toBe("executed")
    expect(s.calls).toEqual([false])
  })

  test("--dry-run wins over --apply", async () => {
    const s = fakeServer(sendPlan("write"))
    const out = await gatedExec("send_transactional_email", { apply: true, forceDryRun: true }, s.call)
    expect(out.kind).toBe("rehearsed")
    expect(s.executed()).toBe(0)
  })

  test("(c) a read (get_contact_lists) runs without --apply and without a plan", async () => {
    const s = fakeServer(null)
    for (const fn of ["get_contact_lists", "get_campaigns", "list_files", "search_emails", "get_message_status"]) {
      s.calls.length = 0
      const out = await gatedExec(fn, { apply: false, forceDryRun: false }, s.call)
      expect(out.kind).toBe("executed")
      expect(s.calls).toEqual([false])
    }
  })

  test("a name with no verb runs only when the server's plan says it is a working read", async () => {
    const read = fakeServer({ ...sendPlan("read"), would_run: { integration: "pathways", action: "calculate_settlement", effect: "read" } })
    expect((await gatedExec("calculate_settlement", { apply: false, forceDryRun: false }, read.call)).kind).toBe("executed")
    expect(read.calls).toEqual([true, false])
    const write = fakeServer({ ...sendPlan("write"), would_run: { integration: "pathways", action: "calculate_settlement", effect: "write" } })
    expect((await gatedExec("calculate_settlement", { apply: false, forceDryRun: false }, write.call)).kind).toBe("rehearsed")
    expect(write.executed()).toBe(0)
  })
})

test("hasWriteVerb: every Mailjet write/send is one; its reads are not", () => {
  for (const f of ["send_transactional_email", "send_email_with_template", "create_campaign", "create_template", "update_template_content", "delete_template", "add_contact_to_list", "create_contact_list"])
    expect(hasWriteVerb(f)).toBe(true)
  for (const f of ["get_contact_lists", "get_campaigns", "get_templates", "get_campaign_statistics", "get_message_status"])
    expect(hasWriteVerb(f)).toBe(false)
  // Rehearsed by default, but a server plan may still clear them as reads.
  for (const f of ["generate_tax_summary", "convert_document"]) expect(hasWriteVerb(f)).toBe(false)
})

test("the dry run shows the recipient count and truncates long bodies", () => {
  const html = "<p>" + "x".repeat(5000) + "</p>"
  expect(recipientCount({ to: "a@x.com", cc: "b@x.com, c@x.com", subject: "s" })).toBe(3)
  expect(recipientCount({ to: ["a@x.com", { email: "b@x.com" }] })).toBe(2)
  expect(recipientCount({ subject: "s" })).toBeNull()
  const p = previewParams({ to: "a@x.com", html_body: html }) as any
  expect(p.to).toBe("a@x.com")
  expect(p.html_body.length).toBeLessThan(200)
  expect(p.html_body).toContain(`(${html.length} chars)`)
  const d = dryRunResult("mailjet", "send_transactional_email", { to: "a@x.com", html_body: html })
  expect(d).toMatchObject({ dry_run: true, executed: false, success: false, recipients: 1 })
})
