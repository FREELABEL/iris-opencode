import { describe, expect, test } from "bun:test"
import { shouldPrintUrlOnly } from "./integration-connect-state"

/**
 * #182693 — a user in IRIS Desktop asked an agent to connect an integration and no OAuth URL
 * ever came back. Measured 2026-08-28:
 *
 *   $ echo "" | iris integrations connect notion
 *   Existing notion connection found and no TTY for a prompt.
 *   Cancelled
 *   exit code: 0
 *
 * Two defects in one line of output. The command refused (reasonable — overwriting a live
 * credential unasked is worse than stopping) and then reported that refusal as SUCCESS, so
 * the Desktop app, an agent, or any script could not tell "cancelled" from "worked".
 *
 * And on the path that does reach an OAuth URL, no-TTY still tried to open a browser nobody
 * can see and then blocked for 60 seconds polling for an authorisation nobody can perform.
 */
describe("shouldPrintUrlOnly", () => {
  test("an explicit --print-url always wins", () => {
    expect(shouldPrintUrlOnly({ printUrl: true, isTTY: true })).toBe(true)
    expect(shouldPrintUrlOnly({ printUrl: true, isTTY: false })).toBe(true)
  })

  test("no terminal implies it — the URL is the only useful output", () => {
    expect(shouldPrintUrlOnly({ printUrl: false, isTTY: false })).toBe(true)
  })

  test("an interactive terminal keeps the browser-opening flow", () => {
    expect(shouldPrintUrlOnly({ printUrl: false, isTTY: true })).toBe(false)
  })

  test("an undefined isTTY is treated as headless, not as a terminal", () => {
    // process.stdin.isTTY is `undefined` when piped, never `false` — reading it as
    // "maybe a terminal" is exactly how the agent path fell through to the browser branch.
    expect(shouldPrintUrlOnly({})).toBe(true)
  })
})
