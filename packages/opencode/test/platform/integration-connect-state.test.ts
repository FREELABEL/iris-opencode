/**
 * #171182 (CLI half) — `iris integrations connect <type>` reported
 * "✓ connected successfully!" even when the browser OAuth had failed.
 *
 * Root cause: after opening the browser the command polled the user's
 * integrations and accepted ANY connection whose type matched. A user
 * re-authorising a BROKEN integration always already has a row of that type —
 * the expired one they are trying to fix — so the poll matched it immediately
 * and reported success. The Gmail redirect_uri_mismatch went unnoticed for
 * days because the CLI kept insisting the connection had worked.
 *
 * The fix is to compare against a snapshot taken BEFORE authorising, and only
 * claim success when something actually changed: a brand-new connection, or an
 * existing one that transitioned into `active`.
 */
import { describe, test, expect } from "bun:test"
import { detectNewConnection } from "../../src/cli/cmd/integration-connect-state"

const expired = { id: "ca_old", type: "gmail", status: "expired" }
const active = { id: "ca_old", type: "gmail", status: "active" }

describe("detectNewConnection (#171182)", () => {
  test("does NOT report success when the only match is the pre-existing expired connection", () => {
    // This is the exact Gmail case: OAuth failed, nothing changed.
    expect(detectNewConnection([expired], [expired], "gmail")).toBeNull()
  })

  test("reports success when a brand-new connection appears", () => {
    const after = [expired, { id: "ca_new", type: "gmail", status: "active" }]

    expect(detectNewConnection([expired], after, "gmail")?.id).toBe("ca_new")
  })

  test("reports success when the existing connection transitions to active", () => {
    expect(detectNewConnection([expired], [active], "gmail")?.id).toBe("ca_old")
  })

  test("does NOT report success for a new connection that is not active", () => {
    const after = [expired, { id: "ca_new", type: "gmail", status: "initializing" }]

    expect(detectNewConnection([expired], after, "gmail")).toBeNull()
  })

  test("ignores connections of a different type", () => {
    const after = [expired, { id: "ca_slack", type: "slack", status: "active" }]

    expect(detectNewConnection([expired], after, "gmail")).toBeNull()
  })

  test("reports success on a first-ever connection (empty snapshot)", () => {
    expect(detectNewConnection([], [active], "gmail")?.id).toBe("ca_old")
  })

  test("matches type case-insensitively", () => {
    const after = [{ id: "ca_new", type: "GMail", status: "ACTIVE" }]

    expect(detectNewConnection([], after, "gmail")?.id).toBe("ca_new")
  })

  test("tolerates the alternate integration_type field name", () => {
    const after = [{ id: "ca_new", integration_type: "gmail", status: "active" }]

    expect(detectNewConnection([], after as any, "gmail")?.id).toBe("ca_new")
  })

  test("an already-active connection that was already active is not success", () => {
    // Re-running connect on a healthy integration should not claim a new
    // authorisation happened just because a healthy row exists.
    expect(detectNewConnection([active], [active], "gmail")).toBeNull()
  })

  test("survives a malformed/empty poll response without false success", () => {
    expect(detectNewConnection([expired], [], "gmail")).toBeNull()
    expect(detectNewConnection([expired], undefined as any, "gmail")).toBeNull()
  })
})
