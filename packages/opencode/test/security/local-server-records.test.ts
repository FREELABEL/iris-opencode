// #192113: the rules for a published server record, matched to iris-daemon's reader (lib/engine-auth.js),
// and the rule that this machine's secrets stay on this machine unless --password says otherwise.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { LocalAuth } from "../../src/server/local-auth"
import { basic, childEnv, freePort, spawnIris, tempHome, waitForPort } from "./harness"

const publish = (port: number) =>
  LocalAuth.writeRecord({ port, hostname: "127.0.0.1", credentials: { username: "opencode", password: "fake-new" } })

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "iris-records-"))
const realHomedir = os.homedir
const servers = path.join(scratch, ".iris", "servers")
const body = (port: number, fields: Record<string, unknown> = { pid: process.pid }) =>
  JSON.stringify({ version: 1, port, username: "opencode", password: "fake-record-password", ...fields })
const put = (port: number, fields?: Record<string, unknown>) =>
  fs.writeFileSync(path.join(servers, `${port}.json`), body(port, fields), { mode: 0o600 })
// A server opens its socket, then writes its record and sweeps: the port being up does not mean that happened.
async function until(condition: () => boolean, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs
  while (!condition() && Date.now() < end) await Bun.sleep(50)
  return condition()
}
const read = (port: number) => LocalAuth.credentialsFor(`http://127.0.0.1:${port}`, {})

