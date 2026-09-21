import { describe, expect, test } from "bun:test"
import { noticeCopy, resetPhrase } from "./allowance-notice"

const base = {
  threshold: 0.9,
  fraction: 0.92,
  spendUsd: 4.6,
  capUsd: 5,
  window: "week",
  resetsAt: "2026-09-28T00:00:00.000Z",
  upgradeUrl: "https://web.heyiris.io/pricing?source=desktop-limit",
}
const now = new Date("2026-09-24T12:00:00.000Z")

describe("allowance notice copy (#186457)", () => {
  test("says where they ARE, not which rung fired", () => {
    // Someone at 96% told "you have reached 90%" is given a number that is true and useless.
    const c = noticeCopy({ ...base, fraction: 0.96, spendUsd: 4.8 }, now)!
    expect(c.title).toContain("96%")
    expect(c.title).not.toContain("90%")
  })

  test("the money and the window come from the payload, never from here", () => {
    // A monthly $40 allowance must render as a monthly $40 allowance with no code change.
    const c = noticeCopy({ ...base, window: "month", capUsd: 40, spendUsd: 30, fraction: 0.75 }, now)!
    expect(c.title).toBe("You're at 75% of this month's allowance")
    expect(c.description).toContain("$30.00 of $40.00 used this month.")
  })

  test("a reset we cannot state is left out rather than guessed", () => {
    // "Resets soon" reads as a promise. An unparseable instant must produce silence on that
    // point, not a reassuring phrase.
    const c = noticeCopy({ ...base, resetsAt: "not a date" }, now)!
    expect(c.description).not.toContain("Resets")
    expect(c.description).toContain("$4.60 of $5.00")
  })

  test("a reset already in the past is not rendered as the future", () => {
    expect(resetPhrase("2026-09-01T00:00:00.000Z", now)).toBeNull()
  })

  test("reset phrasing scales with the distance", () => {
    expect(resetPhrase("2026-09-24T12:30:00.000Z", now)).toBe("in 30 min")
    expect(resetPhrase("2026-09-24T18:00:00.000Z", now)).toBe("in 6h")
    expect(resetPhrase("2026-10-20T00:00:00.000Z", now)).toContain("days")
  })

  test("no notice means no toast", () => {
    expect(noticeCopy(null)).toBeNull()
    expect(noticeCopy(undefined)).toBeNull()
  })

  test("an uncapped account can never produce copy", () => {
    // Guards against a zero cap reaching the formatter and rendering "$4.60 of $0.00".
    expect(noticeCopy({ ...base, capUsd: 0 }, now)).toBeNull()
  })

  test("the upgrade link is passed through and never constructed", () => {
    expect(noticeCopy(base, now)!.link).toBe(base.upgradeUrl)
    expect(noticeCopy({ ...base, upgradeUrl: null }, now)!.link).toBeNull()
  })
})
