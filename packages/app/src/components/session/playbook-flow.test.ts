import { describe, expect, test } from "bun:test"
import {
  areaTag,
  flowSteps,
  handsTag,
  HANDS_FILTERS,
  humanize,
  playbookSlugLine,
  matchesHands,
  neededPhrase,
  outcomeLine,
  playbookTitle,
  scopeWords,
  stripLabel,
  updatedAgo,
  whoOf,
  WHO_ICON,
  FILTER_ICON,
  scopeIcon,
  SCOPE_ICON,
  playbookDocBody,
} from "./playbook-flow"

// Playbooks · "03 Flow". These guard the CLAIMS the panel makes about a playbook — who does each
// step, whether it will ask you anything — not the pixels.

const steps = (...modes: (string | undefined)[]) => modes.map((mode, i) => ({ id: `s${i}`, title: `Step ${i}`, mode }))

describe("whoOf — who does a step", () => {
  test("model steps are IRIS thinking", () => {
    for (const m of ["ai", "prompt", "agent"]) expect(whoOf(m)).toBe("think")
  })
  test("commands and sub-playbooks run on their own", () => {
    for (const m of ["shell", "hive-script", "playbook"]) expect(whoOf(m)).toBe("auto")
  })
  test("human and manual steps need you", () => {
    for (const m of ["human", "manual"]) expect(whoOf(m)).toBe("you")
  })
  test("case and whitespace do not change the answer", () => {
    expect(whoOf(" Human ")).toBe("you")
    expect(whoOf("SHELL")).toBe("auto")
  })
  test("an unknown or missing mode is never guessed into a category", () => {
    for (const m of [undefined, null, "", "teleport", 3]) expect(whoOf(m)).toBe("unknown")
  })
})

describe("humanize (labels, never titles)", () => {
  test("field names become words", () => {
    expect(humanize("case_id")).toBe("Case id")
    expect(humanize("")).toBe("")
  })
})

describe("playbookTitle", () => {
  test("no title: the slug exactly — not tidied, not capitalised", () => {
    expect(playbookTitle({ name: "freelabel-ads" })).toBe("freelabel-ads")
    expect(playbookTitle({ name: "bills-to-books", title: "  " })).toBe("bills-to-books")
    expect(playbookSlugLine({ name: "freelabel-ads" })).toBeUndefined()
  })
  test("a real title leads, and the slug is kept underneath", () => {
    const row = { name: "atlas-epic", title: "Plan a project in the open" }
    expect(playbookTitle(row)).toBe("Plan a project in the open")
    expect(playbookSlugLine(row)).toBe("atlas-epic")
  })
  test("nothing at all", () => {
    expect(playbookTitle({})).toBe("Untitled playbook")
  })
})

