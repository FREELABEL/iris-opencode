import { describe, expect, test } from "bun:test"
import { searchCapabilities, singular } from "./platform-find"
import index from "../../../capabilities.json"

// Retrieval decides what the model is ALLOWED to pick: a right answer outside the shortlist is a
// wrong answer however good the model is. Each case below was a real misroute (2026-10-07/08).
const rank = (q: string, name: string) =>
  searchCapabilities(index as any, q.toLowerCase(), "command", 400).findIndex((h) => h.e.name === name) + 1

describe("intent retrieval — the right command reaches the shortlist", () => {
  test("#188492 a plural meets its singular key: 'log bugs' retrieves bug report", () => {
    const r = rank("log bugs and build an atlas epic of the gaps", "bug report")
    expect(r).toBeGreaterThan(0)
    expect(r).toBeLessThanOrEqual(12)
  })
  test("#188493 'bloq' reaches the commands named atlas: create a bloq → atlas create first", () => {
    expect(rank("create a new bloq for Iris Orbit", "atlas create")).toBe(1)
  })
  test("#188493 'bloq' reaches atlas commands whose description never says bloq", () => {
    // atlas items' own words are "list items"; without the bloq→atlas expansion it ranked 20th.
    expect(rank("show the items in the hive bloq", "atlas items")).toBeLessThanOrEqual(12)
  })
  test("#188494 a page move finds genesis reassign by its purpose, not its field names", () => {
    const r = rank("move a genesis page to another bloq", "genesis reassign")
    expect(r).toBeGreaterThan(0)
    expect(r).toBeLessThanOrEqual(12)
  })
  test("'project' alone does not drag every atlas command over hive deploy", () => {
    expect(rank("deploy this project to the macbook node", "hive deploy")).toBeLessThanOrEqual(3)
  })
  test("singular() only strips a trailing -s on longer words", () => {
    expect(singular("bugs")).toBe("bug")
    expect(singular("bloqs")).toBe("bloq")
    expect(singular("class")).toBe("class")
    expect(singular("gas")).toBe("gas")
  })
})

describe("#188613 email words reach the mail commands, and the controls stay put", () => {
  const top = (q: string) => searchCapabilities(index as any, q.toLowerCase(), "command", 12).map((h) => h.e.name)
  test("reply in my email → mail send, not sites reply", () => {
    expect(top("reply to sarah in my email saying thanks for the intro")[0]).toBe("mail send")
  })
  test("'email <person>' as a verb is a send", () => {
    expect(top("email david the proposal pdf")).toContain("mail send")
  })
  test("reading email reaches gmail", () => {
    expect(top("check my email")).toContain("gmail inbox")
  })
  test("controls: a newsletter stays with email send, a text stays with imessage send", () => {
    expect(top("send the newsletter to the vip list")[0]).toBe("email send")
    expect(top("text mia that im running late")).toContain("imessage send")
  })
})
