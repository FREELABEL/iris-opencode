import { describe, expect, test } from "bun:test"
import { isTailnetIp, onTailnetOf, shellsOf } from "@/iris/hive-here"

// #192608 — Hive › Computers: what this computer knows about itself.

describe("tailnet addresses are read, not guessed", () => {
  test("100.64.0.0/10 and Tailscale's IPv6 prefix only — the bound fl-iris-api stores", () => {
    expect(isTailnetIp("100.64.0.1")).toBe(true)
    expect(isTailnetIp("100.127.255.254")).toBe(true)
    expect(isTailnetIp("100.79.222.57")).toBe(true)
    expect(isTailnetIp("fd7a:115c:a1e0::1")).toBe(true)
    expect(isTailnetIp("100.63.255.255")).toBe(false)
    expect(isTailnetIp("100.128.0.1")).toBe(false)
    expect(isTailnetIp("192.168.1.5")).toBe(false)
    expect(isTailnetIp("169.150.224.129")).toBe(false)
    expect(isTailnetIp("100.300.1.1")).toBe(false)
    expect(isTailnetIp("")).toBe(false)
    expect(isTailnetIp(undefined)).toBe(false)
  })
  test("this computer is on a tailnet when one of its interfaces holds such an address", () => {
    expect(onTailnetOf({ lo: [{ address: "127.0.0.1" }], tailscale0: [{ address: "100.79.222.57" }] })).toBe(true)
    expect(onTailnetOf({ lo: [{ address: "127.0.0.1" }], en0: [{ address: "192.168.1.20" }], x: undefined })).toBe(false)
  })
})

describe("shells Hive started here — the `iris hive panes` list", () => {
  test("pane counts per workspace, no names", () => {
    const s = shellsOf(200, {
      sessions: [
        { name: "iris-swarm-abc12345", type: "swarm", panes: [{ index: 0 }, { index: 1 }, { index: 2 }] },
        { name: "iris-task-1", type: null, panes: [{ index: 0 }] },
      ],
    })
    expect(s).toEqual({ measured: true, workspaces: [{ panes: 3, kind: "swarm" }, { panes: 1, kind: null }] })
    expect(JSON.stringify(s)).not.toContain("iris-swarm")
  })
  test("no tmux on this computer is a measured zero; a bridge that refuses or is down is NOT measured", () => {
    expect(shellsOf(200, { sessions: [], tmux_available: false })).toEqual({ measured: true, workspaces: [] })
    expect(shellsOf(401, null).measured).toBe(false)
    expect(shellsOf(500, null).measured).toBe(false)
  })
})
