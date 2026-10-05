import { describe, expect, test } from "bun:test"
import {
  flattenContent,
  nameTokens,
  hitMatchesLead,
  gradeEvidence,
  groupByProject,
  type MentionHit,
} from "./lead-mentions"

/**
 * #182461 — `iris leads search` answered "is there a CRM row?" and reported it as
 * "do we know this person?". Tyler Smith is on the team, is written about across the
 * bloqs, and every lookup returned "No leads matching" — a false negative that reads
 * as a fact. Richard Delgado only resolved because a lead row happened to exist.
 *
 * These lock the two things that made it wrong: that project content is consulted at
 * all, and that a mention is attributed to a person only on real evidence.
 */

function hit(over: Partial<MentionHit> = {}): MentionHit {
  return {
    itemId: 1,
    title: "note",
    bloqId: 10,
    bloqName: "Ops",
    listName: "Notes",
    haystack: "",
    ...over,
  }
}

describe("flattenContent", () => {
  test("digs a name out of structured card content, not just plain strings", () => {
    const content = { blocks: [{ type: "text", value: "Handoff to Tyler Smith on Friday" }] }
    expect(flattenContent(content)).toContain("Tyler Smith")
  })

  test("survives the shapes the API actually returns", () => {
    expect(flattenContent("plain")).toBe("plain")
    expect(flattenContent(null)).toBe("")
    expect(flattenContent(["a", { b: "c" }])).toBe("a c")
  })

  test("terminates on self-referential content instead of hanging the search", () => {
    const loop: any = { name: "Tyler" }
    loop.self = loop
    expect(() => flattenContent(loop)).not.toThrow()
  })
})

describe("nameTokens", () => {
  test("drops fragments too short to mean anything", () => {
    // "de" would match "delgado", "design", "development" — a token that matches
    // everything is how an unrelated document gets attributed to a person.
    expect(nameTokens("Richard de Delgado")).toEqual(["richard", "delgado"])
  })

  test("deduplicates across name fields", () => {
    expect(nameTokens("Tyler Smith", "Tyler", "Smith")).toEqual(["tyler", "smith"])
  })
})

describe("hitMatchesLead", () => {
  const lead = { id: 1, name: "Tyler Smith", email: "tyler@example.com" }

  test("attributes a mention when every name token is present", () => {
    expect(hitMatchesLead(lead, hit({ haystack: "handoff to tyler smith on friday" }))).toBe(true)
  })

  test("a shared surname alone is NOT a match", () => {
    // The failure this guards: attributing a document to whichever Smith came back
    // first invents a link between a person and a file. Worse than no attribution.
    expect(hitMatchesLead(lead, hit({ haystack: "spoke with jordan smith about pricing" }))).toBe(false)
  })

  test("email is sufficient on its own — people are named inconsistently", () => {
    expect(hitMatchesLead(lead, hit({ haystack: "cc: tyler@example.com" }))).toBe(true)
  })

  test("word order and punctuation between the names do not matter", () => {
    expect(hitMatchesLead(lead, hit({ haystack: "smith, tyler (flo) — invoice" }))).toBe(true)
  })

  test("a lead with no usable name and no email claims nothing", () => {
    expect(hitMatchesLead({ id: 2 }, hit({ haystack: "anything at all" }))).toBe(false)
  })
})

describe("gradeEvidence", () => {
  test("mentions-only is a FINDING, not an empty result", () => {
    // The Tyler Smith case exactly: no CRM row, plenty of evidence.
    const ev = gradeEvidence({ crm: "none", hits: [hit({ haystack: "x" }), hit({ itemId: 2, bloqName: "Clients" })] })
    expect(ev.source).toBe("mentions-only")
    expect(ev.mentions).toBe(2)
    expect(ev.projects.sort()).toEqual(["Clients", "Ops"])
  })

  test("a CRM row corroborated by project content outranks one that is not", () => {
    const corroborated = gradeEvidence({ crm: "exact", hits: [hit()] })
    const bare = gradeEvidence({ crm: "exact", hits: [] })
    expect(corroborated.source).toBe("crm+mentions")
    expect(bare.source).toBe("crm-only")
    // The label must say WHY. "crm-only" with no explanation is the old silent answer
    // wearing a new name.
    expect(bare.why).toContain("no")
  })

  test("nothing found says so explicitly", () => {
    expect(gradeEvidence({ crm: "none", hits: [] }).source).toBe("none")
  })

  test("a PARTIAL crm hit is never dressed up as a match", () => {
    // Searching "tyler smith" surfaced ten unrelated @tyler_* handles via the one-word
    // fallback, each labelled as a plain CRM record. The fallback is fine; presenting
    // its output as an answer to the query the user typed is the bug.
    const ev = gradeEvidence({ crm: "partial", hits: [] })
    expect(ev.source).toBe("crm-partial")
    expect(ev.why).toContain("PARTIAL")
    expect(ev.source).not.toBe("crm-only")
  })

  test("an UNSEARCHED sweep never reads as an empty one", () => {
    // --crm-only, signed out, or the endpoint 500s. The first cut of this fix printed
    // "nothing written about them in any project" in all three cases — reintroducing
    // #182461 inside the patch for #182461.
    const ev = gradeEvidence({ crm: "exact", hits: [], mentionsSearched: false })
    expect(ev.why).toContain("NOT searched")
    expect(ev.why).not.toContain("nothing written about them")
  })

  test("the sweep is assumed to have run when nobody says otherwise", () => {
    expect(gradeEvidence({ crm: "exact", hits: [] }).why).toContain("nothing written about them")
  })

  test("project content that matches every token upgrades a partial CRM hit", () => {
    // The fragment got them on screen; the full-name mention is what proves them.
    expect(gradeEvidence({ crm: "partial", hits: [hit()] }).source).toBe("crm+mentions")
  })

  test("last-mentioned is the NEWEST mention, not whichever arrived last", () => {
    const ev = gradeEvidence({
      crm: "none",
      hits: [hit({ when: "2026-08-21T00:00:00Z" }), hit({ itemId: 2, when: "2026-06-01T00:00:00Z" })],
    })
    expect(ev.lastMentioned).toBe("2026-08-21T00:00:00Z")
  })
})

describe("groupByProject", () => {
  test("rolls hits up to the board they live in, densest first", () => {
    const groups = groupByProject([
      hit({ itemId: 1, bloqId: 10, bloqName: "Ops" }),
      hit({ itemId: 2, bloqId: 20, bloqName: "Clients" }),
      hit({ itemId: 3, bloqId: 20, bloqName: "Clients" }),
    ])
    expect(groups.map((g) => g.bloqName)).toEqual(["Clients", "Ops"])
    expect(groups[0].hits.length).toBe(2)
  })

  test("a hit with no board is still shown, never dropped", () => {
    const groups = groupByProject([hit({ bloqId: null, bloqName: null })])
    expect(groups.length).toBe(1)
    expect(groups[0].bloqName).toBe("Unknown project")
  })
})
