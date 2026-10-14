import { describe, expect, test } from "bun:test"
import { firstParagraph, isValidSkillId, replicaIdentity, sessionRefreshNote, toSkillId } from "./skill-replica"

describe("skill ids", () => {
  test("the portable shape", () => {
    expect(isValidSkillId("deploy")).toBe(true)
    expect(isValidSkillId("genesis-bespoke-2")).toBe(true)
    for (const bad of ["", "Deploy", "client_intake", "client intake", "-x", "x-", "a--b", "x".repeat(65)]) expect(isValidSkillId(bad)).toBe(false)
  })
  test("capitals, spaces, underscores and accents become one hyphenated id", () => {
    expect(toSkillId("Client Intake_v2")).toBe("client-intake-v2")
    expect(toSkillId("  Café   Ops!! ")).toBe("cafe-ops")
    expect(toSkillId("___")).toBe("")
    expect(toSkillId("a".repeat(70) + "-b").length).toBeLessThanOrEqual(64)
  })
})

describe("replicaIdentity", () => {
  test("a valid playbook passes through untouched, with no repairs", () => {
    const r = replicaIdentity({ name: "deploy", description: "Ship it: safely" })
    expect(r).toEqual({ id: "deploy", description: "Ship it: safely", repairs: [] })
  })

  test("an invalid name is repaired and the repair is reported", () => {
    const r = replicaIdentity({ name: "Client Intake", description: "Take a client in" })
    expect(r.id).toBe("client-intake")
    expect(r.repairs.join()).toContain("client-intake")
  })

  test("a name with nothing usable produces NO id, so nothing is written", () => {
    const r = replicaIdentity({ name: "!!!", description: "x" })
    expect(r.id).toBeNull()
    expect(r.repairs.length).toBe(1)
  })

  test("a missing description is never emitted empty — first paragraph of the body", () => {
    const body = "# Title\n\n> Run it\n\n```bash\necho hi\n```\n\nReconcile the bills against\nthe ledger.\n\nSecond para."
    const r = replicaIdentity({ name: "bills", description: undefined, body })
    expect(r.description).toBe("Reconcile the bills against the ledger.")
    expect(r.repairs.join()).toContain("no description")
  })

  test("whitespace-only description, no prose at all → a generic but non-empty line", () => {
    const r = replicaIdentity({ name: "bare", description: "   \n ", body: "# Only a heading\n" })
    expect(r.description.length).toBeGreaterThan(10)
    expect(r.description).toContain("bare")
  })

  test("a non-string description (YAML number) is stringified, not dropped", () => {
    expect(replicaIdentity({ name: "n", description: 42 }).description).toBe("42")
  })

  test("an over-long description is clipped to 1024 and reported", () => {
    const r = replicaIdentity({ name: "long", description: "word ".repeat(400) })
    expect(r.description.length).toBeLessThanOrEqual(1024)
    expect(r.repairs.join()).toContain("1024")
  })
})

describe("firstParagraph", () => {
  test("skips lists, tables and html comments", () => {
    expect(firstParagraph("- a\n- b\n\n| x |\n\n<!-- c -->\n\nReal text here.")).toBe("Real text here.")
  })
})

describe("sessionRefreshNote (#189424)", () => {
  test("says a restart is needed and names the playbook", () => {
    const n = sessionRefreshNote(["deploy"])
    expect(n).toContain('"deploy"')
    expect(n.toLowerCase()).toContain("restart")
  })
})
