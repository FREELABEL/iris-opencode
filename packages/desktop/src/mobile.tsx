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
import { invoke } from "@tauri-apps/api/core"
import { addAccount, cloudUrl, engineFor, exchangeApple, exchangeGoogle, googleCode, googleStartUrl, machinesFor, note, removeAccount, sendCode, SignInExpired, verify, type Account, type Engine, type OwnedNode } from "./mobile-platform"

// Platform calls go through the native HTTP plugin (`fetch` above), so no CORS rule on either
// host can block sign-in. Calls to an engine use the webview's own fetch (`globalThis.fetch`),
// because that is what the interface uses afterwards: testing reachability any other way would
// pass a check the app then fails.
// The same public endpoint IRIS Desktop's onboarding events go to (src-tauri/src/onboarding.rs).
const EVENTS_API = "https://heyiris.io/api/v1/genesis/events"
const VISITOR_KEY = "iris.mobile.visitor"

// localStorage, not the Keychain: the Keychain (behind Face ID) is step 5 of the epic.
// Several accounts (Desktop keeps the same list in ~/.iris/accounts.json, #189321). Builds 9–13
// kept one account under "iris.mobile.account"; accounts() moves it into the list on first read.
const ACCOUNTS_KEY = "iris.mobile.accounts"
const LEGACY_ACCOUNT_KEY = "iris.mobile.account"
const MACHINE_KEY = "iris.mobile.machine"

// A Hive machine is remembered by id; its address and token are asked for on every launch.
type Choice = { kind: "hive"; nodeId: string; name: string; userId?: number } | { kind: "address"; url: string; password: string }

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
  // CI's Simulator check only (ios-build.yml): the build is pointed at an engine running on the
  // runner, so every build is screenshotted connected — Home, safe area, sidebar — before it can
  // reach TestFlight. Unset in every other build, including the TestFlight one.
  const sim = import.meta.env.VITE_IRIS_SIM_ENGINE as string | undefined
  if (sim) return openEngine({ url: sim, username: "opencode", password: String(import.meta.env.VITE_IRIS_SIM_PASSWORD ?? "") }, (problem) => showAddress({ url: sim, password: "" }, problem))
  track("iphone.launch")
  const choice = read<Choice>(MACHINE_KEY)
  const signedIn = accounts()
  if (choice?.kind === "address") return openEngine({ url: choice.url, username: "opencode", password: choice.password }, () => showAddress(choice))
  if (!signedIn.length) return showSignIn()
  if (!choice) return showMachines(signedIn)
  // The account that owns the remembered machine; a choice saved before several accounts had none.
  const account = signedIn.find((a) => a.userId === choice.userId) ?? signedIn[0]!
  const engine = await engineFor(fetch, account, choice.nodeId).catch((e: Error) => e)
  if (engine instanceof SignInExpired) return (signOut(account), location.reload())
  if (engine instanceof Error) return showMachines(signedIn, `${choice.name}: ${engine.message}`)
  return openEngine(engine, () => showMachines(signedIn))
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
  keepInsideSafeArea()
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

