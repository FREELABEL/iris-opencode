/**
 * A dependency-free Chrome client, so an edge export can verify itself anywhere the CLI runs.
 *
 * WHY NOT PLAYWRIGHT. Harvest and verify need a browser — they caught every failure that mattered
 * (the torn snapshot, the missing chunk, the unpredicted host). But the IRIS CLI ships no browser
 * dependency, and `genesis screenshot` already shows the cost of one: it is wrapped in a try/catch
 * that tells you to `npm install playwright`. Bun and Node both have WebSocket and fetch built in,
 * and Chrome speaks CDP over both, so this needs nothing installed.
 *
 * The launch discipline is copied from the house render-check script deliberately: a THROWAWAY
 * headless Chrome with an empty profile and an ephemeral port, torn down afterwards. It never
 * attaches to the user's Chrome, so no logged-in session is ever in reach of a page we are
 * exporting for a client.
 */
import { spawn } from "child_process"
import { mkdtempSync, rmSync, accessSync, constants } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import net from "net"

const CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
]

export function findChrome(): string | null {
  if (process.env["CHROME_BIN"]) return process.env["CHROME_BIN"]!
  for (const c of CANDIDATES) {
    try {
      if (c.startsWith("/")) {
        accessSync(c, constants.X_OK)
        return c
      }
    } catch {
      /* next */
    }
  }
  return CANDIDATES.find((c) => !c.startsWith("/")) ?? null
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
    s.on("error", reject)
  })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface Page {
  send(method: string, params?: Record<string, unknown>): Promise<any>
  on(fn: (method: string, params: any) => void): void
  close(): void
}

export interface Session {
  base: string
  close(): Promise<void>
  newPage(): Promise<Page>
}

/** Launch a throwaway Chrome, bound to nothing the user is logged into. */
export async function launch({ timeout = 20000 }: { timeout?: number } = {}): Promise<Session> {
  const bin = findChrome()
  if (!bin) throw new Error("no Chrome/Chromium found — set CHROME_BIN")

  const port = await freePort()
  const profile = mkdtempSync(join(tmpdir(), "iris-edge-chrome-"))
  const args = [
    "--headless=new",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--metrics-recording-only",
    "--mute-audio",
    "--hide-scrollbars",
    "about:blank",
  ]
  const proc = spawn(bin, args, { stdio: "ignore", detached: false })

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + timeout
  let version: unknown = null
  while (Date.now() < deadline) {
    try {
      version = await (await fetch(`${base}/json/version`)).json()
      break
    } catch {
      await sleep(120)
    }
  }
  if (!version) {
    proc.kill("SIGKILL")
    rmSync(profile, { recursive: true, force: true })
    throw new Error(`headless Chrome did not open a debugging port on ${port}`)
  }

  const close = async () => {
    try {
      proc.kill("SIGTERM")
    } catch {
      /* already gone */
    }
    await sleep(120)
    try {
      proc.kill("SIGKILL")
    } catch {
      /* already gone */
    }
    rmSync(profile, { recursive: true, force: true })
  }

  return { base, close, newPage: () => newPage(base) }
}

async function newPage(base: string): Promise<Page> {
  // Chrome moved /json/new to PUT; try it first and fall back for older builds.
  let target: any
  for (const method of ["PUT", "GET"]) {
    try {
      const res = await fetch(`${base}/json/new?about:blank`, { method })
      if (res.ok) {
        target = await res.json()
        break
      }
    } catch {
      /* try the other verb */
    }
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("could not open a tab over CDP")

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true })
  })

  let id = 0
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  const listeners: ((method: string, params: any) => void)[] = []
  ws.addEventListener("message", (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data))
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id)!
      pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(msg.error.message))
      else entry.resolve(msg.result)
    } else if (msg.method) {
      for (const fn of listeners) fn(msg.method, msg.params)
    }
  })

  // CLEAR THE TIMER, and unref it. A pending setTimeout holds the event loop open, so leaving one
  // per command meant every tool that used CDP did its work in ~2s and then sat there for a full 60
  // before the process would exit. Nothing failed and nothing logged — an export of a six-asset
  // fixture took two minutes, which reads as "Chrome is slow" instead of a leaked timer.
  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const mid = ++id
      const timer = setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid)
          reject(new Error(`${method} timed out`))
        }
      }, 60000)
      timer.unref?.()
      const settle =
        <T,>(fn: (v: T) => void) =>
        (v: T) => {
          clearTimeout(timer)
          fn(v)
        }
      pending.set(mid, { resolve: settle(resolve), reject: settle(reject) })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })

  const on = (fn: (method: string, params: any) => void) => {
    listeners.push(fn)
  }

  await send("Page.enable")
  await send("Network.enable")
  await send("Runtime.enable")

  return { send, on, close: () => ws.close() }
}

export interface Inspection {
  value: any
  requests: string[]
  failures: string[]
  errors: string[]
}

/**
 * Load a url and report what happened: requests, failures, and whatever the evaluator returns.
 *
 * `blockHosts` aborts matching requests at the browser — the only honest way to prove a page is
 * independent, because "no request was made" cannot distinguish independence from a page that had
 * not needed the network yet.
 */
export async function inspect(
  session: Session,
  url: string,
  {
    evaluate = 'return document.body ? document.body.innerText : ""',
    blockHosts = null,
    viewport = { width: 1440, height: 900 },
    settle = 1200,
  }: {
    evaluate?: string
    blockHosts?: ((u: string) => boolean) | null
    viewport?: { width: number; height: number } | null
    settle?: number
  } = {},
): Promise<Inspection> {
  const page = await session.newPage()
  const requests: string[] = []
  const failures: string[] = []
  const errors: string[] = []

  page.on((method, params) => {
    if (method === "Network.requestWillBeSent") requests.push(params.request.url)
    if (method === "Network.responseReceived" && params.response.status >= 400) {
      failures.push(`${params.response.status} ${params.response.url}`)
    }
    if (method === "Network.loadingFailed" && !params.canceled) {
      failures.push(`failed ${params.errorText}`)
    }
    if (method === "Runtime.exceptionThrown") {
      errors.push(
        String(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || "").slice(0, 160),
      )
    }
  })

  if (viewport) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    })
  }

  if (blockHosts) {
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] })
    page.on(async (method, params) => {
      if (method !== "Fetch.requestPaused") return
      const blocked = blockHosts(params.request.url)
      try {
        await page.send(
          blocked ? "Fetch.failRequest" : "Fetch.continueRequest",
          blocked ? { requestId: params.requestId, errorReason: "BlockedByClient" } : { requestId: params.requestId },
        )
      } catch {
        /* the tab may have moved on */
      }
    })
  }

  // ARM THE LISTENER BEFORE NAVIGATING. Attaching it after Page.navigate is a race that a local
  // static host wins routinely: the load event fires before the listener exists, nothing resolves,
  // and the 45s ceiling becomes the actual duration.
  const loaded = new Promise<void>((resolve) => {
    let done = false
    const ceiling = setTimeout(() => finish(), 45000)
    ceiling.unref?.()
    function finish() {
      if (!done) {
        done = true
        clearTimeout(ceiling)
        resolve()
      }
    }
    page.on((method) => {
      if (method === "Page.loadEventFired") setTimeout(finish, settle)
    })
  })
  await page.send("Page.navigate", { url })
  await loaded

  const { result } = await page.send("Runtime.evaluate", {
    expression: `(() => { ${evaluate} })()`,
    returnByValue: true,
    awaitPromise: true,
  })

  page.close()
  return { value: result?.value, requests, failures, errors }
}
