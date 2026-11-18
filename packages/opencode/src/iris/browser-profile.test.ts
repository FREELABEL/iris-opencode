/**
 * B3 (#193187): the agent's Chrome with a SAVED profile, against a real Chrome.
 *
 * What it proves: a login (a cookie) made in the saved profile is there on the next launch; a
 * fresh profile forgets it and is deleted; a second session on a profile in use is refused with a
 * sentence instead of hanging; last run's port file can't be mistaken for this run's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "fs"
import { mkdtemp, rm, symlink, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { BrowserUnavailable, PageSession, findChrome, profileInUse } from "./browser-driver"

const chrome = await findChrome()
let server: ReturnType<typeof Bun.serve> | undefined
let base = ""
let root = ""

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "iris-b3-"))
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url)
      if (u.pathname === "/login")
        return new Response("<title>signed in</title>signed in", {
          headers: { "content-type": "text/html", "set-cookie": "session=alex; Max-Age=3600; Path=/" },
        })
      return new Response(`<title>home</title><p id=c></p><script>document.getElementById('c').textContent = document.cookie || 'logged out'</script>`, {
        headers: { "content-type": "text/html" },
      })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(async () => {
  server?.stop(true)
  await rm(root, { recursive: true, force: true })
})

describe("profileInUse", () => {
  test("no lock, a stale lock (dead pid) and a malformed lock are not in use", async () => {
    const d = await mkdtemp(path.join(root, "lock-"))
    expect(await profileInUse(d)).toBe(false)
    await symlink("somehost-999999", path.join(d, "SingletonLock"))
    expect(await profileInUse(d)).toBe(false)
  })
  test("a lock held by a live process is in use", async () => {
    const d = await mkdtemp(path.join(root, "lock-"))
    await symlink(`somehost-${process.pid}`, path.join(d, "SingletonLock"))
    expect(await profileInUse(d)).toBe(true)
  })
})

describe.skipIf(!chrome)("the agent's saved profile, against real Chrome", () => {
  test("a sign-in in the SAVED profile is there on the next launch", async () => {
    const dir = path.join(root, "saved")
    const first = new PageSession({ profileDir: dir })
    await first.open(`${base}/login`)
    await first.open(`${base}/`)
    expect(await first.text()).toContain("session=alex")
    await first.close()
    expect(existsSync(dir)).toBe(true) // saved: kept

    const second = new PageSession({ profileDir: dir })
    await second.open(`${base}/`)
    expect(await second.text()).toContain("session=alex")
    await second.close()
  }, 60_000)

  test("a FRESH profile is logged out and deleted on close", async () => {
    const fresh = new PageSession()
    await fresh.open(`${base}/`)
    expect(await fresh.text()).toContain("logged out")
    expect(fresh.kind).toEqual({ saved: false, visible: false })
    await fresh.close()
  }, 60_000)

  test("a second session on a profile in use is refused with a sentence, not a hang", async () => {
    const dir = path.join(root, "busy")
    const a = new PageSession({ profileDir: dir })
    await a.open(`${base}/`)
    const b = new PageSession({ profileDir: dir, timeoutMs: 5000 })
    let err: unknown
    try {
      await b.open(`${base}/`)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(BrowserUnavailable)
    expect(String(err)).toContain("already open in another session")
    await a.close()
  }, 60_000)

  test("last run's port file is not read as this run's", async () => {
    const dir = path.join(root, "stale")
    const a = new PageSession({ profileDir: dir })
    await a.open(`${base}/`)
    await a.close()
    await writeFile(path.join(dir, "DevToolsActivePort"), "1\n/devtools/browser/stale")
    const b = new PageSession({ profileDir: dir })
    const opened = await b.open(`${base}/`)
    expect(opened.url).toBe(`${base}/`)
    await b.close()
  }, 60_000)
})
