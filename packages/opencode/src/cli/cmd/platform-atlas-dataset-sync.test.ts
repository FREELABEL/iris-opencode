import { test, expect } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { readState, setBackground } from "./platform-atlas-dataset-sync"

// #189972 stage 3: opting a local copy in to background sync is a flag in its state file — the
// one place the Hive daemon reads (lib/atlas-sync.js findStores: state.background === true).
test("--background on/off is recorded where the daemon looks, and nothing else in the state changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-"))
  fs.mkdirSync(path.join(root, ".iris"), { recursive: true })
  fs.writeFileSync(path.join(root, ".iris", "state.json"), JSON.stringify({ slug: "cases", cursor: "abc", conflicts: { "3": ["note"] }, deleted_remotely: [] }))

  setBackground(root, "cases", true)
  const on = JSON.parse(fs.readFileSync(path.join(root, ".iris", "state.json"), "utf8"))
  expect(on.background).toBe(true)
  expect(on.slug).toBe("cases")
  expect(on.cursor).toBe("abc")
  expect(on.conflicts).toEqual({ "3": ["note"] })

  setBackground(root, "cases", false)
  expect(readState(root, "cases").background).toBe(false)
})
