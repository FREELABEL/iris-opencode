import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { Check, GmailLogo, InboxArt, OutlookLogo, Spinner } from "./home-first-run-art"
import { SignInPanel } from "./home-first-run-signin"
import type { InboxThread } from "./home-first-run-inbox"
import { INTENTS, IntentPicker, planFor, type Intent } from "./home-first-run-intent"
import { ClarifyStep } from "./home-first-run-clarify"
import "./home-first-run.css"

/**
 * First run, inside the app (D4 #188245 + D5 #188243, EPIC #188210).
 *
 * The old first screen after sign-in was an empty project list and a folder icon: IRIS had done
 * nothing, and the next move was to understand what a "project" is. This replaces it, for a new
 * install only, with three steps that end in real work:
 *
 *   1. Connect your inbox   — the browser round trip; we POLL for the connection instead of
 *                             asking the person to "reopen this menu"
 *   2. Here's what I see    — their own waiting threads, one sentence about their business, and
 *                             ONE question whose answers come from what was found
 *   3. Start                — ~/IRIS/<business> is created (never a folder picker) and a session
 *                             opens there with their answer and those threads already written
 *
 * Engine endpoints: /iris/onboarding/{state,mail,ground,workspace,track}. Every response carries
 * `measured`; when it is false the screen says the reason and offers retry and skip — a spinner
 * that never resolves is the one thing this screen must not do.
 */

export const FIRST_RUN_KEY = "iris.onboarding.v1"

/**
 * Signed out → true, signed in → false, not known yet → undefined.
 *
 * Asked of the engine, because the first-run flag cannot answer it: that flag lives in the
 * webview's storage, which outlives the credential (reinstall, sign-out, expired key, a test
 * that wipes ~/.iris). Gating sign-in on "first run not done" sent exactly those people to an
 * empty project list, and 10 s later the fallback window — the chain this replaces (2026-10-08).
 */
export function createSignedOut() {
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const [signedOut, setSignedOut] = createSignal<boolean | undefined>(undefined)
  let tries = 0
  const check = async () => {
    const res = await (platform.fetch ?? globalThis.fetch)(`${serverSDK().url.replace(/\/$/, "")}/iris/onboarding/state`, {
      headers: { Accept: "application/json" },
    }).catch(() => null)
    const body = res?.ok ? await res.json().catch(() => null) : null
    if (body && typeof body.signedIn === "boolean") return setSignedOut(!body.signedIn)
    // The engine may still be starting. Keep asking for a while; never decide on silence.
    if (++tries < 30) setTimeout(check, 1000)
  }
  onMount(() => void check())
  return signedOut
}

export function firstRunPending(): boolean {
  try {
    return !localStorage.getItem(FIRST_RUN_KEY)
  } catch {
    return false
  }
}

type Thread = InboxThread
type Provider = "gmail" | "outlook"
type Tile = { type: Provider; name: string; detail: string; Logo: (p: { class?: string }) => any }

const TILES: Tile[] = [
  { type: "gmail", name: "Gmail", detail: "Gmail and Google Workspace", Logo: GmailLogo },
  { type: "outlook", name: "Outlook", detail: "Outlook and Microsoft 365", Logo: OutlookLogo },
]

// Sign in → What do you want → Connect (for that) → What IRIS can do. Asked first, read second:
// the inbox is used toward an answer the person gave, never scanned to see what's there.
const STEP_INDEX: Record<string, number> = { signin: 0, loading: 0, intent: 1, connect: 2, reading: 3, seen: 3, starting: 3, error: 3 }
type Step =
  | { kind: "loading" }
  | { kind: "signin" }
  | {
      kind: "connect"
      note?: string
      waiting?: Provider
      connected?: { type: Provider; account?: string }
      /** Already connected before this screen opened: shown, never skipped — the person chooses. */
      ready?: { type: Provider; account?: string }
    }
  | { kind: "intent" }
  | { kind: "reading" }
  | {
      kind: "seen"
      threads: Thread[]
      waiting: Thread[]
      account?: string
      line?: string
      industry?: string
      choices: string[]
    }
  | { kind: "starting" }
  | { kind: "error"; reason: string; retry: () => void }

