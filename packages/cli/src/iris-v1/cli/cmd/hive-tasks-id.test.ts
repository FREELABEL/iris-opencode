import { expect, test } from "bun:test"
import { isFullTaskId, looksLikeTaskId, resolveTaskPrefix } from "./platform-hive"

// #186129 — `iris hive tasks <id>` printed the recent list and ignored the id.
test("full ids and the shortened form the list prints are both task ids", () => {
  expect(looksLikeTaskId("01a0b71b-6b2c-7c3e-9d4f-0123456789ab")).toBe(true)
  expect(looksLikeTaskId("01a0bab8-b78")).toBe(true)
  expect(looksLikeTaskId("01J8Z3Y4X5W6V7T8S9R0Q1P2N3")).toBe(true)
  expect(isFullTaskId("01a0bab8-b78")).toBe(false)
})
test("subcommand names are not mistaken for ids", () => {
  for (const s of ["create", "new", "get", "logs", "running", "abc123"]) expect(looksLikeTaskId(s)).toBe(false)
})
test("a shortened id resolves to exactly one task, or says why not", () => {
  const ids = ["01a0bab8-b78a-7000-8000-000000000001", "01a0ba9d-7050-7000-8000-000000000002", "01a0ba9d-7051-7000-8000-000000000003"]
  expect(resolveTaskPrefix("01a0bab8-b78", ids)).toEqual({ id: ids[0] })
  expect(resolveTaskPrefix("01a0ba9d-705", ids)).toEqual({ error: expect.stringContaining("matches 2 tasks") })
  expect(resolveTaskPrefix("ffffffff", ids)).toEqual({ error: expect.stringContaining("no task starting with") })
})
