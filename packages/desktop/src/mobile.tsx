// The iPhone entry (#194511). iOS will not run the engine sidecar, so the phone is the same
// interface pointed at the engine on one of the person's own machines.
//
//   sign in (email code) ─▶ your machines (Hive) ─▶ tap one ─▶ a token the platform signed for that
//   machine ─▶ https://<tunnel>.t.heyiris.io ─▶ that machine's daemon ─▶ its IRIS Desktop engine
//
// The contract is ADR-03 on #194511. "Enter an address" stays as a fallback for an engine reached
// some other way (Tailscale, a LAN): an address plus that engine's own password.
import "@opencode-ai/app/polyfills"
import { render } from "solid-js/web"
import { createSignal, For, Show, type JSX } from "solid-js"
import type { Platform, ServerConnection } from "@opencode-ai/app"
import { basicAuthorization, engineOrigins, withEngineAuth } from "@opencode-ai/app/engine-auth"
import { fetch } from "@tauri-apps/plugin-http"
import { openUrl } from "@tauri-apps/plugin-opener"
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"
import pkg from "../package.json"

// Platform calls go through the native HTTP plugin (`fetch` above), so no CORS rule on either
// host can block sign-in. Calls to an engine use the webview's own fetch (`globalThis.fetch`),
// because that is what the interface uses afterwards: testing reachability any other way would
// pass a check the app then fails.
const AUTH_API = "https://raichu.heyiris.io"
const HIVE_API = "https://freelabel.net"
// The same public endpoint IRIS Desktop's onboarding events go to (src-tauri/src/onboarding.rs).
const EVENTS_API = "https://heyiris.io/api/v1/genesis/events"
const VISITOR_KEY = "iris.mobile.visitor"

// localStorage, not the Keychain: the Keychain (behind Face ID) is step 5 of the epic.
const ACCOUNT_KEY = "iris.mobile.account"
const MACHINE_KEY = "iris.mobile.machine"

type Account = { token: string; userId: number; email: string }
// A Hive machine is remembered by id; its address and token are asked for on every launch.
type Choice = { kind: "hive"; nodeId: string; name: string } | { kind: "address"; url: string; password: string }
type Engine = { url: string; username: string; password: string; expiresAt?: number }
type Node = {
  id: string
  name: string
  connection_status: string
  last_heartbeat_at?: string | null
  phone?: { enabled?: boolean; url?: string; engine?: string } | null
}

const root = document.getElementById("root")!

const platform: Platform = {
  platform: "web",
  version: pkg.version,
  openExternal: (value) => {
    if (!URL.canParse(value)) return
    const url = new URL(value)
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return
    void openUrl(url.href)
  },
  restart: async () => location.reload(),
  notify: async (title, description) => {
    const granted = (await isPermissionGranted()) || (await requestPermission()) === "granted"
    if (!granted || document.visibilityState === "visible") return
    sendNotification({ title, body: description ?? "" })
  },
}

async function start() {
  track("iphone.launch")
  const choice = read<Choice>(MACHINE_KEY)
  const account = read<Account>(ACCOUNT_KEY)
  if (choice?.kind === "address") return openEngine({ url: choice.url, username: "opencode", password: choice.password }, () => showAddress(choice))
  if (!account) return showSignIn()
  if (!choice) return showMachines(account)
  const engine = await engineFor(account, choice.nodeId).catch((e: Error) => e)
  if (engine instanceof Error) return showMachines(account, `${choice.name}: ${engine.message}`)
  return openEngine(engine, () => showMachines(account))
}

/** Reach the engine, then hand the screen to the interface. On failure, `back` shows why. */
async function openEngine(engine: Engine, back: (problem: string) => void) {
  const problem = await reach(engine)
  if (problem) return back(problem)
  // A machine token lasts 12 hours; come back through start() for a fresh one before it runs out.
  if (engine.expiresAt) setTimeout(() => location.reload(), Math.max(60_000, engine.expiresAt - Date.now() - 5 * 60_000))
  await showApp(engine)
}

