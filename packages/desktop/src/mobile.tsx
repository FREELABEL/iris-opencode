// The iPhone entry (#194511). iOS will not run the engine sidecar, so the phone is the same
// interface pointed at an engine on one of the person's own machines: today over Tailscale
// (`tailscale serve` in front of `iris serve`), later the Hive relay. The first screen asks which
// machine; after that the app opens straight into it, like the web build does (app/src/entry.tsx).
import "@opencode-ai/app/polyfills"
import { render } from "solid-js/web"
import { createSignal, Show } from "solid-js"
import type { Platform, ServerConnection } from "@opencode-ai/app"
import { basicAuthorization, engineOrigins, withEngineAuth } from "@opencode-ai/app/engine-auth"
import { openUrl } from "@tauri-apps/plugin-opener"
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"
import pkg from "../package.json"

// localStorage, not the Keychain: v1 is for the person's own phone and own machines. The Keychain
// (behind Face ID) is step 5 of the epic.
const MACHINE_KEY = "iris.mobile.machine"

type Machine = { url: string; password: string }

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
  const machine = readMachine()
  if (!machine) return showConnect()
  const problem = await reach(machine)
  if (problem) return showConnect(machine, problem)
  await showApp(machine)
}

// The interface (2+ MB) loads only once a machine answers, so the connect screen never waits on it
// and never fails because of it.
async function showApp(machine: Machine) {
  const { AppBaseProviders, AppInterface, PlatformProvider, ServerConnection } = await import("@opencode-ai/app")
  const engine = new URL(machine.url)
  // The IRIS panels call /iris with a bare fetch, as in the desktop window (engine-auth.ts).
  globalThis.fetch = withEngineAuth(
    globalThis.fetch.bind(globalThis),
    engineOrigins(Number(engine.port)).add(engine.origin),
    basicAuthorization({ username: "opencode", password: machine.password }),
  )
  const server: ServerConnection.Http = {
    type: "http",
    authToken: true,
    http: { url: engine.origin, username: "opencode", password: machine.password },
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

function showConnect(previous?: Machine, problem?: string) {
  const [url, setUrl] = createSignal(previous?.url ?? "")
  const [password, setPassword] = createSignal(previous?.password ?? "")
  const [error, setError] = createSignal(problem ?? "")
  const [busy, setBusy] = createSignal(false)

  const connect = async (event: SubmitEvent) => {
    event.preventDefault()
    const machine = { url: normalize(url()), password: password().trim() }
    setBusy(true)
    const found = await reach(machine)
    setBusy(false)
    if (found) return setError(found)
    localStorage.setItem(MACHINE_KEY, JSON.stringify(machine))
    location.reload()
  }

  render(
    () => (
      <main style={styles.page}>
        <form style={styles.card} onSubmit={connect}>
          <img src="/favicon.svg" alt="" width="44" height="44" />
          <h1 style={styles.title}>Connect to your machine</h1>
          <p style={styles.lead}>
            IRIS runs on your own computer. Enter its address and the password you set for this phone.
          </p>
          <label style={styles.label}>
            Address
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
          </label>
          <label style={styles.label}>
            Password
            <input
              style={styles.input}
              type="password"
              autocapitalize="off"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              required
            />
          </label>
          <Show when={error()}>
            <p style={styles.error}>{error()}</p>
          </Show>
          <button style={styles.button} type="submit" disabled={busy()}>
            {busy() ? "Connecting…" : "Connect"}
          </button>
        </form>
      </main>
    ),
    root,
  )
}

/** Why this machine cannot be used, in words a person can act on — or nothing when it can. */
async function reach(machine: Machine) {
  if (!URL.canParse(machine.url)) return "That address is not a web address."
  const response = await fetch(new URL("/global/health", machine.url), {
    headers: { Authorization: basicAuthorization({ username: "opencode", password: machine.password }) },
    signal: AbortSignal.timeout(8000),
  }).catch(() => undefined)
  if (!response) return "Could not reach that machine. Is it awake, and is Tailscale on on this phone?"
  if (response.status === 401) return "The machine answered, but the password is wrong."
  if (!response.ok) return `The machine answered with an error (${response.status}).`
  return ""
}

function readMachine(): Machine | undefined {
  const stored = localStorage.getItem(MACHINE_KEY)
  if (!stored) return
  const parsed = JSON.parse(stored) as Partial<Machine>
  if (typeof parsed.url !== "string" || typeof parsed.password !== "string") return
  return { url: parsed.url, password: parsed.password }
}

function normalize(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "")
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
}

// Explicit colours from the phone's own light/dark setting: the app's theme variables are not
// loaded on this screen, and the first build drew light text on a light page.
const dark = matchMedia("(prefers-color-scheme: dark)").matches
const ink = dark ? "#efede8" : "#16140f"
const paper = dark ? "#16140f" : "#efede8"

const styles = {
  page: `min-height:100dvh;display:grid;place-items:center;padding:24px;padding-top:max(24px,env(safe-area-inset-top));background:${paper};color:${ink};font-family:Inter,system-ui,sans-serif`,
  card: "width:100%;max-width:380px;display:flex;flex-direction:column;gap:14px",
  title: "font-size:24px;font-weight:600;margin:8px 0 0",
  lead: "font-size:15px;line-height:1.45;opacity:.7;margin:0",
  label: "display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:500",
  input: `font-size:17px;padding:12px 14px;border-radius:10px;border:1px solid ${dark ? "rgba(239,237,232,.25)" : "rgba(22,20,15,.2)"};background:${dark ? "#211e18" : "#ffffff"};color:${ink}`,
  error: `font-size:14px;color:${dark ? "#f08a7e" : "#b3261e"};margin:0`,
  button: `font-size:17px;font-weight:600;padding:14px;border-radius:12px;border:0;background:${ink};color:${paper};margin-top:6px`,
}

// Last, after `styles` and every helper exist: the connect screen uses them synchronously.
void start()
