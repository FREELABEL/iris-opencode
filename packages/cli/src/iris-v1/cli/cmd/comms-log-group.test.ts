import { describe, expect, test } from "bun:test"
import { newGroupId, GROUP_ID, buildLogPayloads, checkLogged, alsoSentTo, uniqueRecipients } from "./comms-log-group"

const viktor = { lead_id: 29019, name: "Viktor", email: "viktor@experience.art" }
const jc = { lead_id: 29016, name: "J.C. Adams", email: "jc@experience.art" }
const clayton = { lead_id: 29021, name: "Clayton Kirkwood", email: null }

const input = {
  channel: "apple_mail",
  direction: "outbound",
  body: "One email, three recipients.",
  subject: "Hosting",
  sentAt: "2026-09-18T20:15:00.000Z",
  groupId: "grp_test",
}

describe("comms log — one message to several leads (#186156)", () => {
  test("one copy per lead, all sharing ONE group id and ONE timestamp", () => {
    const p = buildLogPayloads([viktor, jc, clayton], input)
    expect(p.map((x) => x.lead_id)).toEqual([29019, 29016, 29021])
    expect(new Set(p.map((x) => x.message_group_id))).toEqual(new Set(["grp_test"]))
    expect(new Set(p.map((x) => x.sent_at)).size).toBe(1)
  })

  test("every copy carries the full recipient list, so each timeline knows who else got it", () => {
    const p = buildLogPayloads([viktor, jc, clayton], input)
    for (const x of p) {
      expect(x.metadata.recipients.map((r) => r.lead_id)).toEqual([29019, 29016, 29021])
      // a lead with no email on file is still a recipient; it just contributes no address
      expect(x.to_identifiers).toEqual(["viktor@experience.art", "jc@experience.art"])
    }
  })

  test("naming a lead twice logs it once", () => {
    expect(buildLogPayloads([viktor, jc, viktor], input).map((x) => x.lead_id)).toEqual([29019, 29016])
    expect(uniqueRecipients([viktor, viktor]).length).toBe(1)
  })

  test("a single lead still works exactly as before", () => {
    const [only] = buildLogPayloads([viktor], input)
    expect(only.lead_id).toBe(29019)
    expect(only.metadata.recipients.length).toBe(1)
  })

  test("CC addresses are recorded, not logged to", () => {
    const p = buildLogPayloads([viktor], { ...input, cc: ["assistant@experience.art"] })
    expect(p.length).toBe(1)
    expect(p[0]!.metadata.cc).toEqual(["assistant@experience.art"])
  })

  test("a 200 carrying ANOTHER lead's row is not success — that was the bug", () => {
    expect(checkLogged(29016, 200, { lead_id: 29019 })).toBe("wrong_lead")
    expect(checkLogged(29016, 201, { lead_id: 29016 })).toBe("logged")
    expect(checkLogged(29016, 200, { lead_id: "29016" })).toBe("already")
    expect(checkLogged(29016, 409, null)).toBe("failed")
    expect(checkLogged(29016, 200, null)).toBe("wrong_lead")
  })

  test("the timeline line names everyone else, not the lead you are looking at", () => {
    const row = { metadata: { recipients: [viktor, jc, clayton] } }
    expect(alsoSentTo(row, 29019)).toBe("also sent to: J.C. Adams, Clayton Kirkwood")
    expect(alsoSentTo({ metadata: { recipients: [viktor] } }, 29019)).toBeNull()
    expect(alsoSentTo({}, 29019)).toBeNull()
  })

  test("generated group ids are ones the server accepts", () => {
    for (let i = 0; i < 50; i++) expect(GROUP_ID.test(newGroupId())).toBe(true)
    expect(GROUP_ID.test("grp bad!")).toBe(false)
  })
})
