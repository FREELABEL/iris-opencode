import { expect, test } from "bun:test"
import { dict } from "../../i18n/en"
import { emptyCopy } from "./iris-empty-states"

test("the empty views a new customer meets first each say what goes there and offer a next step", () => {
  for (const pane of ["atlas", "schemas", "playbooks", "integrations", "pages"]) {
    const c = emptyCopy(pane)!
    expect(c.body).toBeTruthy()
    expect(c.action).toBeTruthy()
  }
})

test("a search that found nothing says so, and offers to clear it", () => {
  expect(emptyCopy("atlas", "okafor")?.action?.kind).toBe("clear-search")
})

test("every key it names exists in English", () => {
  const keys = ["atlas", "schemas", "graph", "playbooks", "integrations", "pages"].flatMap((p) => {
    const c = emptyCopy(p)!
    return [c.title, c.body, c.action?.label].filter(Boolean) as string[]
  })
  const s = emptyCopy("x", "q")!
  for (const k of [...keys, s.title, s.body!, s.action!.label]) expect((dict as Record<string, string>)[k]).toBeTruthy()
})

test("a pane with no copy falls back to the panel's own sentence", () => {
  expect(emptyCopy("hive")).toBeUndefined()
})