/** `adding`: another account on top of the ones already signed in (from the machines screen). */
function showSignIn(problem?: string, adding = false) {
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
    const result = await (sent()
      ? verify(fetch, email(), code()).then(saveAccount)
      : sendCode(fetch, email())
    ).catch((e: Error) => e)
    setBusy(false)
    if (result instanceof Error) return (track("iphone.signin.failed", `${step}: ${result.message}`), setError(result.message))
    if (!sent()) return (track("iphone.signin.code_sent"), setSent(true))
    track("iphone.signin.verified")
    location.reload()
  }

  // Apple's sign-in sheet (plugins/web-auth) → fl-api → Google → iris://auth/google?code=… → the
  // exchange with the PKCE verifier that never left this app (ADR-04).
  const google = async () => {
    setError("")
    setBusy(true)
    track("iphone.signin.google_started")
    const result = await (async () => {
      const pair = await invoke<{ challenge: string; verifier: string }>("pkce_pair")
      const callback = await invoke<string>("plugin:iris-web-auth|authenticate", { url: googleStartUrl(pair.challenge), callbackScheme: "iris" })
      return exchangeGoogle(fetch, googleCode(callback), pair.verifier)
    })().catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
    setBusy(false)
    if (result instanceof Error && result.message === "cancelled") return track("iphone.signin.google_cancelled")
    if (result instanceof Error) return (track("iphone.signin.failed", `google: ${result.message}`), setError(result.message))
    saveAccount(result)
    track("iphone.signin.verified", "google")
    location.reload()
  }

  // Sign in with Apple (#194555, guideline 4.8): Apple's native sheet signs the SHA-256 of a nonce
  // into the identity token; fl-api checks it against the raw nonce, which never leaves this app
  // except to fl-api. Same SDK token and account path as every other sign-in.
  const apple = async () => {
    setError("")
    setBusy(true)
    track("iphone.signin.apple_started")
    const result = await (async () => {
      const nonce = await invoke<{ raw: string; hashed: string }>("nonce_pair")
      const reply = await invoke<{ identityToken: string; givenName?: string; familyName?: string }>("plugin:iris-web-auth|sign_in_with_apple", { nonce: nonce.hashed })
      return exchangeApple(fetch, { identityToken: reply.identityToken, rawNonce: nonce.raw, givenName: reply.givenName, familyName: reply.familyName })
    })().catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
    setBusy(false)
    if (result instanceof Error && result.message === "cancelled") return track("iphone.signin.apple_cancelled")
    if (result instanceof Error) return (track("iphone.signin.failed", `apple: ${result.message}`), setError(result.message))
    saveAccount(result)
    track("iphone.signin.verified", "apple")
    location.reload()
  }

  render(
    () => (
      <Screen>
        <form style={styles.card} onSubmit={submit}>
          <img src="/favicon.svg" alt="" width="44" height="44" />
          <h1 style={styles.title}>{adding ? "Add an account" : "Sign in to IRIS"}</h1>
          <p style={styles.lead}>
            {sent() ? `We emailed a 6-digit code to ${email().trim()}.` : "Use the email you sign in to IRIS Desktop with."}
          </p>
          <Show when={!sent()}>
            <button style={styles.apple} type="button" disabled={busy()} onClick={apple}>
              <AppleMark />
              <span>Sign in with Apple</span>
            </button>
            <button style={styles.google} type="button" disabled={busy()} onClick={google}>
              <GoogleMark />
              <span>Continue with Google</span>
            </button>
            <p style={styles.or}>or</p>
          </Show>
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
          <Show
            when={adding}
            fallback={
              <button style={styles.link} type="button" onClick={() => showAddress()}>
                Connect by address instead
              </button>
            }
          >
            <button style={styles.link} type="button" onClick={() => location.reload()}>
              Back to your machines
            </button>
          </Show>
        </form>
      </Screen>
    ),
    root,
  )
}

