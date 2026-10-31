import { describe, expect, test } from "bun:test"
import { editAccess } from "./platform-pages"

/**
 * #187217. fl-api answers "could this account save the page?" on every read. A client editor
 * finished a whole update before learning the page belonged to the operator account, because
 * no command printed that answer.
 */
describe("editAccess", () => {
  test("says no, who is asking, and the server's reason", () => {
    const a = editAccess({ can_edit: false, acting_user_id: 5269, edit_block_reason: "owned by user #193 — ask them to reassign it" })
    expect(a?.ok).toBe(false)
    expect(a?.line).toContain("no")
    expect(a?.line).toContain("#5269")
    expect(a?.line).toContain("owned by user #193")
  })

  test("says yes when the server allows it", () => {
    expect(editAccess({ can_edit: true, acting_user_id: 193 })).toEqual({ ok: true, line: "yes (signed in as user #193)" })
  })

  test("still says no when the server gives no reason", () => {
    expect(editAccess({ can_edit: false })?.line).toContain("did not say why")
  })

  test("no answer from an older server is not read as a no", () => {
    expect(editAccess({ id: 143 })).toBeNull()
    expect(editAccess(null)).toBeNull()
  })
})
