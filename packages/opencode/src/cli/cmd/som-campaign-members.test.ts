import { test, expect } from "bun:test"
import { memberTarget, addBody, removeQuery, mineQuery, formatMembers, membersSummary } from "./som-campaign-members"

// #193486: owner and reps on a SOM campaign.

test("memberTarget: exactly one of --user or --agent", () => {
  expect(memberTarget({}).ok).toBe(false)
  expect(memberTarget({ user: "5", agent: "7" }).ok).toBe(false)
  expect(memberTarget({ user: "42" })).toEqual({ ok: true, type: "user", id: 42 })
  expect(memberTarget({ user: 42 })).toEqual({ ok: true, type: "user", id: 42 })
  expect(memberTarget({ user: "ana@example.com" })).toEqual({ ok: true, type: "user", email: "ana@example.com" })
  expect(memberTarget({ agent: "7" })).toEqual({ ok: true, type: "agent", id: 7 })
})

test("memberTarget: refuses junk", () => {
  expect(memberTarget({ user: "ana" }).ok).toBe(false)
  expect(memberTarget({ agent: "bot" }).ok).toBe(false)
  expect(memberTarget({ agent: "0" }).ok).toBe(false)
})

test("addBody: role defaults to rep, rejects unknown roles", () => {
  expect(addBody({ user: "42" })).toEqual({ ok: true, body: { type: "user", role: "rep", id: 42 } })
  expect(addBody({ user: "ana@example.com", role: "owner" })).toEqual({ ok: true, body: { type: "user", role: "owner", email: "ana@example.com" } })
  expect(addBody({ agent: 7, role: "rep" })).toEqual({ ok: true, body: { type: "agent", role: "rep", id: 7 } })
  expect(addBody({ user: "42", role: "manager" }).ok).toBe(false)
})

test("removeQuery: by id only", () => {
  expect(removeQuery({ user: "42" })).toEqual({ ok: true, qs: "type=user&id=42" })
  expect(removeQuery({ agent: "7" })).toEqual({ ok: true, qs: "type=agent&id=7" })
  expect(removeQuery({ user: "ana@example.com" }).ok).toBe(false)
})

test("mineQuery", () => {
  expect(mineQuery({})).toBe("")
  expect(mineQuery({ live: true })).toBe("?live=1")
  expect(mineQuery({ agent: "7", active: true })).toBe("?agent_id=7&active=1")
})

test("formatMembers and membersSummary", () => {
  const members = [
    { type: "user" as const, id: 42, name: "Ana", role: "owner" as const },
    { type: "agent" as const, id: 7, name: "Scout", role: "rep" as const },
    { type: "user" as const, id: 9, name: null, role: "rep" as const },
  ]
  const lines = formatMembers(members)
  expect(lines).toHaveLength(3)
  expect(lines[0]).toContain("owner")
  expect(lines[0]).toContain("user #42")
  expect(lines[0]).toContain("Ana")
  expect(lines[2]).toContain("(unknown")
  expect(formatMembers([])[0]).toContain("no members")
  expect(membersSummary(members)).toBe("owner Ana · 2 reps")
  expect(membersSummary([])).toBe("no members")
  expect(membersSummary(undefined)).toBe("no members")
})
