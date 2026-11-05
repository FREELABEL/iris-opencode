import { describe, expect, test } from "bun:test"
import { afterBoards, afterSetup, confirmText, pinLabel, pinRefused, type CampaignBoard } from "./iris-campaign-onboarding-model"

const acme: CampaignBoard = { id: 912, name: "Acme Shoes", role: "owner" }
const client: CampaignBoard = { id: 40, name: "Client board", role: "editor" }
const noIds = /912|\b\d{3}\b|bloq/i

describe("campaign onboarding: the board step (#192627)", () => {
  test("exactly one board skips the picker and goes to confirm", () => {
    expect(afterBoards({ measured: true, boards: [acme] })).toEqual({ at: "confirm", board: acme, boards: [acme] })
  })
  test("several boards show the picker", () => {
    expect(afterBoards({ measured: true, boards: [acme, client] })).toEqual({ at: "pick", boards: [acme, client] })
  })
  test("no board the account owns or edits says what to do, without a retry", () => {
    const s = afterBoards({ measured: true, boards: [] })
    expect(s).toMatchObject({ at: "message", retry: false })
  })
  test("a list that could not be read offers a retry", () => {
    expect(afterBoards({ measured: false, reason: "Sign in to IRIS first.", boards: [] })).toMatchObject({
      at: "message",
      tone: "error",
      body: "Sign in to IRIS first.",
      retry: true,
    })
  })
  test("confirm says what will be made, in plain words, on the board by name", () => {
    const t = confirmText(acme)
    expect(t).toContain("four datasets on Acme Shoes")
    expect(t).toContain("private review page")
    expect(t).not.toMatch(noIds)
  })
})

describe("campaign onboarding: after setup (#192627)", () => {
  test("a new board with its page: pin it as '<Board> campaigns'", () => {
    expect(
      afterSetup(acme, { ok: true, page_slug: "acme-shoes-campaigns", page_created: true, page_new: true, already_set_up: false }),
    ).toEqual({ do: "pin", slug: "acme-shoes-campaigns", label: "Acme Shoes campaigns", already: false })
    expect(pinLabel(acme)).toBe("Acme Shoes campaigns")
  })
  test("already set up: just pin it", () => {
    expect(afterSetup(acme, { ok: true, page_slug: "acme-shoes-campaigns", page_created: true, already_set_up: true })).toEqual({
      do: "pin",
      slug: "acme-shoes-campaigns",
      label: "Acme Shoes campaigns",
      already: true,
    })
  })
  test("the page is not made yet: nothing is pinned, and it says so", () => {
    const n = afterSetup(acme, { ok: true, page_slug: "acme-shoes-campaigns", page_created: false })
    expect(n.do).toBe("say")
    if (n.do !== "say") return
    expect(n.step.title).toMatch(/isn't made yet/)
    expect(n.step.body).toMatch(/nothing was pinned/)
  })
  test("no page slug at all is never pinned", () => {
    expect(afterSetup(acme, { ok: true, page_created: true }).do).toBe("say")
  })
  test("not deployed: a plain note, not a pin", () => {
    const n = afterSetup(acme, {
      ok: false,
      error: { kind: "not_deployed", message: "Campaign boards aren't switched on for your account yet. Nothing was made." },
    })
    expect(n).toMatchObject({ do: "say", step: { tone: "info", title: "Campaign boards aren't available yet", retry: false } })
  })
  test("not allowed names the board, never its id", () => {
    const n = afterSetup(acme, { ok: false, error: { kind: "not_allowed", message: "You can't set up campaigns on this board." } })
    expect(n).toMatchObject({ do: "say", step: { title: "You can't set up campaigns on Acme Shoes", retry: false } })
    if (n.do === "say") expect(n.step.title + n.step.body).not.toMatch(noIds)
  })
  test("a passing failure offers a retry", () => {
    expect(afterSetup(acme, { ok: false, error: { kind: "unreachable", message: "IRIS isn't answering right now." } })).toMatchObject({
      do: "say",
      step: { retry: true },
    })
  })
  test("a refused pin says where the page is", () => {
    expect(pinRefused(acme, "acme-shoes-campaigns", "not one of your pages")).toMatchObject({
      at: "message",
      body: expect.stringContaining("/p/acme-shoes-campaigns"),
    })
  })
})
