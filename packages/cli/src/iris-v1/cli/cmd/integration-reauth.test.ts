import { describe, expect, test } from "bun:test"
import { detectNewConnection, type ConnectionRow } from "./integration-connect-state"

/**
 * A REPAIR IS THE COMMON CASE, AND IT REPORTED FAILURE.
 *
 * Observed 2026-08-28 on a real user's machine, in a real terminal (so none of the headless
 * work in #182693 applies). She ran:
 *
 *     iris integrations connect gmail --yes
 *
 * …authorised successfully in the browser, waited through the 60s poll, and got:
 *
 *     No new connection detected — authorization did not complete
 *
 * `--yes` OVERWRITES the existing record rather than adding one, so the row keeps its id.
 * And `status` was already "active" — local status is a claim, not a test; a dead credential
 * sits at "active" indefinitely. So neither "brand new row" nor "became active" could fire,
 * and a successful authorisation was indistinguishable from a failed one.
 *
 * The credential id is the thing that actually changes. These pin that.
 */
const GMAIL_BEFORE: ConnectionRow[] = [
  { id: "11", type: "gmail", name: "Gmail", status: "active", connected_account_id: "ca_OLD" },
]

describe("re-authorising an already-active connection", () => {
  test("a new credential behind the same row is SUCCESS", () => {
    const after: ConnectionRow[] = [
      { id: "11", type: "gmail", name: "Gmail", status: "active", connected_account_id: "ca_NEW" },
    ]
    expect(detectNewConnection(GMAIL_BEFORE, after, "gmail")?.id).toBe("11")
  })

  test("an untouched connection is still NOT success — #171182 must not regress", () => {
    const after: ConnectionRow[] = [
      { id: "11", type: "gmail", name: "Gmail", status: "active", connected_account_id: "ca_OLD" },
    ]
    expect(detectNewConnection(GMAIL_BEFORE, after, "gmail")).toBeNull()
  })

  test("a different integration re-authorising does not count for this one", () => {
    const after: ConnectionRow[] = [
      { id: "11", type: "gmail", name: "Gmail", status: "active", connected_account_id: "ca_OLD" },
      { id: "12", type: "slack", name: "Slack", status: "active", connected_account_id: "ca_SLACK_NEW" },
    ]
    expect(detectNewConnection(GMAIL_BEFORE, after, "gmail")).toBeNull()
  })

  test("rows with no credential id fall back to the old rules, not to false success", () => {
    const before: ConnectionRow[] = [{ id: "11", type: "gmail", status: "active" }]
    const after: ConnectionRow[] = [{ id: "11", type: "gmail", status: "active" }]
    expect(detectNewConnection(before, after, "gmail")).toBeNull()
  })

  test("a brand-new row still succeeds, credential id or not", () => {
    const after: ConnectionRow[] = [
      { id: "11", type: "gmail", status: "active", connected_account_id: "ca_OLD" },
      { id: "77", type: "gmail", name: "Personal", status: "active", connected_account_id: "ca_SECOND" },
    ]
    expect(detectNewConnection(GMAIL_BEFORE, after, "gmail")?.id).toBe("77")
  })

  test("a row that was inactive and is now active still succeeds", () => {
    const before: ConnectionRow[] = [{ id: "11", type: "gmail", status: "revoked", connected_account_id: "ca_OLD" }]
    const after: ConnectionRow[] = [{ id: "11", type: "gmail", status: "active", connected_account_id: "ca_OLD" }]
    expect(detectNewConnection(before, after, "gmail")?.id).toBe("11")
  })
})
