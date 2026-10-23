import { describe, expect, test } from "bun:test"
import { countChanges, irisCliPath, syncDesktopAgents } from "../../src/iris/desktop-agent-sync"

// The rule this file exists to hold: syncing agents at launch may make the picker better, and
// must never make the app fail to open. Every failure shape below is a skipped sync.
const home = "/home/u"
const fakeSpawn = (exit: number | null | "hang", seen: string[][] = []) => (cmd: string[]) => {
  seen.push(cmd)
  let killed = false
  return {
    exited: exit === "hang" ? new Promise<number | null>(() => {}) : Promise.resolve(exit),
    kill: () => { killed = true },
    get killed() { return killed },
  }
}

describe("syncDesktopAgents", () => {
  test("runs the installed CLI's desktop-sync before the engine reads config", async () => {
    const seen: string[][] = []
    const out = await syncDesktopAgents({ home, env: {}, platform: "darwin", exists: () => true, spawn: fakeSpawn(0, seen) })
    expect(out).toMatchObject({ ran: true, ok: true })
    expect(seen[0]).toEqual(["/home/u/.iris/bin/iris", "agents", "desktop-sync", "--json"])
  })

  test("no CLI installed: skipped, not an error", async () => {
    const out = await syncDesktopAgents({ home, env: {}, exists: () => false, spawn: fakeSpawn(0) })
    expect(out).toEqual({ ran: false, reason: "no-cli" })
  })

  test("a slow API cannot hold the app: it times out and the child is killed", async () => {
    let killed = false
    const out = await syncDesktopAgents({
      home, env: {}, exists: () => true, timeoutMs: 20,
      spawn: () => ({ exited: new Promise(() => {}), kill: () => { killed = true } }),
    })
    expect(out).toMatchObject({ ran: true, ok: false, reason: "timeout" })
    expect(killed).toBe(true)
  })

  test("a failing sync (logged out, offline) is reported, not thrown", async () => {
    const out = await syncDesktopAgents({ home, env: {}, exists: () => true, spawn: fakeSpawn(1) })
    expect(out).toMatchObject({ ran: true, ok: false, reason: "exit", code: 1 })
  })

  test("a spawn that throws is a skipped sync", async () => {
    const out = await syncDesktopAgents({ home, env: {}, exists: () => true, spawn: () => { throw new Error("EACCES") } })
    expect(out).toMatchObject({ ran: true, ok: false, reason: "spawn-error" })
  })

  test("IRIS_DESKTOP_AGENT_SYNC=0 turns it off", async () => {
    const out = await syncDesktopAgents({ home, env: { IRIS_DESKTOP_AGENT_SYNC: "0" }, exists: () => true, spawn: fakeSpawn(0) })
    expect(out).toEqual({ ran: false, reason: "disabled" })
  })

  test("Windows looks for iris.exe", () => {
    expect(irisCliPath("C:\\Users\\u", "win32").endsWith("iris.exe")).toBe(true)
  })
  test("reports how many files changed, so the engine reloads only when it must", async () => {
    const out = await syncDesktopAgents({
      home, env: {}, exists: () => true,
      spawn: () => ({ exited: Promise.resolve(0), kill() {}, stdout: Promise.resolve('noise\n{"written":[{},{}],"removed":["a.md"]}') }),
    })
    expect(out).toMatchObject({ ran: true, ok: true, changed: 3 })
    expect(countChanges('{"written":[],"removed":[]}')).toBe(0)
    expect(countChanges("not json")).toBe(0)
  })
})