beforeAll(() => {
  ;(os as any).homedir = () => scratch
  fs.mkdirSync(servers, { recursive: true, mode: 0o700 })
})
afterAll(() => {
  ;(os as any).homedir = realHomedir
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe("a credential stays on this machine", () => {
  const env = { OPENCODE_SERVER_PASSWORD: "fake-env", OPENCODE_SERVER_USERNAME: "fake-user" }

  for (const url of [
    "http://evil.example:4096",
    "https://evil.example",
    "http://10.0.0.5:4096",
    "http://127.0.0.1.evil.example:4096",
    "http://127.0.0.1@evil.example:4096",
    "http://[::ffff:127.0.0.1]:4096",
    "not a url",
  ]) {
    test(`the environment's password is not sent to ${url}`, () => {
      expect(LocalAuth.credentialsFor(url, env)).toBeUndefined()
      expect(LocalAuth.headersFor(url, undefined, env)).toBeUndefined()
    })
  }

  for (const url of ["http://127.0.0.1:4096", "http://localhost:4096", "http://[::1]:4096", "http://127.5.5.5:4096"]) {
    test(`the environment's password is sent to ${url}`, () => {
      expect(LocalAuth.credentialsFor(url, env)).toEqual({ username: "fake-user", password: "fake-env" })
    })
  }

  test("as iris-daemon: https or a URL carrying userinfo gets neither the environment nor a record", () => {
    put(41301)
    expect(read(41301)?.password).toBe("fake-record-password")
    for (const url of ["https://127.0.0.1:41301", "http://someone:secret@127.0.0.1:41301"]) {
      expect(LocalAuth.credentialsFor(url, env)).toBeUndefined()
      expect(LocalAuth.credentialsFor(url, {})).toBeUndefined()
    }
  })

  test("--password is the one way to send a secret to another machine", () => {
    expect(LocalAuth.headersFor("http://evil.example:4096", { password: "fake-flag" }, env)?.Authorization).toBe(
      basic("fake-flag", "fake-user"),
    )
    expect(LocalAuth.headersFor("http://evil.example:4096", { password: "fake-flag", username: "me" }, {})?.Authorization).toBe(
      basic("fake-flag", "me"),
    )
  })
})

describe("a record's pid", () => {
  test("a live one is accepted", () => {
    put(41311)
    expect(read(41311)).toEqual({ username: "opencode", password: "fake-record-password" })
  })

  for (const [name, fields] of [
    ["missing", {}],
    ["zero", { pid: 0 }],
    ["negative", { pid: -1 }],
    ["fractional", { pid: 1.5 }],
    ["a string", { pid: String(process.pid) }],
    ["null", { pid: null }],
    ["dead", { pid: 2 ** 22 + 7 }],
  ] as const) {
    test(`${name} is refused, for a server's record and for Desktop's`, () => {
      put(41312, fields)
      expect(read(41312)).toBeUndefined()
      fs.writeFileSync(path.join(scratch, ".iris", "desktop-engine.json"), body(41313, fields), { mode: 0o600 })
      expect(read(41313)).toBeUndefined()
    })
  }

  test("an empty password is no password", () => {
    put(41314, { pid: process.pid, password: "" })
    expect(read(41314)).toBeUndefined()
  })
})

describe("a record that is not a real file", () => {
  const outside = path.join(scratch, "elsewhere.json")

  test("a symlink to a file that would pass every other check is refused", () => {
    if (process.platform === "win32") return
    fs.writeFileSync(outside, body(41321), { mode: 0o600 })
    fs.symlinkSync(outside, path.join(servers, "41321.json"))
    expect(read(41321)).toBeUndefined()
    // The same bytes as a real file are fine, so it is the link being refused.
    fs.writeFileSync(path.join(servers, "41322.json"), body(41322), { mode: 0o600 })
    expect(read(41322)?.password).toBe("fake-record-password")
  })

  test("a symlink is refused for Desktop's record too", () => {
    if (process.platform === "win32") return
    const desktop = path.join(scratch, ".iris", "desktop-engine.json")
    fs.rmSync(desktop, { force: true })
    fs.writeFileSync(outside, body(41323), { mode: 0o600 })
    fs.symlinkSync(outside, desktop)
    expect(read(41323)).toBeUndefined()
    fs.rmSync(desktop, { force: true })
  })

  // In a child, because a reader that opens a FIFO blocks until somebody writes to it.
  test("a FIFO is refused without hanging", async () => {
    if (process.platform === "win32") return
    const h = tempHome()
    try {
      const dir = path.join(h.root, ".iris", "servers")
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      expect(Bun.spawnSync(["mkfifo", "-m", "600", path.join(dir, "41325.json")]).success).toBe(true)
      const source = path.join(import.meta.dir, "..", "..", "src", "server", "local-auth.ts")
      const child = Bun.spawn(
        ["bun", "--no-install", "--conditions=browser", "-e",
          `const { LocalAuth } = await import(${JSON.stringify(source)}); console.log("answer", LocalAuth.credentialsFor("http://127.0.0.1:41325", {}))`],
        { cwd: path.join(import.meta.dir, "..", ".."), env: childEnv(h.root), stdout: "pipe", stderr: "ignore" },
      )
      const killer = setTimeout(() => child.kill("SIGKILL"), 30_000)
      const out = await new Response(child.stdout).text()
      clearTimeout(killer)
      expect(out).toContain("answer undefined")
    } finally {
      h.cleanup()
    }
  }, 60_000)

  test("a directory is refused", () => {
    fs.mkdirSync(path.join(servers, "41324.json"))
    expect(read(41324)).toBeUndefined()
  })
})

describe("the sweep when a server starts", () => {
  test("removes a dead pid's record and one naming no process; keeps the living and what it may not judge", () => {
    put(41331, { pid: 2 ** 22 + 7 })
    put(41332, {})
    put(41333, { pid: 0 })
    put(41334, { pid: process.pid })
    fs.writeFileSync(path.join(servers, "41335.json"), body(41335, { pid: 2 ** 22 + 7 }), { mode: 0o644 })
    const target = path.join(scratch, "linked.json")
    fs.writeFileSync(target, body(41336, { pid: 2 ** 22 + 7 }), { mode: 0o600 })
    if (process.platform !== "win32") fs.symlinkSync(target, path.join(servers, "41336.json"))
    fs.writeFileSync(path.join(servers, "not-a-record.json"), "{}", { mode: 0o600 })

    publish(41339)

    const left = fs.readdirSync(servers)
    for (const gone of ["41331.json", "41332.json", "41333.json"]) expect(left).not.toContain(gone)
    for (const kept of ["41334.json", "41335.json", "not-a-record.json", "41339.json"]) expect(left).toContain(kept)
    if (process.platform !== "win32") {
      expect(fs.lstatSync(path.join(servers, "41336.json")).isSymbolicLink()).toBe(true)
      expect(fs.existsSync(target)).toBe(true)
    }
  })
})

// Real child processes. Nothing but a stub on a free port ever hears from them.
describe("the commands", () => {
  const home = tempHome()
  const seen: (string | null)[] = []
  // ::ffff:127.0.0.1 is this machine, so the test can listen there, but it is not a loopback name.
  const stub = Bun.serve({
    port: 0,
    hostname: "::",
    fetch(req) {
      seen.push(req.headers.get("authorization"))
      return new Response("{}", { status: 401 })
    },
  })
  const notLoopback = `http://[::ffff:127.0.0.1]:${stub.port}`
  afterAll(() => {
    stub.stop(true)
    home.cleanup()
  })

  async function iris(args: string[], env: Record<string, string>) {
    seen.length = 0
    const child = spawnIris(args, { cwd: home.project, env: childEnv(home.root, env) })
    const killer = setTimeout(() => child.kill(), 50_000)
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const code = await child.exited
    clearTimeout(killer)
    return { output: stdout + stderr, code }
  }

  const fakeEnv = { OPENCODE_SERVER_PASSWORD: "fake-env" }

  for (const [name, command] of [
    ["run --attach", (url: string) => ["run", "--attach", url, "hello"]],
    ["attach", (url: string) => ["attach", url]],
  ] as const) {
    test(`${name}: the environment's password does not leave the machine, and says what to do`, async () => {
      const out = await iris(command(notLoopback), fakeEnv)
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((h) => h === null)).toBe(true)
      expect(out.code).toBe(1)
      expect(out.output).toContain("--password")
    }, 60_000)

    test(`${name}: --password does`, async () => {
      await iris([...command(notLoopback), "--password", "fake-flag"], fakeEnv)
      expect(seen).toContain(basic("fake-flag"))
    }, 60_000)

    test(`${name}: on this machine the environment's password is sent`, async () => {
      await iris(command(`http://127.0.0.1:${stub.port}`), fakeEnv)
      expect(seen).toContain(basic("fake-env"))
    }, 60_000)
  }
})

describe("a server with a password somebody chose", () => {
  test("publishes it owner-only, with its username, for clients that are the same person", async () => {
    const h = tempHome()
    const port = await freePort()
    const child = spawnIris(["serve", "--port", String(port)], {
      cwd: h.project,
      env: childEnv(h.root, { OPENCODE_SERVER_PASSWORD: "fake-chosen", OPENCODE_SERVER_USERNAME: "fake-user" }),
    })
    try {
      await waitForPort(port)
      const file = path.join(h.root, ".iris", "servers", `${port}.json`)
      expect(await until(() => fs.existsSync(file))).toBe(true)
      const record = JSON.parse(fs.readFileSync(file, "utf8"))
      expect(record).toMatchObject({ port, username: "fake-user", password: "fake-chosen", pid: child.pid })
      if (process.platform !== "win32") {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600)
        expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
      }
      const res = await fetch(`http://127.0.0.1:${port}/session`, {
        headers: { authorization: basic("fake-chosen", "fake-user"), "x-opencode-directory": h.project },
      })
      expect(res.status).toBe(200)
    } finally {
      child.kill()
      h.cleanup()
    }
  }, 120_000)
})

describe("kill -9", () => {
  test("leaves a record no client will use, and the next server to start removes it", async () => {
    const h = tempHome()
    const [first, second] = [await freePort(), await freePort()]
    const stale = path.join(h.root, ".iris", "servers", `${first}.json`)
    const a = spawnIris(["serve", "--port", String(first)], { cwd: h.project, env: childEnv(h.root) })
    let b: ReturnType<typeof spawnIris> | undefined
    try {
      await waitForPort(first)
      expect(await until(() => fs.existsSync(stale))).toBe(true)
      a.kill("SIGKILL")
      await a.exited
      expect(fs.existsSync(stale)).toBe(true)
      b = spawnIris(["serve", "--port", String(second)], { cwd: h.project, env: childEnv(h.root) })
      await waitForPort(second)
      const fresh = path.join(h.root, ".iris", "servers", `${second}.json`)
      expect(await until(() => fs.existsSync(fresh))).toBe(true)
      expect(await until(() => !fs.existsSync(stale))).toBe(true)
    } finally {
      a.kill()
      b?.kill()
      h.cleanup()
    }
  }, 180_000)
})
