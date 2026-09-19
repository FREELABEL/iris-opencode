import { expect, test } from "bun:test"
import { nodeDirCandidates } from "./node-path"

test("prefers the newest runtime the installer ships, then package managers", () => {
  const list = (d: string) => (d.endsWith("runtime") ? ["node-v20.1.0-darwin-arm64", "node-v22.11.0-darwin-arm64", "other"] : [])
  expect(nodeDirCandidates("/Users/p", "darwin", list)).toEqual([
    "/Users/p/.iris/runtime/node-v22.11.0-darwin-arm64/bin",
    "/Users/p/.iris/runtime/node-v20.1.0-darwin-arm64/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ])
})

test("no shipped runtime still offers the package-manager locations a GUI PATH lacks", () => {
  expect(nodeDirCandidates("/Users/p", "darwin", () => [])).toEqual(["/opt/homebrew/bin", "/usr/local/bin"])
})