function showMachines(signedIn: Account[], problem?: string) {
  const [nodes, setNodes] = createSignal<OwnedNode[]>()
  const [error, setError] = createSignal(problem ?? "")
  const [busy, setBusy] = createSignal("")
  const several = signedIn.length > 1

  const load = async () => {
    const result = await machinesFor(fetch, signedIn)
    track("iphone.machines.loaded", `${signedIn.length} accounts, ${result.machines.length} machines, ${result.machines.filter((n) => n.connection_status === "online" && n.phone?.enabled).length} ready`)
    // An expired sign-in drops only that account; the others' machines stay on screen.
    result.expired.forEach(signOut)
    const notes = [...result.expired.map((a) => `Your sign-in for ${a.email} expired. Add it again to see its machines.`), ...result.failures]
    if (notes.length) (track("iphone.machines.failed", notes.join(" | ")), setError(notes.join(" ")))
    if (result.expired.length === signedIn.length) return showSignIn(notes.join(" "))
    setNodes(result.machines)
  }
  void load()

  const choose = async (node: OwnedNode) => {
    setError("")
    setBusy(node.id)
    const engine = await engineFor(fetch, node.owner, node.id).catch((e: Error) => e)
    if (engine instanceof SignInExpired) return (signOut(node.owner), location.reload())
    if (engine instanceof Error) return (track("iphone.connect.failed", `token: ${engine.message}`), setBusy(""), setError(`${node.name}: ${engine.message}`))
    const problem = await reach(engine)
    setBusy("")
    if (problem) return (track("iphone.connect.failed", `reach: ${problem}`), setError(`${node.name}: ${problem}`))
    track("iphone.connect.ok")
    localStorage.setItem(MACHINE_KEY, JSON.stringify({ kind: "hive", nodeId: node.id, name: node.name, userId: node.owner.userId } satisfies Choice))
    location.reload()
  }

  // IRIS Cloud: heyiris.io/atlas signed in as the first account, in the sign-in sheet, which
  // doubles as an in-app browser — its Done button brings the person back to this screen.
  const openCloud = async () => {
    const account = signedIn[0]!
    setError("")
    setBusy("cloud")
    const url = await cloudUrl(fetch, account).catch((e: Error) => e)
    if (url instanceof SignInExpired) return (signOut(account), location.reload())
    if (url instanceof Error) return (setBusy(""), track("iphone.cloud.failed", url.message), setError(url.message))
    track("iphone.cloud.opened")
    await invoke("plugin:iris-web-auth|authenticate", { url, callbackScheme: "iris" }).catch(() => undefined)
    setBusy("")
  }

  render(
    () => (
      <Screen>
        <div style={styles.card}>
          <h1 style={styles.title}>Your machines</h1>
          <p style={styles.lead}>Signed in as {signedIn.map((a) => a.email).join(" and ")}. Pick the computer whose IRIS you want on this phone.</p>
          <Show when={error()}>
            <p style={styles.error}>{error()}</p>
          </Show>
          <div style={styles.list}>
            <button style={styles.row} type="button" disabled={!!busy()} onClick={openCloud}>
              <span style={`${styles.dot};background:#4285F4`} />
              <span style={styles.rowText}>
                <span style={styles.rowName}>IRIS Cloud</span>
                <span style={styles.rowNote}>{busy() === "cloud" ? "Opening…" : "Chat, boards and your agents. No computer needed."}</span>
              </span>
              <span style={styles.chevron}>›</span>
            </button>
          </div>
          <Show when={nodes()} fallback={<p style={styles.lead}>Loading your machines…</p>}>
            <Show
              when={nodes()!.length}
              fallback={
                <p style={styles.lead}>
                  No machines on {several ? "these accounts" : "this account"} yet. Use IRIS Cloud above, or, if your computers are signed in to
                  IRIS with another email, add that account below.
                </p>
              }
            >
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
                          <span style={styles.rowNote}>{busy() === node.id ? "Connecting…" : several ? `${note(node)} · ${node.owner.email}` : note(node)}</span>
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
          <button style={styles.link} type="button" onClick={() => showSignIn(undefined, true)}>
            Add another account
          </button>
          <button style={styles.link} type="button" onClick={() => showAddress()}>
            Connect by address instead
          </button>
          <For each={signedIn}>
            {(account) => (
              <button style={styles.link} type="button" onClick={() => (signOut(account), location.reload())}>
                Sign out{several ? ` of ${account.email}` : ""}
              </button>
            )}
          </For>
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

/**
 * Google's "G", exactly as its sign-in branding guidelines ship it: four paths in Google's own
 * colours, never recoloured or redrawn (developers.google.com/identity/branding-guidelines).
 */
function GoogleMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true" style="flex:none">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

/** Apple's logo for the Sign in with Apple button, in the button's text colour (HIG). */
function AppleMark() {
  return (
    <svg width="17" height="20" viewBox="0 0 814 1000" aria-hidden="true" style="flex:none;margin-top:-3px">
      <path
        fill="currentColor"
        d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 82.8-55.1 134.7 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-70.5z"
      />
    </svg>
  )
}

function Screen(props: { children: JSX.Element }) {
  return <main style={styles.page}>{props.children}</main>
}

/**
 * The iOS web view draws edge to edge. The interface already pads itself by the safe area
 * (app/src/pages/layout-new.tsx: env(safe-area-inset-top/bottom)), but iOS reports those insets
 * only once the page declares viewport-fit=cover — without it they read 0 and Home ran under the
 * clock (builds 13–22). Build 28 also padded the body itself and got the inset twice (too much
 * space above and below); the declaration alone is the whole fix.
 */
function keepInsideSafeArea() {
  document.querySelector('meta[name="viewport"]')?.setAttribute("content", "width=device-width, initial-scale=1, viewport-fit=cover")
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
  const account = accounts()[0]
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

/** Every signed-in account; moves the single account builds 9–13 saved into the list. */
function accounts(): Account[] {
  const list = read<Account[]>(ACCOUNTS_KEY)
  if (Array.isArray(list)) return list
  const legacy = read<Account>(LEGACY_ACCOUNT_KEY)
  if (!legacy) return []
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([legacy]))
  localStorage.removeItem(LEGACY_ACCOUNT_KEY)
  return [legacy]
}

function saveAccount(account: Account) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(addAccount(accounts(), account)))
}

/** Forget one account, and the remembered machine if that account owned it. */
function signOut(account: Account) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(removeAccount(accounts(), account.userId)))
  const choice = read<Choice>(MACHINE_KEY)
  if (choice?.kind === "hive" && (choice.userId === undefined || choice.userId === account.userId)) localStorage.removeItem(MACHINE_KEY)
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
  // Sign in with Apple, Apple's own style (HIG): black with white in light mode, white with black in
  // dark mode. Same padding, border width, radius and type size as Google's, so the two are equal.
  apple: `display:flex;align-items:center;justify-content:center;gap:8px;font-size:17px;font-weight:500;font-family:-apple-system,system-ui,sans-serif;padding:13px 14px;border-radius:12px;border:1px solid ${dark ? "#FFFFFF" : "#000000"};background:${dark ? "#FFFFFF" : "#000000"};color:${dark ? "#000000" : "#FFFFFF"}`,
  // Google's sign-in button colours: light #FFFFFF / border #747775 / text #1F1F1F; dark #131314 / #8E918F / #E3E3E3.
  google: `display:flex;align-items:center;justify-content:center;gap:12px;font-size:17px;font-weight:500;padding:13px 14px;border-radius:12px;border:1px solid ${dark ? "#8E918F" : "#747775"};background:${dark ? "#131314" : "#FFFFFF"};color:${dark ? "#E3E3E3" : "#1F1F1F"}`,
  or: "font-size:13px;opacity:.55;margin:0;text-align:center",
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
