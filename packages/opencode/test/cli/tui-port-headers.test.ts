import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

// #192113: the worker makes the token for `iris --port`, so the main thread must take its headers
// from the worker. Asking for a session that doesn't exist reaches the server before any UI starts.
test("iris --port authenticates to its own server", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tui-port-"))
  const port = 40000 + Math.floor(Math.random() * 20000)
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    OPENCODE_TEST_HOME: root,
    XDG_DATA_HOME: path.join(root, "share"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    IRIS_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
  }
  const proc = Bun.spawn(
    ["bun", `--preload=${Bun.resolveSync("@opentui/solid/preload", path.join(import.meta.dir, "../.."))}`, "run", "--conditions=browser", path.join(import.meta.dir, "../../src/index.ts"), "--port", String(port), "--hostname", "127.0.0.1", "--session", "ses_doesnotexist"],
    { cwd: root, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  )
  const timer = setTimeout(() => proc.kill(9), 60_000)
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  clearTimeout(timer)
  await proc.exited
  await fs.rm(root, { recursive: true, force: true })
  const text = out + err
  expect(text).not.toMatch(/401|Unauthorized/i)
  expect(text).toMatch(/not found/i)
}, 90_000)
