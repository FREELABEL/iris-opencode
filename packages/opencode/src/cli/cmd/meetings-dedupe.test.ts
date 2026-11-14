import { describe, expect, test } from "bun:test"
import { contentFingerprint } from "./platform-meetings"

/** The shape the fingerprint reads. Only these fields may influence it. */
const session = (over: Partial<any> = {}): any => ({
  id: "r380220",
  source: "rabbit",
  dir: "",
  mtime: new Date("2026-09-01T18:54:00Z"),
  segments: 13,
  duration: "8:21",
  preview: "The other thing is that whenever we, we need to basically have the flexibility",
  title: "Trial Licensing and Agent Sandbox Architecture",
  ...over,
})

describe("meetings dedupe — a re-sent email is not a new meeting (#183460)", () => {
  test("the same recording mailed twice fingerprints identically", () => {
    // Exactly the bug: rabbit re-sent this as r380269, and the id marker said "new".
    const first = session({ id: "r380220", mtime: new Date("2026-09-01T18:54:00Z") })
    const resent = session({ id: "r380269", mtime: new Date("2026-09-02T06:40:00Z") })
    expect(contentFingerprint(resent)).toBe(contentFingerprint(first))
  })

  test("arrival time alone never changes the fingerprint", () => {
    // mtime is the mail's arrival, the one field that DOES change on a re-send.
    expect(contentFingerprint(session({ mtime: new Date("2030-01-01T00:00:00Z") }))).toBe(
      contentFingerprint(session()),
    )
  })

  test("genuinely different meetings do not collide", () => {
    const a = contentFingerprint(session())
    expect(contentFingerprint(session({ title: "Ads Audit, Dashboard QA, and Onboarding Plan" }))).not.toBe(a)
    expect(contentFingerprint(session({ segments: 90 }))).not.toBe(a)
    expect(contentFingerprint(session({ duration: "42:18" }))).not.toBe(a)
    expect(contentFingerprint(session({ preview: "Okay. So the big thing I need to do right now" }))).not.toBe(a)
  })

  test("a missing title still fingerprints (Wispr has no title, only a UUID)", () => {
    expect(contentFingerprint(session({ title: undefined }))).toHaveLength(16)
  })
})