// The interface (2+ MB) loads only once a machine answers, so the first screens never wait on it.
async function showApp(engine: Engine) {
  const { AppBaseProviders, AppInterface, PlatformProvider, ServerConnection } = await import("@opencode-ai/app")
  const url = new URL(engine.url)
  // The IRIS panels call /iris with a bare fetch, as in the desktop window (engine-auth.ts).
  globalThis.fetch = withEngineAuth(
    globalThis.fetch.bind(globalThis),
    engineOrigins(Number(url.port)).add(url.origin),
    basicAuthorization({ username: engine.username, password: engine.password }),
  )
  const server: ServerConnection.Http = {
    type: "http",
    authToken: true,
    http: { url: url.origin, username: engine.username, password: engine.password },
  }
  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          <AppInterface defaultServer={ServerConnection.key(server)} servers={[server]} />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}

function showSignIn(problem?: string) {
  const [email, setEmail] = createSignal("")
  const [code, setCode] = createSignal("")
  const [sent, setSent] = createSignal(false)
  const [error, setError] = createSignal(problem ?? "")
  const [busy, setBusy] = createSignal(false)

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    setError("")
    setBusy(true)
    const step = sent() ? "verify" : "send_code"
    if (step === "send_code") track("iphone.signin.code_requested")
    const result = await (sent() ? verify(email(), code()) : sendCode(email())).catch((e: Error) => e)
    setBusy(false)
    if (result instanceof Error) return (track("iphone.signin.failed", `${step}: ${result.message}`), setError(result.message))
    if (!sent()) return (track("iphone.signin.code_sent"), setSent(true))
    track("iphone.signin.verified")
    location.reload()
  }

  render(
    () => (
      <Screen>
        <form style={styles.card} onSubmit={submit}>
          <img src="/favicon.svg" alt="" width="44" height="44" />
          <h1 style={styles.title}>Sign in to IRIS</h1>
          <p style={styles.lead}>
            {sent() ? `We emailed a 6-digit code to ${email().trim()}.` : "Use the email you sign in to IRIS Desktop with."}
          </p>
          <Show
            when={sent()}
            fallback={
              <input
                style={styles.input}
                type="email"
                inputmode="email"
                autocomplete="email"
                autocapitalize="off"
                placeholder="you@example.com"
                value={email()}
                onInput={(e) => setEmail(e.currentTarget.value)}
                required
              />
            }
          >
            <input
              style={`${styles.input};letter-spacing:.3em;text-align:center`}
              inputmode="numeric"
              autocomplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value.replace(/\D/g, ""))}
              required
            />
          </Show>
          <Show when={error()}>
            <p style={styles.error}>{error()}</p>
          </Show>
          <button style={styles.button} type="submit" disabled={busy()}>
            {busy() ? "One moment…" : sent() ? "Sign in" : "Email me a code"}
          </button>
          <Show when={sent()}>
            <button style={styles.link} type="button" onClick={() => (setSent(false), setCode(""))}>
              Use a different email
            </button>
          </Show>
          <button style={styles.link} type="button" onClick={() => showAddress()}>
            Connect by address instead
          </button>
        </form>
      </Screen>
    ),
    root,
  )
}

