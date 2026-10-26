import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readSettings, rowsFromNodes, servingTunnelName, settingsPath, writeSettings } from "./platform-hive-models"
import { validTunnelName } from "./platform-hive-relay"

// #191176 — the models your machines serve to your own gateway.
const now = Date.parse("2026-10-26T12:00:00Z")
const fresh = new Date(now - 30_000).toISOString()
const stale = new Date(now - 600_000).toISOString()

describe("iris hive models", () => {
  test("a machine serving and reachable, one excluded, one not serving at all", () => {
    const rows = rowsFromNodes(
      [
        {
          name: "hive-001",
          connection_status: "online",
          local_llm: { available: true, models: ["qwen3:14b", "phi4"] },
          inference: { enabled: true, url: "https://hive-001-ai.t.heyiris.io", models: ["qwen3:14b"], updated_at: fresh },
        },
        { name: "laptop", connection_status: "online", local_llm: { available: true, models: ["llama3:8b"] } },
      ],
      now,
    )
    expect(rows).toEqual([
      { model: "llama3:8b", node: "laptop", serving: false, reachable: false, why: "not served (iris hive models serve on)" },
      { model: "phi4", node: "hive-001", serving: false, reachable: false, why: "excluded in ~/.iris/inference.json" },
      { model: "qwen3:14b", node: "hive-001", serving: true, reachable: true, why: undefined },
    ])
  })

  test("serving but not reachable says why: offline, no URL yet, stale report", () => {
    const base = { local_llm: { models: ["m"] }, inference: { enabled: true, url: "https://x-ai.t.heyiris.io", models: ["m"], updated_at: fresh } }
    const why = (n: any) => rowsFromNodes([{ name: "n", connection_status: "online", ...base, ...n }], now)[0].why
    expect(why({ connection_status: "offline" })).toBe("machine offline")
    expect(why({ inference: { ...base.inference, url: null } })).toBe("no tunnel URL yet")
    expect(why({ inference: { ...base.inference, updated_at: stale } })).toBe("report is stale")
  })

  test("no local model server is no rows, not an error", () => {
    expect(rowsFromNodes([{ name: "n", connection_status: "online" }, {}], now)).toEqual([])
  })

  test("the tunnel name is always a valid relay label", () => {
    for (const h of ["iris-hive-001", "Alexs-MacBook-Pro.local", "MY_BOX", "x".repeat(80), "---", ""]) {
      const n = servingTunnelName(h)
      expect(validTunnelName(n)).toBe(true)
      expect(n.endsWith("-ai")).toBe(true)
    }
    expect(servingTunnelName("Alexs-MacBook-Pro.local")).toBe("alexs-macbook-pro-ai")
  })

  test("the settings file the daemon reads: written 0600, missing = off", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hm-"))
    expect(readSettings(home).enabled).toBe(false)
    writeSettings({ ...readSettings(home), enabled: true, url: "https://x-ai.t.heyiris.io" }, home)
    expect(readSettings(home)).toMatchObject({ enabled: true, port: 3290, url: "https://x-ai.t.heyiris.io" })
    expect(fs.statSync(settingsPath(home)).mode & 0o777).toBe(0o600)
  })
})
