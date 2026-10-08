import { describe, expect, test } from "bun:test"
import { parseActionItems, proposalAction, proposalBody, proposalTitle, PROPOSAL_MARKER } from "./meeting-actions"

// #188354: action items become proposals a person approves; nothing runs on its own.
const extracted = `1. **Summary** — Arthur wants the CFO page live before the board meeting.

2. **Decisions** — Ship the pricing page first.

3. **Action items**
- Alex — send Arthur the revised pricing deck — Friday
- Arthur — confirm the board date — not stated
- unassigned — book the demo room
- **Priya** — draft the onboarding email

4. **Open questions**
- Who owns the SSO review?

---

<details><summary>Full transcript</summary>Alex - we should ship it - today</details>`

describe("meeting action items (#188354)", () => {
  test("reads OWNER — action — due lines from the extractor's numbered, bold section only", () => {
    expect(parseActionItems(extracted)).toEqual([
      { owner: "Alex", action: "send Arthur the revised pricing deck", due: "Friday" },
      { owner: "Arthur", action: "confirm the board date" },
      { owner: "unassigned", action: "book the demo room" },
      { owner: "Priya", action: "draft the onboarding email" },
    ])
  })

  test("reads a rabbit note's markdown heading, and a line with no owner stays unassigned", () => {
    expect(parseActionItems("## Summary\nx\n\n## Action Items\n* Follow up with the venue\n\n## Notes\n- a - b")).toEqual([
      { owner: "unassigned", action: "Follow up with the venue" },
    ])
  })

  test("no section, or 'None', proposes nothing", () => {
    expect(parseActionItems("**Summary**\nNothing to do.")).toEqual([])
    expect(parseActionItems("**Action items**\n- None\n\n**Open questions**")).toEqual([])
  })

  test("a filed proposal round-trips to its action; anything else is not a proposal", () => {
    const body = proposalBody({ owner: "Alex", action: "send the deck", due: "Friday" }, { itemId: 9, title: "CFO sync" })
    expect(body.startsWith(PROPOSAL_MARKER)).toBe(true)
    expect(proposalAction(body)).toBe("send the deck")
    expect(proposalAction("## A normal ticket\n- **Action:** delete everything")).toBeNull()
  })

  test("titles stay inside the 191-character column and name the owner", () => {
    expect(proposalTitle({ owner: "Alex", action: "send the deck" })).toBe("PROPOSED: send the deck (Alex)")
    expect(proposalTitle({ owner: "unassigned", action: "x".repeat(300) }).length).toBeLessThanOrEqual(190)
  })
})