function showMachines(account: Account, problem?: string) {
  const [nodes, setNodes] = createSignal<Node[]>()
  const [error, setError] = createSignal(problem ?? "")
  const [busy, setBusy] = createSignal("")

  const load = () =>
    listMachines(account)
      .then((list) => {
        track("iphone.machines.loaded", `${list.length} machines, ${list.filter((n) => n.connection_status === "online" && n.phone?.enabled).length} ready`)
        setNodes(list)
      })
      .catch((e: Error) => (track("iphone.machines.failed", e.message), setError(e.message)))
  void load()

  const choose = async (node: Node) => {
    setError("")
    setBusy(node.id)
    const engine = await engineFor(account, node.id).catch((e: Error) => e)
    if (engine instanceof Error) return (track("iphone.connect.failed", `token: ${engine.message}`), setBusy(""), setError(`${node.name}: ${engine.message}`))
    const problem = await reach(engine)
    setBusy("")
    if (problem) return (track("iphone.connect.failed", `reach: ${problem}`), setError(`${node.name}: ${problem}`))
    track("iphone.connect.ok")
    localStorage.setItem(MACHINE_KEY, JSON.stringify({ kind: "hive", nodeId: node.id, name: node.name } satisfies Choice))
    location.reload()
  }

  const signOut = () => {
    localStorage.removeItem(ACCOUNT_KEY)
    localStorage.removeItem(MACHINE_KEY)
    location.reload()
  }

  render(
    () => (
      <Screen>
        <div style={styles.card}>
          <h1 style={styles.title}>Your machines</h1>
          <p style={styles.lead}>Signed in as {account.email}. Pick the computer whose IRIS you want on this phone.</p>
          <Show when={error()}>
            <p style={styles.error}>{error()}</p>
          </Show>
          <Show when={nodes()} fallback={<p style={styles.lead}>Loading your machines…</p>}>
            <Show when={nodes()!.length} fallback={<p style={styles.lead}>No machines yet. Install IRIS Desktop on a computer and sign in there.</p>}>
              <div style={styles.list}>
                <For each={nodes()}>
                  {(node) => {
                    const online = node.connection_status === "online"
                    const ready = online && !!node.phone?.enabled
                    return (
                      <button style={styles.row} type="button" disabled={!ready || !!busy()} onClick={() => choose(node)}>
                        <span style={`${styles.dot};background:${online ? "#2f9e5b" : "#9c9c92"}`} />
                        <span style={styles.rowText}>
                          <span style={styles.rowName}>{node.name}</span>
                          <span style={styles.rowNote}>{busy() === node.id ? "Connecting…" : note(node)}</span>
                        </span>
                        <Show when={ready}>
                          <span style={styles.chevron}>›</span>
                        </Show>
                      </button>
                    )
                  }}
                </For>
              </div>
            </Show>
          </Show>
          <button style={styles.link} type="button" onClick={() => (setNodes(undefined), setError(""), load())}>
            Refresh
          </button>
          <button style={styles.link} type="button" onClick={() => showAddress()}>
            Connect by address instead
          </button>
          <button style={styles.link} type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </Screen>
    ),
    root,
  )
}

function showAddress(previous?: { url: string; password: string }, problem?: string) {
  const [url, setUrl] = createSignal(previous?.url ?? "")
  const [password, setPassword] = createSignal(previous?.password ?? "")
  const [error, setError] = createSignal(problem ?? "")
  const [busy, setBusy] = createSignal(false)

  const connect = async (event: SubmitEvent) => {
    event.preventDefault()
    const choice = { kind: "address" as const, url: normalize(url()), password: password().trim() }
    setBusy(true)
    const found = await reach({ url: choice.url, username: "opencode", password: choice.password })
    setBusy(false)
    if (found) return setError(found)
    localStorage.setItem(MACHINE_KEY, JSON.stringify(choice))
    location.reload()
  }

  const back = () => {
    localStorage.removeItem(MACHINE_KEY)
    location.reload()
  }

  render(
    () => (
      <Screen>
        <form style={styles.card} onSubmit={connect}>
          <h1 style={styles.title}>Connect by address</h1>
          <p style={styles.lead}>For an IRIS engine you reach another way, such as Tailscale: its address and its password.</p>
          <input
            style={styles.input}
            type="url"
            inputmode="url"
            autocapitalize="off"
            autocorrect="off"
            placeholder="https://your-mac.tailnet.ts.net"
            value={url()}
            onInput={(e) => setUrl(e.currentTarget.value)}
            required
          />
          <input
            style={styles.input}
            type="password"
            autocapitalize="off"
            placeholder="Password"
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
            required
          />
          <Show when={error()}>
            <p style={styles.error}>{error()}</p>
          </Show>
          <button style={styles.button} type="submit" disabled={busy()}>
            {busy() ? "Connecting…" : "Connect"}
          </button>
          <button style={styles.link} type="button" onClick={back}>
            Sign in with IRIS instead
          </button>
        </form>
      </Screen>
    ),
    root,
  )
}

