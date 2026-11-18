import { describe, expect, test } from "bun:test"
import { serverPreviewParams, previewWroteSomething, SERVER_PREVIEW_FUNCTIONS } from "../../src/cli/cmd/integration-write-gate"

/**
 * #193000 — a preview of a Servis write must reach the server, and must never write.
 *
 * Before: `iris integrations exec servis-ai move_case_stage …` without --apply printed the typed
 * parameters and stopped, so the real preview (ready / held, old → new) needed
 * `apply=false --apply`, which reads as a write to a person and to safety tooling.
 */
describe("serverPreviewParams", () => {
  test("a listed Servis tool without --apply is previewed on the server with apply=false", () => {
    expect(serverPreviewParams("servis-ai", "move_case_stage", { case_ids: "CAS1" }, { apply: false })).toEqual({ case_ids: "CAS1", apply: false })
  })

  test("apply=true left in a params file is forced back to false without --apply", () => {
    expect(serverPreviewParams("servis-ai", "bulk_update_case_providers", { changes: [], apply: true }, { apply: false })?.apply).toBe(false)
    expect(serverPreviewParams("servis-ai", "update_payment_notes", { apply: "true" }, { apply: false })?.apply).toBe(false)
  })

  test("with --apply nothing changes: the call goes through exactly as typed", () => {
    expect(serverPreviewParams("servis-ai", "move_case_stage", { apply: true }, { apply: true })).toBeNull()
  })

  test("--dry-run keeps the local rehearsal", () => {
    expect(serverPreviewParams("servis-ai", "move_case_stage", {}, { apply: false, forceDryRun: true })).toBeNull()
  })

  test("tools not on the list keep the local rehearsal (undo, other integrations)", () => {
    expect(serverPreviewParams("servis-ai", "undo_received_payments", {}, { apply: false })).toBeNull()
    expect(serverPreviewParams("gmail", "send_email", {}, { apply: false })).toBeNull()
    expect(serverPreviewParams("mailjet", "update_payment_notes", {}, { apply: false })).toBeNull()
  })

  test("the list is exactly the five tools whose server default was read", () => {
    expect([...SERVER_PREVIEW_FUNCTIONS["servis-ai"]].sort()).toEqual(
      ["add_received_payments", "bulk_update_case_providers", "move_case_stage", "record_reduction", "update_payment_notes"],
    )
    expect(Object.keys(SERVER_PREVIEW_FUNCTIONS)).toEqual(["servis-ai"])
  })
})

describe("previewWroteSomething", () => {
  test("flags a preview that came back applied, at the top level or wrapped", () => {
    expect(previewWroteSomething({ mode: "applied" })).toBe(true)
    expect(previewWroteSomething({ result: { mode: "applied" } })).toBe(true)
    expect(previewWroteSomething({ mode: "dry_run" })).toBe(false)
    expect(previewWroteSomething(null)).toBe(false)
  })
})
