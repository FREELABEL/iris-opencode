import { describe, expect, test } from "bun:test"
import { parentFromEnv, processAlive, watchParent } from "../../src/iris/parent-watch"

describe("the engine follows its app (#193427)", () => {
  test("only an engine the app started watches: IRIS_APP_PID must be a real pid", () => {
    expect(parentFromEnv({})).toBeUndefined()
    expect(parentFromEnv({ IRIS_APP_PID: "" })).toBeUndefined()
    expect(parentFromEnv({ IRIS_APP_PID: "1" })).toBeUndefined() // launchd: never "the app"
    expect(parentFromEnv({ IRIS_APP_PID: "abc" })).toBeUndefined()
    expect(parentFromEnv({ IRIS_APP_PID: "4242" })).toBe(4242)
  })

  test("calls onGone once, at the first check after the app is gone", async () => {
    let alive = true
    let gone = 0
    watchParent({ pid: 4242, intervalMs: 10, alive: () => alive, onGone: () => gone++ })
    await Bun.sleep(40)
    expect(gone).toBe(0)
    alive = false
    await Bun.sleep(40)
    expect(gone).toBe(1)
    await Bun.sleep(40)
    expect(gone).toBe(1)
  })

  test("stop() ends the watch", async () => {
    let gone = 0
    const stop = watchParent({ pid: 4242, intervalMs: 10, alive: () => false, onGone: () => gone++ })
    stop()
    await Bun.sleep(40)
    expect(gone).toBe(0)
  })

  test("a real process: alive while it runs, gone once it is killed", async () => {
    const p = Bun.spawn(["sleep", "30"])
    expect(processAlive(p.pid)).toBeTrue()
    p.kill("SIGKILL")
    await p.exited
    expect(processAlive(p.pid)).toBeFalse()
    expect(processAlive(process.pid)).toBeTrue()
  })

  test("end to end: a child watching a killed parent exits by itself", async () => {
    const parent = Bun.spawn(["sleep", "30"])
    const script = `
      const { watchParent } = await import(${JSON.stringify(require.resolve("../../src/iris/parent-watch"))})
      watchParent({ pid: ${parent.pid}, intervalMs: 50, onGone: () => process.exit(7) })
      setInterval(() => {}, 1000)
    `
    const child = Bun.spawn([process.execPath, "-e", script])
    await Bun.sleep(300)
    expect(child.exitCode).toBeNull()
    parent.kill("SIGKILL")
    const code = await Promise.race([child.exited, Bun.sleep(3000).then(() => "timeout")])
    if (code === "timeout") child.kill("SIGKILL")
    expect(code).toBe(7)
  })
})
