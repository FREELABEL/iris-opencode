import { describe, expect, test } from "bun:test"
import { migrateTabs } from "./tab-migration"
import type { ServerConnection } from "./server"

const S = "local" as ServerConnection.Key

describe("shared room tabs (#194463)", () => {
  test("survive a restart with their title, and garbage does not", () => {
    expect(migrateTabs([{ type: "shared", server: S, roomId: "r1", title: "Pricing page" }], S)).toEqual([
      { type: "shared", server: S, roomId: "r1", title: "Pricing page" },
    ])
    expect(migrateTabs([{ type: "shared", server: S }], S)).toEqual([])
  })
})
