import { describe, expect, test } from "bun:test"
import { isReadAction, knownFunction, dryRunResult } from "../../src/cli/cmd/integration-write-gate"
import { knownFunctionsFor } from "../../src/cli/cmd/platform-run"

// Alex 2026-10-08: `iris integrations exec` rehearses writes unless --apply. Kristen's desktop agent
// "probed" create_label and made a real label in a client mailbox that IRIS could not delete.

describe("isReadAction — one-sided: unclear means write", () => {
  test("reads run", () => {
    for (const f of ["read_emails", "search_emails", "get_email", "get_labels", "list_files", "GOOGLE_DRIVE_LIST_FILES", "export_file", "get_insights", "preview_ad_creative"])
      expect(isReadAction(f)).toBe(true)
  })
  test("writes are rehearsed — including every action from Kristen's session", () => {
    for (const f of ["create_label", "add_label_to_email", "move_message", "move_email", "archive_email", "delete_label", "delete_gmail_label",
      "remove_label_from_email", "modify_message_labels", "send_email", "reply_to_email", "create_draft", "GOOGLE_DRIVE_DELETE_FOLDER_OR_FILE_ACTION", "trash_label"])
      expect(isReadAction(f)).toBe(false)
  })
  test("a name with a read verb AND a write verb is a write (get_or_create_label)", () => {
    expect(isReadAction("get_or_create_label")).toBe(false)
    expect(isReadAction("list_and_archive")).toBe(false)
  })
  test("a name with no recognisable verb is treated as a write", () => {
    for (const f of ["frobnicate", "labels", "", "x"]) expect(isReadAction(f)).toBe(false)
  })
})

test("the Gmail list now names the real actions — the stale three-item list is what made agents guess", () => {
  const names = (knownFunctionsFor("gmail") ?? []).map((f) => f.name)
  for (const f of ["create_label", "add_label", "move_to_label", "remove_label", "archive_emails", "trash_emails", "get_labels", "mark_as_read", "reply_to_email", "create_draft"])
    expect(names).toContain(f)
  expect(names.length).toBeGreaterThanOrEqual(16)
})

test("knownFunction: a guessed name is unknown (stopped before even a rehearsal); no list = cannot tell", () => {
  const gmail = knownFunctionsFor("gmail")
  expect(knownFunction("create_label", gmail)).toBe(true)
  expect(knownFunction("CREATE_LABEL", gmail)).toBe(true)
  for (const guess of ["trash_label", "remove_gmail_label", "deleteLabel", "move_message"]) expect(knownFunction(guess, gmail)).toBe(false)
  expect(knownFunction("anything", undefined)).toBeNull()
})

test("a dry run reports success:false and how to apply — never reads as done", () => {
  const d = dryRunResult("gmail", "create_label", { label_name: "Clients" })
  expect(d.success).toBe(false)
  expect(d.dry_run).toBe(true)
  expect(d.message).toMatch(/nothing was changed/i)
  expect(d.message).toMatch(/--apply/)
  expect(d.params).toEqual({ label_name: "Clients" })
})

// #188637 — every exec result names the mailbox/account that answered and the machine that asked.
import { accountLine } from "../../src/cli/cmd/platform-run"
import os from "os"

test("accountLine names the account, its connection id and this machine", () => {
  const line = accountLine({ success: true, _account: { integration_id: 136, account: "archive@vanguardhcs.com" } })
  expect(line).toBe(`↳ archive@vanguardhcs.com (#136) · from ${os.hostname()}`)
})

test("accountLine reads a server dry-run plan too, and says when the address is unknown", () => {
  expect(accountLine({ dry_run: true, would_run: { integration_id: 148 } })).toBe(`↳ connection #148 (address unknown) (#148) · from ${os.hostname()}`)
  expect(accountLine({ success: true })).toBeNull()
})
