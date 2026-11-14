import { describe, test, expect } from "bun:test"
import { localSourceOf, whereItRuns } from "./intent-where"

// =============================================================================
// #189480 — `iris intent "respond to the job outreach emails in my Apple Mail inbox"`
// picked `iris mail send` and said nothing about WHERE. On the cloud box that command
// cannot see any mail, and an online Mac with apple_mail sat unmentioned. The pick was
// right; the answer was incomplete in the way that sends someone to SSH.
// =============================================================================

describe("localSourceOf — which commands need a machine's own data", () => {
  test.each([
    ["iris mail send a@b.c -s x -b y", "apple_mail"],
    ["iris mail inbox --people", "apple_mail"],
    ["iris imessage search +15555550100", "imessage"],
  ])("%s → %s", (line, src) => {
    expect(localSourceOf(line)).toBe(src)
  })

  test("a cloud command needs nothing local", () => {
    expect(localSourceOf("iris leads search Delgado")).toBeNull()
    // `mailing` is the bulk-mail product, not Apple Mail — a prefix match would get this wrong.
    expect(localSourceOf("iris mailing list")).toBeNull()
  })
})

describe("whereItRuns", () => {
  const ready = { state: "ready", node_name: "AlexMaysnow1063" }

  test("off a Mac, names the online node that has it", () => {
    const s = whereItRuns("iris mail inbox", { platform: "linux", reach: ready })
    expect(s).toMatch(/AlexMaysnow1063/)
    expect(s).toMatch(/apple_mail/)
  })

  test("a command iris does not carry over Hive is never described as routed", () => {
    for (const line of ["iris mail send a@b.c -s x -b y", "iris mail reply <id> -b y", "iris imessage search +15555550100"]) {
      const s = whereItRuns(line, { platform: "linux", reach: ready })
      expect(s).toMatch(/AlexMaysnow1063/)
      expect(s).toMatch(/does not route/)
    }
    expect(whereItRuns("iris mail read x", { platform: "linux", reach: ready })).toMatch(/routes it there/)
  })

  test("on a Mac that has it, says nothing — runs here", () => {
    expect(whereItRuns("iris mail inbox", { platform: "darwin", localAvailable: true, reach: ready })).toBeNull()
  })

  test("nobody has it → says so and how to check, rather than letting it fail later", () => {
    const s = whereItRuns("iris mail inbox", { platform: "linux", reach: { state: "offline" } })
    expect(s).toMatch(/no online Hive node/i)
    expect(s).toMatch(/iris hive nodes list/)
  })

  test("reach not measured (API down) is said as not measured, not as 'nobody has it'", () => {
    const s = whereItRuns("iris mail inbox", { platform: "linux", reach: null })
    expect(s).toMatch(/could not check/i)
  })

  test("a cloud command gets no line", () => {
    expect(whereItRuns("iris leads search x", { platform: "linux", reach: ready })).toBeNull()
  })
})