function Screen(props: { children: JSX.Element }) {
  return <main style={styles.page}>{props.children}</main>
}

function note(node: Node) {
  if (node.connection_status !== "online") return "Offline"
  if (!node.phone?.enabled) return "Phone access is off on this machine"
  if (node.phone.engine === "stopped") return "Online · IRIS Desktop is not open"
  return "Online"
}

async function sendCode(email: string) {
  if (!email.includes("@")) throw new Error("Enter your email address.")
  // Exactly Desktop's payload (public/login.html): `email` alone is a 422, and auto_create is what
  // lets an account that has never signed in get a code at all.
  await post(`${AUTH_API}/api/v1/auth/send-login-code`, {
    email: email.trim(),
    method: "with_login_code",
    expiration_minutes: 30,
    auto_create: true,
  })
}

async function verify(email: string, code: string) {
  if (code.length !== 6) throw new Error("The code is 6 digits.")
  const data = await post(`${AUTH_API}/api/v1/auth/login-with-code`, {
    email: email.trim(),
    login_code: code, // NOT `code`: the endpoint names this field login_code (login.html)
    generate_sdk_token: true,
    sdk_token_name: "IRIS iPhone",
    sdk_token_expires_days: 365,
  })
  // Nested, as in login.html: data.data.sdk_token.key.
  const token = data?.data?.sdk_token?.key
  if (typeof token !== "string" || !token) throw new Error("Signed in, but no token came back. Try again.")
  const who = await fetch(`${AUTH_API}/api/v1/auth/whoami`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } })
  const user = who.ok ? (await who.json())?.data : undefined
  if (typeof user?.id !== "number") throw new Error("Signed in, but your account could not be read. Try again.")
  localStorage.setItem(ACCOUNT_KEY, JSON.stringify({ token, userId: user.id, email: user.email ?? email.trim() } satisfies Account))
}

