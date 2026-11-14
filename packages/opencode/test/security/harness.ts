// Starts real `iris` child processes against a temp HOME, on free ports, with fake data only.
// Never touches a server already running on this machine: every port comes from bind(0) and every
// child is killed by the PID this file spawned.
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const ENTRY = path.join(import.meta.dir, "..", "..", "src", "index.ts")
const PRELOAD = Bun.resolveSync("@opentui/solid/preload", path.join(import.meta.dir, "..", ".."))

export const CANARY = "000-12-3456" // a fake SSN; the canary a tool call must not carry out

export async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const s = net.createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

export function tempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-security-"))
  const project = path.join(root, "project")
  fs.mkdirSync(project, { recursive: true })
  // The same seed test/preload.ts writes: no models.dev fetch, and the source tree has no macro data.
  const cache = path.join(root, "cache", "opencode")
  fs.mkdirSync(cache, { recursive: true })
  fs.writeFileSync(path.join(cache, "version"), "14")
  fs.writeFileSync(
    path.join(cache, "models.json"),
    JSON.stringify({ opencode: { id: "opencode", name: "OpenCode", env: [], npm: "@ai-sdk/openai-compatible", models: {} } }),
  )
  return { root, project, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

export function childEnv(root: string, extra: Record<string, string | undefined> = {}) {
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
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_REMOTE_PROMPTS: "true",
    OPENCODE_DISABLE_REMOTE_CAPABILITIES: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    BROWSER: "true",
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return env
}

export function spawnIris(args: string[], opts: { cwd: string; env: Record<string, string> }) {
  // The child runs in the temp project, where bun would neither find the package's bunfig preload
  // nor any node_modules (and would try to auto-install from the network): name the preload, and
  // forbid installing.
  return Bun.spawn(["bun", "--no-install", `--preload=${PRELOAD}`, "run", "--conditions=browser", ENTRY, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
}

export async function waitForPort(port: number, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const up = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, "127.0.0.1")
      s.once("connect", () => (s.destroy(), resolve(true)))
      s.once("error", () => resolve(false))
    })
    if (up) return
    await Bun.sleep(100)
  }
  throw new Error(`nothing listening on ${port} after ${timeoutMs}ms`)
}

/** Raw HTTP so the Host header can be forged; fetch() would overwrite it. */
export function rawGet(port: number, target: string, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: string; body: string }>((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1")
    let data = ""
    let idle: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      clearTimeout(idle)
      s.destroy()
      const at = data.indexOf("\r\n\r\n")
      const head = at === -1 ? data : data.slice(0, at)
      resolve({ status: Number(head.split(" ")[1] ?? 0), headers: head, body: at === -1 ? "" : data.slice(at + 4) })
    }
    s.setEncoding("utf8")
    s.on("data", (d) => {
      data += d
      // The answer's headers are what the tests judge; do not wait for a keep-alive socket to close.
      clearTimeout(idle)
      idle = setTimeout(finish, 250)
    })
    s.on("error", reject)
    s.on("close", finish)
    const lines = [`GET ${target} HTTP/1.1`, "Connection: close", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)]
    s.write(lines.join("\r\n") + "\r\n\r\n")
  })
}

export function basic(password: string, username = "opencode") {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

/**
 * A stand-in model on loopback. Its first tool-capable turn asks for `tool`; after that it answers
 * with plain text. Records every request so a test can see whether a second turn happened.
 */
export function stubModel(toolCall: { name: string; args: Record<string, unknown> }) {
  let called = false
  const requests: any[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.endsWith("/chat/completions")) return Response.json({ data: [] })
      const body = (await req.json()) as any
      requests.push(body)
      const offered = (body.tools ?? []).some((t: any) => t.function?.name === toolCall.name)
      const chunks: any[] = []
      const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model: "stub" }
      if (offered && !called) {
        called = true
        chunks.push({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_stub_1",
                    type: "function",
                    function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })
        chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
      } else {
        chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "stub done" }, finish_reason: null }] })
        chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
      }
      const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"
      return new Response(sse, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { server, requests, url: `http://127.0.0.1:${server.port}/v1` }
}

/** The "attacker's" server. Anything that reaches it has left the machine, as far as a test cares. */
export function canaryServer() {
  const hits: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      hits.push(req.url)
      return new Response("ok")
    },
  })
  return { server, hits, url: `http://127.0.0.1:${server.port}` }
}

export function localProjectConfig(project: string, modelUrl: string, extra: Record<string, unknown> = {}) {
  fs.writeFileSync(
    path.join(project, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local stub",
          options: { baseURL: modelUrl, apiKey: "not-a-real-key" },
          models: { stub: { name: "Stub", tool_call: true } },
        },
      },
      model: "local/stub",
      ...extra,
    }),
  )
}