const POLL_MS = 2000
const POLL_FOR_MS = 5 * 60 * 1000

function senderName(from: string): string {
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from)
  return (m ? m[1] : from).trim()
}

export function HomeFirstRun(props: { onStart: (directory: string, prompt: string) => void; onDone: () => void }) {
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const base = createMemo(() => serverSDK().url.replace(/\/$/, ""))
  const call = async (path: string, init?: RequestInit): Promise<any> => {
    const res = await (platform.fetch ?? globalThis.fetch)(`${base()}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(init?.headers ?? {}) },
    })
    return res.json().catch(() => null)
  }
  const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) })
  const track = (event: string, label?: string) => void post("/iris/onboarding/track", { event, label }).catch(() => {})

  const [step, setStep] = createSignal<Step>({ kind: "loading" })
  const [answer, setAnswer] = createSignal("")
  const [provider, setProvider] = createSignal<"gmail" | "outlook">("gmail")
  const [intent, setIntent] = createSignal<Intent>({ id: "reply", text: INTENTS[0].label })

  // Known from state(): an inbox connected before this screen. Shown on Connect, never skipped
  // silently — but once they have answered, an existing connection goes straight to the read.
  let connected: { type: Provider; account?: string } | undefined
  const pick = (i: Intent) => {
    setIntent(i)
    track("onboarding.question_answered", `${i.id}: ${i.text.slice(0, 100)}`)
    if (connected) return void read()
    setStep({ kind: "connect" })
  }
  let poll: ReturnType<typeof setInterval> | undefined
  const stopPoll = () => poll && clearInterval(poll)
  onCleanup(stopPoll)

  const finish = (how: "done" | "skipped") => {
    try {
      localStorage.setItem(FIRST_RUN_KEY, how)
    } catch {}
    props.onDone()
  }

  async function begin() {
    setStep({ kind: "loading" })
    const s = await call("/iris/onboarding/state").catch(() => null)
    if (!s) return setStep({ kind: "error", reason: "IRIS isn't answering yet.", retry: begin })
    if (s.signedIn === false) return waitForSignIn()
    if (s.mail?.connected) setProvider(s.mail.type === "outlook" ? "outlook" : "gmail")
    connected = s.mail?.connected ? { type: s.mail.type === "outlook" ? "outlook" : "gmail", account: s.mail.account } : undefined
    // The question comes first. The inbox is only touched once there is an answer to work toward.
    setStep({ kind: "intent" })
  }

  async function connect(type: Provider) {
    setProvider(type)
    setStep({ kind: "connect", waiting: type, note: "Opening your browser…" })
    const r = await post("/iris/integrations/connect", { type }).catch(() => null)
    if (!r?.measured || !r.url) {
      return setStep({ kind: "connect", note: r?.reason ?? "Couldn't start the connection. Try again." })
    }
    platform.openExternal(r.url)
    setStep({ kind: "connect", waiting: type, note: "Approve IRIS in your browser. This page continues on its own." })

    // Poll, don't ask them to come back and click: the old menu said "reopen this menu".
    stopPoll()
    const started = Date.now()
    poll = setInterval(async () => {
      if (Date.now() - started > POLL_FOR_MS) {
        stopPoll()
        return setStep({ kind: "connect", note: "Still waiting on your browser. Connect again when you're ready." })
      }
      const s = await call("/iris/onboarding/state").catch(() => null)
      if (s?.mail?.connected) {
        stopPoll()
        // Let the person SEE it worked before the screen moves on.
        setStep({ kind: "connect", connected: { type, account: s.mail.account } })
        setTimeout(() => void read(), 900)
      }
    }, POLL_MS)
  }

  // Signed out: sign in here, as step one. Sign-in restarts the app (the engine reads the key at
  // start), so this poll only matters if the fallback window finished it instead.
  function waitForSignIn() {
    setStep({ kind: "signin" })
    stopPoll()
    poll = setInterval(async () => {
      const s = await call("/iris/onboarding/state").catch(() => null)
      if (s?.signedIn) {
        stopPoll()
        void begin()
      }
    }, POLL_MS)
  }

  async function read() {
    setStep({ kind: "reading" })
    const m = await call("/iris/onboarding/mail").catch(() => null)
    if (!m?.measured) {
      // A dead or missing connection is not an error to retry: the fix is to connect again,
      // so go back to the tiles. ("Run: iris connect gmail" is advice for the CLI, not here.)
      if (/connection|not connected|expired|reconnect|unauthori[sz]ed|invalid_grant/i.test(String(m?.reason ?? ""))) {
        return setStep({ kind: "connect", note: "Your mail connection needs renewing. Connect it again to continue." })
      }
      return setStep({ kind: "error", reason: `Couldn't read your mail: ${m?.reason ?? "no answer"}`, retry: read })
    }
    if (!m.threads?.length) {
      // Present-but-empty is not present: say so, don't show an empty card.
      return setStep({ kind: "error", reason: "Your inbox came back empty, so there's nothing to show yet.", retry: read })
    }
    track("onboarding.mail_read", String(m.threads.length))

    const g = await post("/iris/onboarding/ground", { threads: m.threads }).catch(() => null)
    if (g?.measured) track("onboarding.grounded", g.industry)
    setStep({
      kind: "seen",
      threads: m.threads,
      account: m.account,
      waiting: m.waiting ?? [],
      line: g?.line,
      industry: g?.industry,
      choices: g?.choices?.length ? g.choices : ["Reply to what's waiting on me", "Summarise my week", "Find what I've missed"],
    })
  }

  async function start(seen: Extract<Step, { kind: "seen" }>, text: string, focus?: Thread[]) {
    const want = text.trim()
    if (!want) return
    setStep({ kind: "starting" })

    const ws = await post("/iris/onboarding/workspace", { name: seen.industry || "my-work" }).catch(() => null)
    if (!ws?.measured || !ws.path) {
      return setStep({ kind: "error", reason: `Couldn't create your workspace: ${ws?.reason ?? "no answer"}`, retry: () => setStep(seen) })
    }
    track("onboarding.workspace_created")

    const context = (focus?.length ? focus : seen.waiting)
      .map((t) => `- ${senderName(t.from)}: "${t.subject}" — ${t.snippet.slice(0, 160)}`)
      .join("\n")
    const lead = focus?.length ? "The emails:" : "Start with what's waiting on me in my inbox:"
    const prompt =
      `${want}\n\n` +
      (context ? `${lead}\n${context}\n\n` : "") +
      `Use my connected email to read the full threads. Draft, don't send.`
    track("onboarding.working")
    finish("done")
    props.onStart(ws.path, prompt)
  }

  onMount(begin)

  return (
    <div data-component="first-run" class="relative min-h-screen w-full">
    <div class="fr-ambient" aria-hidden="true" />
    <div class="relative mx-auto flex w-full max-w-[640px] flex-col gap-6 px-6 py-14">
      <div class="fr-steps" role="progressbar" aria-valuemin={1} aria-valuemax={4} aria-valuenow={STEP_INDEX[step().kind] + 1}>
        <For each={[0, 1, 2, 3]}>{(i) => <span data-on={i <= STEP_INDEX[step().kind] ? "" : undefined} />}</For>
      </div>
      <Switch>
        <Match when={step().kind === "loading" || step().kind === "reading" || step().kind === "starting"}>
          <div class="fr-rise flex flex-col items-center gap-2 text-center">
            <Show when={step().kind === "reading"}>
              <div class="fr-hero mb-4">
                <InboxArt reading />
              </div>
            </Show>
            <h1 class="text-v2-text-text-base text-[22px] [font-weight:600]">
              {step().kind === "reading" ? `Working on: ${intent().text.toLowerCase()}…` : step().kind === "starting" ? "Setting up your workspace…" : "One moment…"}
            </h1>
            <p class="text-v2-text-text-muted text-[14px]">
              {step().kind === "reading" ? "Using your inbox only for this. Nothing is sent." : ""}
            </p>
            <Show when={step().kind !== "reading"}>
              <Spinner class="mt-2 text-v2-text-text-muted" />
            </Show>
          </div>
        </Match>

        <Match when={step().kind === "signin"}>
          <div class="fr-rise flex flex-col items-center gap-6 text-center">
            <div class="fr-hero">
              <InboxArt />
            </div>
            <div class="flex flex-col gap-2">
              <h1 class="text-v2-text-text-base text-[26px] leading-tight [font-weight:650]">Sign in to IRIS</h1>
              <p class="text-v2-text-text-muted mx-auto max-w-[440px] text-[15px] leading-relaxed">
                One click with Google, or a code by email. Your inbox is next.
              </p>
            </div>
            <div class="w-full max-w-[400px] text-left">
              <SignInPanel />
            </div>
          </div>
        </Match>

        <Match when={step().kind === "connect" && (step() as Extract<Step, { kind: "connect" }>)}>
          {(s) => (
            <div class="fr-rise flex flex-col gap-7">
              <div class="flex flex-col items-center gap-5 text-center">
                <div class="fr-hero">
                  <InboxArt />
                </div>
                <div class="flex flex-col gap-2">
                  <p class="fr-mono text-v2-text-text-muted text-[11.5px] uppercase tracking-[0.14em]">{intent().text}</p>
                  <h1 class="text-v2-text-text-base text-[26px] leading-tight [font-weight:650]">Connect your inbox to do that</h1>
                  <p class="text-v2-text-text-muted mx-auto max-w-[460px] text-[15px] leading-relaxed">
                    IRIS uses your mail only for what you just asked, and drafts the work for you to approve. You decide
                    what gets sent.
                  </p>
                </div>
              </div>

              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <For each={TILES}>
                  {(t) => {
                    const state = () => {
                      const c = s()
                      if (c.connected) return c.connected.type === t.type ? "connected" : "idle-other"
                      if (c.ready && c.ready.type === t.type && !c.waiting) return "connected"
                      if (c.waiting) return c.waiting === t.type ? "waiting" : "idle-other"
                      return "idle"
                    }
                    return (
                      <button
                        class="fr-tile"
                        data-state={state()}
                        disabled={state() === "connected" && !s().ready}
                        onClick={() => (state() === "connected" && s().ready ? void read() : void connect(t.type))}
                      >
                        <span class="fr-logo">
                          <t.Logo />
                        </span>
                        <span class="flex flex-col gap-0.5">
                          <span class="text-v2-text-text-base text-[16px] [font-weight:600]">
                            {state() === "connected" ? `${t.name} connected` : `Connect ${t.name}`}
                          </span>
                          <span class="text-v2-text-text-muted text-[13px]">
                            <Switch fallback={t.detail}>
                              <Match when={state() === "waiting"}>Waiting for your browser…</Match>
                              <Match when={state() === "connected"}>
                                {s().connected?.account ?? s().ready?.account ?? "Reading your mail next"}
                              </Match>
                            </Switch>
                          </span>
                        </span>
                        <span class="fr-arrow">
                          <Switch
                            fallback={
                              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                                <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                              </svg>
                            }
                          >
                            <Match when={state() === "waiting"}>
                              <Spinner />
                            </Match>
                            <Match when={state() === "connected"}>
                              <Check />
                            </Match>
                          </Switch>
                        </span>
                      </button>
                    )
                  }}
                </For>
              </div>

              <Show when={s().ready && !s().waiting}>
                <div class="flex flex-col items-center gap-2">
                  <button class="fr-primary px-6" onClick={() => void read()}>
                    Continue with {s().ready!.account ?? (s().ready!.type === "outlook" ? "Outlook" : "Gmail")}
                  </button>
                  <span class="text-[12.5px] text-v2-text-text-faint">or connect the other inbox instead</span>
                </div>
              </Show>

              <Show when={s().note}>
                <p class="text-v2-text-text-muted text-center text-[13px]" aria-live="polite">
                  {s().note}
                  <Show when={s().waiting}>
                    {" "}
                    <button class="underline hover:text-v2-text-text-base" onClick={() => void connect(s().waiting!)}>
                      Open it again
                    </button>
                  </Show>
                </p>
              </Show>

              <div class="fr-trust justify-center">
                <span>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2" fill="none" stroke="currentColor" stroke-width="1.5" />
                    <rect x="3" y="7" width="10" height="7" rx="2" fill="currentColor" />
                  </svg>
                  Official Google & Microsoft sign-in
                </span>
                <span>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3 11.5l6.8-6.8 1.5 1.5-6.8 6.8H3z M10.5 4l1.5-1.5 1.5 1.5L12 5.5z" fill="currentColor" />
                  </svg>
                  Never sends on its own
                </span>
                <span>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zm-3 5.25h6v1.5H5z" fill="currentColor" />
                  </svg>
                  Disconnect anytime
                </span>
              </div>
            </div>
          )}
        </Match>

        <Match when={step().kind === "intent"}>
          <div class="fr-rise flex flex-col gap-6">
            <div class="flex flex-col gap-2 text-center">
              <p class="fr-mono text-v2-text-text-muted text-[11.5px] uppercase tracking-[0.14em]">You're signed in</p>
              <h1 class="text-v2-text-text-base text-[26px] leading-tight [font-weight:650]">
                What do you want IRIS to take off your plate?
              </h1>
              <p class="text-v2-text-text-muted mx-auto max-w-[460px] text-[15px] leading-relaxed">
                Pick one. IRIS works toward exactly that, and comes back with what it can do.
              </p>
            </div>
            <IntentPicker onPick={pick} />
          </div>
        </Match>

        <Match when={step().kind === "seen" && (step() as Extract<Step, { kind: "seen" }>)}>
          {(s) => {
            const plan = () => planFor(intent(), s().threads)
            return (
              <div class="fr-rise flex flex-col gap-5">
                <div class="flex flex-col gap-2">
                  <p class="fr-mono text-v2-text-text-muted text-[11.5px] uppercase tracking-[0.14em]">
                    {intent().id === "custom" ? "You asked" : intent().text}
                  </p>
                  <h1 class="text-v2-text-text-base text-[24px] leading-snug [font-weight:650]">{plan().title}</h1>
                  <Show when={s().line}>
                    <p class="text-v2-text-text-muted text-[14px]">{s().line}</p>
                  </Show>
                </div>

                <p class="text-v2-text-text-muted -mt-2 text-[14px]">Pick what IRIS should do. Nothing goes out without you.</p>
                <ClarifyStep intent={intent()} threads={s().threads} onStart={(prompt, focus) => void start(s(), prompt, focus)} />
              </div>
            )
          }}
        </Match>

        <Match when={step().kind === "error" && (step() as Extract<Step, { kind: "error" }>)}>
          {(s) => (
            <div class="flex flex-col gap-3">
              <h1 class="text-v2-text-text-base text-[20px] [font-weight:600]">That didn't work</h1>
              <p class="text-v2-text-text-muted text-[14px]">{s().reason}</p>
              <button class="w-fit rounded-[10px] border border-v2-border-border-base px-4 py-2 text-[14px]" onClick={() => s().retry()}>
                Try again
              </button>
            </div>
          )}
        </Match>
      </Switch>

      {/* Not while the workspace is being made: skipping half-way would leave a folder and no session. */}
      <Show when={step().kind !== "starting" && step().kind !== "signin"}>
        <button class="text-v2-text-text-muted mx-auto w-fit text-[13px] hover:underline" onClick={() => finish("skipped")}>
          Skip — I'll set this up myself
        </button>
      </Show>
    </div>
    </div>
  )
}