describe("outcomeLine — the description's first sentence", () => {
  test("stops at the first sentence", () => {
    expect(outcomeLine("Send it a link. It finds what the tool really does.")).toBe("Send it a link.")
  })
  test("a description with no full stop is kept whole", () => {
    expect(outcomeLine("Draft outreach for new leads")).toBe("Draft outreach for new leads")
  })
  test("a long first sentence is cut at a word with an ellipsis", () => {
    const long = "word ".repeat(60).trim() + "."
    const out = outcomeLine(long, 50)
    expect(out.endsWith("…")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(51)
    expect(out).not.toMatch(/wor…$/)
  })
  test("empty is empty", () => {
    expect(outcomeLine(undefined)).toBe("")
  })
})

describe("handsTag — how hands-off", () => {
  test("no human step is fully automatic", () => {
    expect(handsTag({ steps: steps("shell", "ai") })).toEqual({ label: "Fully automatic", tone: "auto", count: 0 })
  })
  test("one human step asks once", () => {
    expect(handsTag({ steps: steps("shell", "human") })?.label).toBe("Asks you once")
  })
  test("several are counted", () => {
    expect(handsTag({ steps: steps("human", "ai", "manual", "human") })?.label).toBe("Asks you 3×")
  })
  test("no published steps claims nothing", () => {
    expect(handsTag({ steps: [] })).toBeNull()
    expect(handsTag({})).toBeNull()
  })
})

describe("matchesHands — the filter chips", () => {
  const auto = { name: "a", steps: steps("shell", "ai") }
  const once = { name: "b", steps: steps("shell", "human") }
  const twice = { name: "c", steps: steps("human", "ai", "manual") }
  const bare = { name: "d", steps: [] }
  const all = [auto, once, twice, bare]
  const pick = (f: Parameters<typeof matchesHands>[1]) => all.filter((r) => matchesHands(r, f)).map((r) => r.name)

  test("Anything keeps every row, including one with no steps", () => {
    expect(pick("any")).toEqual(["a", "b", "c", "d"])
  })
  test("each chip keeps exactly its own", () => {
    expect(pick("auto")).toEqual(["a"])
    expect(pick("once")).toEqual(["b"])
    expect(pick("charge")).toEqual(["c"])
  })
  test("the four chips are in the designed order", () => {
    expect(HANDS_FILTERS.map((f) => f.label)).toEqual([
      "Anything",
      "Fully automatic",
      "Asks me once",
      "I stay in charge",
    ])
  })
})

describe("plain words", () => {
  test("scope", () => {
    expect(scopeWords("public")).toBe("Everyone")
    expect(scopeWords("private")).toBe("Only you")
    expect(scopeWords("unlisted")).toBe("Link only")
    expect(scopeWords("project")).toBe("This project")
    expect(scopeWords("team-only")).toBe("Team only")
    expect(scopeWords(undefined)).toBeUndefined()
  })
  test("area only when the record carries one", () => {
    expect(areaTag({ name: "x" })).toBeUndefined()
    expect(areaTag({ category: "finance" })).toBe("Finance")
    expect(areaTag({ industries: ["", "healthcare"] })).toBe("Healthcare")
  })
  test("you'll need: required arguments only", () => {
    expect(neededPhrase([])).toBe("Nothing")
    expect(neededPhrase(undefined)).toBe("Nothing")
    expect(neededPhrase([{ name: "topic", required: false }])).toBe("Nothing")
    expect(neededPhrase([{ name: "link", required: true }])).toBe("Link")
    expect(
      neededPhrase([
        { name: "bloq", required: true },
        { name: "source_url", required: true },
        { name: "note" },
        { name: "claim", required: true },
      ]),
    ).toBe("Bloq, source url and claim")
  })
})

describe("updatedAgo", () => {
  const now = Date.parse("2026-10-09T12:00:00Z")
  test("reads like a person says it", () => {
    expect(updatedAgo("2026-10-09T08:00:00Z", now)).toBe("today")
    expect(updatedAgo("2026-10-08T08:00:00Z", now)).toBe("yesterday")
    expect(updatedAgo("2026-10-04T12:00:00Z", now)).toBe("5 days ago")
    expect(updatedAgo("2026-09-25T12:00:00Z", now)).toBe("2 weeks ago")
    expect(updatedAgo("2026-07-01T12:00:00Z", now)).toBe("3 months ago")
    expect(updatedAgo("2024-10-01T12:00:00Z", now)).toBe("2 years ago")
  })
  test("missing or garbage is undefined, not an invented age", () => {
    expect(updatedAgo(undefined, now)).toBeUndefined()
    expect(updatedAgo("not a date", now)).toBeUndefined()
  })
})

describe("the strip", () => {
  test("one entry per step, in order, with who", () => {
    const s = flowSteps({ steps: steps("shell", "ai", "human", "mystery") })
    expect(s.map((x) => x.who)).toEqual(["auto", "think", "you", "unknown"])
  })
  test("its accessible name lists who does each step", () => {
    expect(stripLabel(flowSteps({ steps: steps("shell", "human") }))).toBe("2 steps: Runs on its own, Needs you")
    expect(stripLabel([])).toBe("Steps not published")
  })
})

describe("icons — one meaning each", () => {
  test("who does it", () => {
    expect(WHO_ICON).toEqual({ think: "sparkle", auto: "settings-gear", you: "hand", unknown: undefined })
  })
  test("the filter chips reuse the who icons for the same meaning", () => {
    expect(FILTER_ICON.any).toBeUndefined()
    expect<string | undefined>(FILTER_ICON.auto).toBe(WHO_ICON.auto)
    expect<string | undefined>(FILTER_ICON.once).toBe(WHO_ICON.you)
    expect<string | undefined>(FILTER_ICON.charge).toBe(WHO_ICON.you)
  })
  test("scope", () => {
    expect(["public", "private", "unlisted", "project", "other"].map(scopeIcon)).toEqual([
      "globe",
      "lock",
      "link",
      "folder",
      undefined,
    ])
  })
  test("no icon means two things: the who and scope sets do not overlap", () => {
    const who = new Set(Object.values(WHO_ICON).filter(Boolean))
    for (const s of ["globe", "lock", "link", "folder"]) expect(who.has(s as any)).toBe(false)
    // and the scope icons never reuse the step-count icon
    expect(Object.values(SCOPE_ICON)).not.toContain("checklist")
  })
})

describe("playbookDocBody", () => {
  test("drops the YAML settings block and keeps the document", () => {
    const doc =
      "---\nname: architecture-review\ndescription: Catch it early\nallowed-tools:\n  - Read\n  - Grep\n---\n\n# Architecture Review\n\nRun it before code."
    expect(playbookDocBody(doc)).toBe("# Architecture Review\n\nRun it before code.")
  })
  test("a document with no settings block is left alone", () => {
    expect(playbookDocBody("# Title\n\n---\n\nA rule is not frontmatter.")).toBe(
      "# Title\n\n---\n\nA rule is not frontmatter.",
    )
  })
  test("CRLF files and a BOM are handled", () => {
    expect(playbookDocBody("﻿---\r\nname: x\r\n---\r\n# T")).toBe("# T")
  })
  test("an unterminated block is not eaten", () => {
    expect(playbookDocBody("---\nname: x\n# no closing fence")).toBe("---\nname: x\n# no closing fence")
  })
})
