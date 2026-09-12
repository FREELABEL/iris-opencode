import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { expiresAtFor, inboxExpiresAt } from "./platform-hive-peer"
import { parseDuration } from "./platform-atlas-store"

/**
 * Layers 1 and 2 of epic #184633 — a sender chooses how long a message lives, and can ask for it
 * to be destroyed on first read.
 *
 * CONTEXT THAT SHAPED THESE TESTS. The TTL mechanism already existed and was already enforced by
 * the recipient's daemon; what did not exist was any way for a caller to CHOOSE it. Two places
 * decided the value independently — the CLI stamped `expires_at` for own-node sends, the relay
 * stamped its own 7-day default server-side — so the failure to guard against is not "expiry is
 * broken", it is `--expires 1h` meaning one hour to your own machine and seven days to everyone
 * else. That is why the helper is shared and why these assert both doors.
 *
 * WHAT THESE DO NOT CLAIM. None of this is a security property yet. The TTL is applied by the
 * receiving machine and the body is still retained server-side (#184632), so an older or modified
 * daemon ignores it entirely. Layer 3 is what would change that.
 */

const SRC_DIR = import.meta.dir
const peerSrc = readFileSync(join(SRC_DIR, "platform-hive-peer.ts"), "utf8")
const inboxSrc = readFileSync(join(SRC_DIR, "platform-hive-inbox.ts"), "utf8")

describe("TTL — the sender's choice reaches both doors", () => {
  test("no TTL given falls back to the 7-day default", () => {
    const got = Date.parse(expiresAtFor({ text: "x", inboxType: "message" }))
    const want = Date.parse(inboxExpiresAt())
    // Same instant modulo the milliseconds between the two calls.
    expect(Math.abs(got - want)).toBeLessThan(5_000)
  })

  test("a TTL is honoured, not rounded to the default", () => {
    const oneHour = parseDuration("1h")
    expect(oneHour).toBe(3_600_000)
    const got = Date.parse(expiresAtFor({ text: "x", inboxType: "message", ttlMs: oneHour! }))
    const delta = got - Date.now()
    expect(delta).toBeGreaterThan(3_500_000)
    expect(delta).toBeLessThan(3_700_000)
  })

  test("a zero or negative TTL falls back rather than producing a dead-on-arrival message", () => {
    for (const bad of [0, -1, -86_400_000]) {
      const delta = Date.parse(expiresAtFor({ text: "x", inboxType: "message", ttlMs: bad })) - Date.now()
      expect(delta).toBeGreaterThan(0)
    }
  })

  test("BOTH delivery paths use the shared helper, so they cannot drift apart", () => {
    // The own-node branch and the relay branch must each stamp expiresAtFor(d). If one of them
    // goes back to a bare default, --expires silently means different things per destination.
    const uses = peerSrc.match(/expiresAtFor\(d\)/g) ?? []
    expect(uses.length).toBeGreaterThanOrEqual(2)
  })
})

describe("parseDuration is reused, not reinvented", () => {
  test("the units the flag advertises actually parse", () => {
    expect(parseDuration("30m")).toBe(30 * 60_000)
    expect(parseDuration("4h")).toBe(4 * 3_600_000)
    expect(parseDuration("7d")).toBe(7 * 86_400_000)
  })

  test("unparseable input is null, so the caller can refuse instead of defaulting", () => {
    expect(parseDuration("soon")).toBeNull()
    expect(parseDuration("")).toBeNull()
  })

  test("the send command refuses an unreadable --expires rather than quietly using 7 days", () => {
    expect(inboxSrc).toContain('Could not read --expires')
  })
})

describe("burn-after-read destroys on EVERY render path", () => {
  test("the helper deletes the body and drops the manifest row", () => {
    expect(inboxSrc).toContain("function burnIfRequested")
    expect(inboxSrc).toMatch(/unlinkSync\(filePath\)/)
    expect(inboxSrc).toMatch(/writeManifest\(items\.filter/)
  })

  test("undefined burn behaves as false, so older items are untouched", () => {
    expect(inboxSrc).toContain("if (item.burn !== true) return")
  })

  /**
   * THE ONE THAT MATTERS. `read` returns early for links, so a single call at the bottom of the
   * handler would spare every link item — a burn that quietly does nothing for one type, which
   * from the outside is identical to a burn that worked.
   */
  test("it is called on the early-returning link path too, not just at the end", () => {
    const readHandler = inboxSrc.slice(inboxSrc.indexOf('command: "read <number>"'))
    const linkBranch = readHandler.slice(readHandler.indexOf('item.type === "link"'))
    const beforeReturn = linkBranch.slice(0, linkBranch.indexOf("return"))
    expect(beforeReturn).toContain("burnIfRequested")
  })

  test("every call happens AFTER the item has been shown", () => {
    // Guard against someone hoisting the call next to the read-receipt block, which would
    // delete the body before it is printed.
    const marked = inboxSrc.indexOf("item.read = true")
    const firstBurnCall = inboxSrc.indexOf("burnIfRequested(item, items)")
    expect(firstBurnCall).toBeGreaterThan(marked)
  })
})