async function listMachines(account: Account): Promise<Node[]> {
  const data = await hive(account, `/api/v6/nodes/?user_id=${account.userId}`)
  const list = (Array.isArray(data?.data) ? data.data : []) as Node[]
  // Ready first, then online, then by name: the one you can tap is at the top.
  const rank = (n: Node) => (n.connection_status === "online" ? (n.phone?.enabled ? 0 : 1) : 2)
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** A token the platform signs for this one machine (hp1, ADR-03), and the address to use it at. */
async function engineFor(account: Account, nodeId: string): Promise<Engine> {
  const data = await hive(account, `/api/v6/nodes/${encodeURIComponent(nodeId)}/phone-token?user_id=${account.userId}`, {})
  if (typeof data?.token !== "string" || typeof data?.url !== "string") throw new Error("this machine did not return an address.")
  return { url: data.url, username: "iris", password: data.token, expiresAt: Date.parse(data.expires_at) || undefined }
}

async function hive(account: Account, path: string, body?: unknown) {
  const response = await fetch(HIVE_API + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${account.token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => undefined)
  if (!response) throw new Error("No connection. Check this phone is online.")
  if (response.status === 401) {
    localStorage.removeItem(ACCOUNT_KEY)
    throw new Error("Your sign-in has expired. Sign in again.")
  }
  const data = await response.json().catch(() => ({}))
  if (response.status === 409) throw new Error("phone access is not turned on for this machine yet.")
  if (!response.ok) throw new Error(data?.message || data?.error || `the server answered ${response.status}.`)
  return data
}

async function post(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined)
  if (!response) throw new Error("No connection. Check this phone is online.")
  const data = await response.json().catch(() => ({}))
  // The auth API puts validation messages under `details` ({field: [messages]}); Laravel under `errors`.
  const fields = data?.details ?? data?.errors
  const detail = fields && typeof fields === "object" ? Object.values(fields).flat().join(" ") : ""
  if (!response.ok) throw new Error(detail || data?.message || data?.error || `Something went wrong (${response.status}).`)
  return data
}

/** Why this engine cannot be used, in words a person can act on — or nothing when it can. */
async function reach(engine: Engine) {
  if (!URL.canParse(engine.url)) return "That address is not a web address."
  const response = await globalThis
    .fetch(new URL("/global/health", engine.url), {
      headers: { Authorization: basicAuthorization({ username: engine.username, password: engine.password }) },
      signal: AbortSignal.timeout(10_000),
    })
    .catch(() => undefined)
  if (!response) return "could not reach it. Is it awake and online?"
  if (response.status === 401 || response.status === 403) return "it refused this phone's sign-in."
  if (response.status === 503) return "IRIS Desktop is not open on it."
  if (!response.ok) return `it answered with an error (${response.status}).`
  return ""
}

/**
 * One event to the same funnel IRIS Desktop reports to. Never awaited, never throws: telemetry must
 * not be able to break sign-in. The label carries what failed and the server's own words, never an
 * email address, a code or a token.
 */
function track(event: string, label?: string) {
  // randomUUID exists only in a secure context; whether WKWebView counts tauri:// as one is not
  // something sign-in should depend on.
  const visitor =
    localStorage.getItem(VISITOR_KEY) ??
    (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `ios-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
  localStorage.setItem(VISITOR_KEY, visitor)
  const account = read<Account>(ACCOUNT_KEY)
  void fetch(EVENTS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...(account ? { Authorization: `Bearer ${account.token}` } : {}) },
    body: JSON.stringify({
      event,
      visitor_id: visitor,
      path: "iphone",
      ...(label ? { label: label.replace(/[^\s@]+@[^\s@]+/g, "<email>").slice(0, 191) } : {}),
      props: { app_version: pkg.version, os: "ios" },
    }),
  }).catch(() => undefined)
}

function read<T>(key: string): T | undefined {
  const stored = localStorage.getItem(key)
  if (!stored) return
  try {
    return JSON.parse(stored) as T
  } catch {
    localStorage.removeItem(key)
    return
  }
}

function normalize(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "")
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
}

// Explicit colours from the phone's own light/dark setting: the app's theme variables are not
// loaded on these screens, and build 7 drew light text on a light page.
const dark = matchMedia("(prefers-color-scheme: dark)").matches
const ink = dark ? "#efede8" : "#16140f"
const paper = dark ? "#16140f" : "#efede8"
const line = dark ? "rgba(239,237,232,.18)" : "rgba(22,20,15,.14)"
const field = dark ? "#211e18" : "#ffffff"

const styles = {
  page: `min-height:100dvh;display:grid;place-items:center;padding:24px;padding-top:max(24px,env(safe-area-inset-top));background:${paper};color:${ink};font-family:Inter,system-ui,sans-serif`,
  card: "width:100%;max-width:380px;display:flex;flex-direction:column;gap:14px",
  title: "font-size:24px;font-weight:600;margin:8px 0 0",
  lead: "font-size:15px;line-height:1.45;opacity:.7;margin:0",
  input: `font-size:17px;padding:12px 14px;border-radius:10px;border:1px solid ${line};background:${field};color:${ink}`,
  error: `font-size:14px;line-height:1.4;color:${dark ? "#f08a7e" : "#b3261e"};margin:0`,
  button: `font-size:17px;font-weight:600;padding:14px;border-radius:12px;border:0;background:${ink};color:${paper};margin-top:6px`,
  link: `font-size:15px;padding:6px;border:0;background:none;color:${ink};opacity:.7`,
  list: `display:flex;flex-direction:column;border:1px solid ${line};border-radius:12px;overflow:hidden;background:${field}`,
  row: `display:flex;align-items:center;gap:12px;padding:14px;border:0;border-bottom:1px solid ${line};background:none;color:${ink};text-align:left;font:inherit`,
  dot: "width:9px;height:9px;border-radius:50%;flex:none",
  rowText: "display:flex;flex-direction:column;gap:2px;flex:1;min-width:0",
  rowName: "font-size:16px;font-weight:600",
  rowNote: "font-size:13px;opacity:.65",
  chevron: "font-size:22px;opacity:.5",
}

// Last, after `styles` and every helper exist: the first screen uses them synchronously.
void start()
