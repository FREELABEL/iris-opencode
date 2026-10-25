import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AcpSession } from "../../src/acp/client"
import { listHolders, registryDir, startHolder } from "../../src/acp/holder"

const FAKE = [process.execPath, path.join(import.meta.dir, "fake-agent.ts")]

async function setup() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acp-holder-"))
  const cwd = path.join(home, "work")
  await fs.mkdir(cwd)
  await fs.writeFile(path.join(cwd, "a.txt"), "one\ntwo\n")
  let out = ""
  // No terminal: a permission request waits for answer() — the Hive path.
  const session = new AcpSession({ argv: FAKE, cwd, policy: "ask", write: (t) => (out += t) })
  await session.start()
  const holder = startHolder(session, { agent: "fake", cwd, home })
  const rec = JSON.parse(await fs.readFile(holder.file, "utf8"))
  const call = (p: string, init: RequestInit = {}, token = rec.token) =>
    fetch(`http://127.0.0.1:${holder.port}${p}`, {
      ...init,
      headers: { "content-type": "application/json", ...(token ? { "x-acp-token": token } : {}) },
    })
  const until = async (pred: () => boolean, ms = 10000) => {
    const end = Date.now() + ms
    while (!pred()) {
      if (Date.now() > end) throw new Error("timed out")
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  return { home, cwd, session, holder, rec, call, until, out: () => out }
}

describe("acp holder — a kept session reachable from Hive", () => {
  test("registers itself 0600 with the bridge's session shape", async () => {
    const { home, session, holder, rec } = await setup()
    expect(rec).toMatchObject({ session_id: "s1", provider: "acp", agent: "fake", agent_name: "Fake", status: "idle", waiting: null, pid: process.pid })
    expect((await fs.stat(holder.file)).mode & 0o777).toBe(0o600)
    expect(listHolders(home).map((r) => r.session_id)).toEqual(["s1"])
    holder.stop()
    await session.close()
    expect(listHolders(home)).toEqual([])
  }, 20000)

  test("refuses a request without the token", async () => {
    const { session, holder, call } = await setup()
    expect((await call("/status", {}, "")).status).toBe(401)
    expect((await call("/status", {}, "x".repeat(48))).status).toBe(401)
    holder.stop()
    await session.close()
  }, 20000)

  test("message → turn → waits on permission → answered remotely → file written; 409 while busy", async () => {
    const { cwd, session, holder, call, until } = await setup()
    const sent = await call("/message", { method: "POST", body: JSON.stringify({ message: "make it loud", from: "phone" }) })
    expect(sent.status).toBe(202)
    await until(() => session.status === "waiting")

    // the registry now says what it is waiting on, for `iris hive sessions --status needs_you`
    const rec = JSON.parse(await fs.readFile(holder.file, "utf8"))
    expect(rec.status).toBe("waiting")
    expect(rec.waiting.questions[0]).toMatchObject({ header: "Permission", question: "Allow Edit a.txt [edit]?" })
    expect(rec.waiting.questions[0].options.map((o: any) => o.label)).toEqual(["Allow", "Always allow", "Reject"])

    expect((await call("/message", { method: "POST", body: JSON.stringify({ message: "again" }) })).status).toBe(409)
    const bad = await call("/answer", { method: "POST", body: JSON.stringify({ answers: ["maybe"] }) })
    expect(bad.status).toBe(400)
    expect(session.status).toBe("waiting") // an unrecognised answer is never read as allow

    const ok = await call("/answer", { method: "POST", body: JSON.stringify({ answers: ["1"] }) })
    expect(await ok.json()).toMatchObject({ status: "delivered", answers: { Permission: "Allow" } })
    await until(() => session.status === "idle")
    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("ONE\ntwo\n")

    const hist = (await (await call("/history?limit=10")).json()) as any
    expect(hist.messages[0]).toMatchObject({ role: "user", type: "text", text: "[via iris · phone] make it loud" })
    expect(hist.messages.some((m: any) => m.role === "assistant" && m.type === "text" && m.text.includes("you said"))).toBe(true)
    expect(hist.messages.some((m: any) => m.type === "tool_use" && m.text === "Edit a.txt")).toBe(true)

    expect((await call("/answer", { method: "POST", body: JSON.stringify({ answers: ["1"] }) })).status).toBe(409)
    holder.stop()
    await session.close()
  }, 20000)

  test("a reject answer leaves the file alone", async () => {
    const { cwd, session, holder, call, until } = await setup()
    await call("/message", { method: "POST", body: JSON.stringify({ message: "x" }) })
    await until(() => session.status === "waiting")
    expect((await call("/answer", { method: "POST", body: JSON.stringify({ answers: ["Reject"] }) })).status).toBe(200)
    await until(() => session.status === "idle")
    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("one\ntwo\n")
    holder.stop()
    await session.close()
  }, 20000)

  test("a record whose process is gone is pruned, not listed", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "acp-holder-"))
    await fs.mkdir(registryDir(home), { recursive: true })
    await fs.writeFile(path.join(registryDir(home), "dead.json"), JSON.stringify({ session_id: "dead", pid: 999999 }))
    expect(listHolders(home, () => false)).toEqual([])
    expect(await fs.exists(path.join(registryDir(home), "dead.json"))).toBe(false)
  })
})
