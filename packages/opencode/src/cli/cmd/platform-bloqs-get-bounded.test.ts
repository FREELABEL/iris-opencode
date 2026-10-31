import { describe, expect, test } from "bun:test"
import { boundedBoardJson } from "./platform-bloqs"

/** #190327 — `bloqs get --json` returned 567 KB for one board, private member data included. */
describe("bloqs get --json is bounded", () => {
  const member = {
    id: 7, full_name: "Sam Lee", email: "sam@x.test", phone: "+15550001", stripe_customer_id: "cus_SECRET",
    stripe_connect_id: "acct_SECRET", credit_balance: 12, profiles: [{ phone: "+15550002", instagram: "@sam" }],
    pivot: { permission: "editor" },
  }
  const board = { id: 544, name: "Life", contains_phi: false, lists: [{ id: 1, items: [{ id: 9, content: "x".repeat(5000) }] }], shared_users: [member] }
  const lists = [{ id: 1, name: "Todo", items: [{ id: 9, content: "x".repeat(5000) }, { id: 10 }] }]

  test("lists are id, name and count; items are not repeated", () => {
    const out = boundedBoardJson(board, lists, [], "https://heyiris.io/atlas?project=544", false)
    expect(out.lists).toEqual([{ id: 1, name: "Todo", item_count: 2 }])
    expect(JSON.stringify(out)).not.toContain("xxxxx")
  })

  test("members carry who they are on the board, never their account or money", () => {
    const json = JSON.stringify(boundedBoardJson(board, lists, [], "", false))
    for (const secret of ["cus_SECRET", "acct_SECRET", "+15550001", "+15550002", "credit_balance", "profiles", "@sam"])
      expect(json).not.toContain(secret)
    expect(boundedBoardJson(board, lists, [], "", false).shared_users).toEqual([
      { id: 7, name: "Sam Lee", email: "sam@x.test", permission: "editor" },
    ])
  })

  test("--items keeps the lists with their items, once", () => {
    const out = boundedBoardJson(board, lists, [], "", true)
    expect(out.lists).toBe(lists)
    expect("lists" in out && (out as any).lists[0].items.length).toBe(2)
  })

  test("board metadata and relations stay", () => {
    const out = boundedBoardJson(board, lists, [{ type: "feeds_into", to: 3 }], "u", false)
    expect(out).toMatchObject({ id: 544, name: "Life", contains_phi: false, web_url: "u", relations: [{ type: "feeds_into", to: 3 }] })
  })
})
