import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { Check, GmailLogo, InboxArt, OutlookLogo, Spinner } from "./home-first-run-art"
import { SignInPanel } from "./home-first-run-signin"
import type { InboxThread } from "./home-first-run-inbox"
import { GoalAsk, QuestionCard, goalOf, type Capability } from "./home-first-run-question"
import "./home-first-run.css"

/**
 * First run, inside the app (D4 #188245 + D5 #188243, EPIC #188210). Designed end to end in the
 * Genesis prototype first (iris-onboarding-prototype, signed off by Alex 2026-10-09):
 *
 *   1. Sign in             — Google in one click, or an email code
 *   2. Connect             — Gmail / Outlook spotlighted, every one-click integration below. ONE
 *                            connection is enough: it moves on by itself (we POLL; nobody is asked
 *                            to come back and click)
 *   3. What do you want    — their own words. Only now is the inbox touched, and only as evidence:
 *                            a question card (three suggestions from the catalog + `iris intent`,
 *                            "Type your own answer" last) — the session's question-dock shape
 *   →  Session             — ~/IRIS/my-work is created (never a folder picker) and a session opens
 *                            with the goal and the chosen tools already written
 *
 * Engine endpoints: /iris/onboarding/{state,mail,capabilities,workspace,track}, /iris/catalog,
 * /iris/integrations/connect. Every response carries `measured`; when it is false the screen says
 * the reason and offers retry and skip — a spinner that never resolves must not happen here.
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

/**
 * Only an explicit "Skip" keeps first run away. "done" does not: finishing creates a project, and
 * anyone who has a project never sees first run anyway (see showFirstRun in home.tsx). So "done"
 * plus NO project means the project is gone — a reinstall, a wiped ~/.iris, a fresh test HOME —
 * and the right screen for a signed-in person with nothing is onboarding, not an empty project
 * list. The flag lives in WebKit storage, which outlives all three (iris-test17, 2026-10-09).
 */
export function firstRunPending(): boolean {
  try {
    return localStorage.getItem(FIRST_RUN_KEY) !== "skipped"
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
const MAIL = new Set<string>(["gmail", "outlook"])

/** One-click integrations from the engine's catalog, familiar ones first. */
type Chip = { type: string; name: string; logoUrl?: string }
const FIRST = ["google-calendar", "slack", "stripe", "quickbooks", "google-drive", "notion", "instagram", "whatsapp", "hubspot", "dropbox", "linkedin", "google-docs", "mailchimp", "facebook", "canva"]
const rank = (t: string) => (FIRST.indexOf(t) + 1 || 99)

const STEP_INDEX: Record<string, number> = { loading: 0, signin: 0, connect: 1, goal: 2, thinking: 2, ask: 2, starting: 2, error: 2 }
type Step =
  | { kind: "loading" }
  | { kind: "signin" }
  | {
      kind: "connect"
      note?: string
      waiting?: string
      connected?: { type: string; account?: string }
      /** Something connected before this screen opened: shown with Continue, never skipped silently. */
      ready?: { type: string; account?: string }
    }
  | { kind: "goal"; initial?: string }
  | { kind: "thinking"; goal: string }
  | { kind: "ask"; goal: string; capabilities: Capability[]; threads: Thread[] }
  | { kind: "starting" }
  | { kind: "error"; reason: string; retry: () => void }

const POLL_MS = 2000
const POLL_FOR_MS = 5 * 60 * 1000

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
  const [chips, setChips] = createSignal<Chip[]>([])
  const [allChips, setAllChips] = createSignal(false)
  // From state(): whether an inbox is connected, so the inbox is read (as evidence) only if there is one.
  let mailConnected = false

  let poll: ReturnType<typeof setInterval> | undefined
  const stopPoll = () => poll && clearInterval(poll)
  onCleanup(stopPoll)

  const finish = (how: "done" | "skipped") => {
    try {
      localStorage.setItem(FIRST_RUN_KEY, how)
    } catch {}
    props.onDone()
  }

  async function loadChips() {
    const r = await call("/iris/catalog?perPage=200").catch(() => null)
    const rows: any[] = Array.isArray(r?.catalog) ? r.catalog : []
    setChips(
      rows
        // One click only: key and bridge integrations need more than a browser round trip.
        .filter((c) => typeof c?.type === "string" && !MAIL.has(c.type) && c.mode !== "key" && c.mode !== "bridge")
        .map((c) => ({ type: c.type as string, name: String(c.name ?? c.type), logoUrl: c.logoUrl }))
        .sort((x, y) => rank(x.type) - rank(y.type) || x.name.localeCompare(y.name)),
    )
  }

  async function begin() {
    setStep({ kind: "loading" })
    const s = await call("/iris/onboarding/state").catch(() => null)
    if (!s) return setStep({ kind: "error", reason: "IRIS isn't answering yet.", retry: begin })
    if (s.signedIn === false) return waitForSignIn()
    mailConnected = !!s.mail?.connected
    void loadChips()
    const first: string | undefined = s.mail?.connected ? s.mail.type : s.connected?.[0]
    setStep({ kind: "connect", ready: first ? { type: first, account: s.mail?.connected ? s.mail.account : undefined } : undefined })
  }

  const isConnected = (s: any, type: string) =>
    MAIL.has(type) ? s?.mail?.connected && s.mail.type === type : Array.isArray(s?.connected) && s.connected.includes(type)

  async function connect(type: string) {
    setStep({ kind: "connect", waiting: type, note: "Opening your browser…" })
    const r = await post("/iris/integrations/connect", { type }).catch(() => null)
    if (!r?.measured || !r.url) {
      return setStep({ kind: "connect", note: r?.hint ?? r?.reason ?? "Couldn't start the connection. Try again." })
    }
    platform.openExternal(r.url)
    setStep({ kind: "connect", waiting: type, note: "Approve IRIS in your browser. This screen continues on its own." })

    // Poll, don't ask them to come back and click. One connection is enough: it moves on by itself.
    stopPoll()
    const started = Date.now()
    poll = setInterval(async () => {
      if (Date.now() - started > POLL_FOR_MS) {
        stopPoll()
        return setStep({ kind: "connect", note: "Still waiting on your browser. Connect again when you're ready." })
      }
      const s = await call("/iris/onboarding/state").catch(() => null)
      if (isConnected(s, type)) {
        stopPoll()
        mailConnected = !!s.mail?.connected
        track("onboarding.connected", type)
        // Let the person SEE it worked before the screen moves on.
        setStep({ kind: "connect", connected: { type, account: MAIL.has(type) ? s.mail.account : undefined } })
        setTimeout(() => setStep({ kind: "goal" }), 900)
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

  // The goal first; the inbox only now, and only as evidence for what they asked.
  async function ask(goal: string) {
    setStep({ kind: "thinking", goal })
    const id = goalOf(goal)
    track("onboarding.question_answered", `${id}: ${goal.slice(0, 100)}`)
    const [c, m] = await Promise.all([
      post("/iris/onboarding/capabilities", { id, goal }).catch(() => null),
      mailConnected ? call("/iris/onboarding/mail").catch(() => null) : Promise.resolve(null),
    ])
    if (m && !m.measured && /connection|not connected|expired|reconnect|unauthori[sz]ed|invalid_grant/i.test(String(m.reason ?? ""))) {
      // A dead connection is fixed by connecting again, not by retrying.
      return setStep({ kind: "connect", note: "Your mail connection needs renewing. Connect it again to continue." })
    }
    if (m?.measured) track("onboarding.mail_read", String(m.threads?.length ?? 0))
    setStep({
      kind: "ask",
      goal,
      capabilities: Array.isArray(c?.capabilities) ? c.capabilities : [],
      threads: m?.measured && Array.isArray(m.threads) ? m.threads : [],
    })
  }

  async function start(prompt: string, back: Step) {
    setStep({ kind: "starting" })
    const ws = await post("/iris/onboarding/workspace", { name: "my-work" }).catch(() => null)
    if (!ws?.measured || !ws.path) {
      return setStep({ kind: "error", reason: `Couldn't create your workspace: ${ws?.reason ?? "no answer"}`, retry: () => setStep(back) })
    }
    track("onboarding.workspace_created")
    track("onboarding.working")
    // Open the session FIRST, then mark onboarding done. The other order unmounted this screen
    // onto the empty project list for a beat before the session tab appeared.
    props.onStart(ws.path, `${prompt}\n\nUse my connected accounts to read the full details.`)
    finish("done")
  }

  onMount(begin)

  const chev = (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )

  return (
    <div data-component="first-run" class="relative min-h-screen w-full">
      <div class="fr-ambient" aria-hidden="true" />
      <div class="relative mx-auto flex w-full max-w-[640px] flex-col gap-6 px-6 py-14">
        <div class="fr-steps" role="progressbar" aria-valuemin={1} aria-valuemax={3} aria-valuenow={STEP_INDEX[step().kind] + 1}>
          <For each={[0, 1, 2]}>{(i) => <span data-on={i <= STEP_INDEX[step().kind] ? "" : undefined} />}</For>
        </div>
        <Switch>
          <Match when={step().kind === "loading" || step().kind === "starting"}>
            <div class="fr-rise flex flex-col items-center gap-2 text-center">
              <h1 class="text-v2-text-text-base text-[22px] [font-weight:600]">
                {step().kind === "starting" ? "Setting up your workspace…" : "One moment…"}
              </h1>
              <Spinner class="mt-2 text-v2-text-text-muted" />
            </div>
          </Match>

          <Match when={step().kind === "signin"}>
            <div class="fr-rise flex flex-col items-center gap-6 text-center">
              <div class="fr-hero">
                <InboxArt />
              </div>
              <div class="flex flex-col gap-2">
                <h1 class="text-v2-text-text-base text-[26px] leading-tight [font-weight:650]">Sign in to IRIS</h1>
                <p class="text-v2-text-text-muted mx-auto max-w-[440px] text-[15px] leading-relaxed">One click with Google, or a code by email.</p>
              </div>
              <div class="w-full max-w-[400px] text-left">
                <SignInPanel />
              </div>
            </div>
          </Match>

          <Match when={step().kind === "connect" && (step() as Extract<Step, { kind: "connect" }>)}>
            {(s) => {
              const tileState = (type: string) => {
                const c = s()
                if (c.connected) return c.connected.type === type ? "connected" : "idle-other"
                if (c.waiting) return c.waiting === type ? "waiting" : "idle-other"
                if (c.ready?.type === type) return "connected"
                return "idle"
              }
              const shown = () => (allChips() ? chips() : chips().slice(0, 15))
              return (
                <div class="fr-rise flex flex-col gap-6">
                  <div class="flex flex-col gap-2 text-center">
                    <p class="fr-mono text-v2-text-text-muted text-[11.5px] uppercase tracking-[0.14em]">You're signed in</p>
                    <h1 class="text-v2-text-text-base text-[26px] leading-tight [font-weight:650]">Connect your inbox</h1>
                    <p class="text-v2-text-text-muted mx-auto max-w-[460px] text-[15px] leading-relaxed">
                      IRIS reads your mail only for what you ask it to do, and drafts the work for you to approve.
                    </p>
                  </div>

                  <div class="flex flex-col gap-2.5">
                    <p class="fr-label text-center">Start with your inbox</p>
                    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <For each={TILES}>
                        {(t) => (
                          <button
                            class="fr-tile"
                            data-state={tileState(t.type)}
                            disabled={!!s().waiting || !!s().connected}
                            onClick={() => (tileState(t.type) === "connected" ? setStep({ kind: "goal" }) : void connect(t.type))}
                          >
                            <span class="fr-logo">
                              <t.Logo />
                            </span>
                            <span class="flex flex-col gap-0.5">
                              <span class="text-v2-text-text-base text-[16px] [font-weight:600]">
                                {tileState(t.type) === "connected" ? `${t.name} connected` : `Connect ${t.name}`}
                              </span>
                              <span class="text-v2-text-text-muted text-[13px]">
                                <Switch fallback={t.detail}>
                                  <Match when={tileState(t.type) === "waiting"}>Waiting for your browser…</Match>
                                  <Match when={tileState(t.type) === "connected"}>
                                    {s().connected?.account ?? s().ready?.account ?? "Connected"}
                                  </Match>
                                </Switch>
                              </span>
                            </span>
                            <span class="fr-arrow">
                              <Switch fallback={chev}>
                                <Match when={tileState(t.type) === "waiting"}>
                                  <Spinner />
                                </Match>
                                <Match when={tileState(t.type) === "connected"}>
                                  <Check />
                                </Match>
                              </Switch>
                            </span>
                          </button>
                        )}
                      </For>
                    </div>
                  </div>

                  <Show when={chips().length}>
                    <div class="flex flex-col gap-2.5">
                      <div class="flex items-baseline justify-between">
                        <p class="fr-label">Or start with any of {chips().length + TILES.length} integrations</p>
                        <button class="text-[12.5px] text-v2-text-text-muted hover:text-v2-text-text-base" onClick={() => setAllChips(!allChips())}>
                          {allChips() ? "Show less" : "Show all"}
                        </button>
                      </div>
                      <div class="fr-ints" data-open={allChips() ? "" : undefined}>
                        <For each={shown()}>
                          {(c) => (
                            <button
                              class="fr-int"
                              data-state={tileState(c.type)}
                              disabled={!!s().waiting || !!s().connected}
                              onClick={() => (tileState(c.type) === "connected" ? setStep({ kind: "goal" }) : void connect(c.type))}
                            >
                              <span class="fr-int-logo">
                                {c.name.slice(0, 1)}
                                <Show when={c.logoUrl}>
                                  <img src={c.logoUrl} alt="" loading="lazy" onError={(e) => e.currentTarget.remove()} />
                                </Show>
                              </span>
                              {c.name}
                              <Show when={tileState(c.type) === "waiting"}>
                                <Spinner />
                              </Show>
                              <Show when={tileState(c.type) === "connected"}>
                                <Check />
                              </Show>
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>

                  <Show when={s().ready && !s().waiting && !s().connected}>
                    <div class="flex justify-center">
                      <button class="fr-primary px-6" onClick={() => setStep({ kind: "goal" })}>
                        Continue with {s().ready!.account ?? chips().find((c) => c.type === s().ready!.type)?.name ?? s().ready!.type}
                      </button>
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
                      Official sign-in, no passwords
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
              )
            }}
          </Match>

          <Match when={step().kind === "goal" && (step() as Extract<Step, { kind: "goal" }>)}>
            {(s) => (
              <div class="fr-rise flex flex-col gap-6">
                <div class="flex flex-col gap-2 text-center">
                  <h1 class="text-v2-text-text-base text-[26px] leading-tight [font-weight:650]">What should IRIS take off your plate?</h1>
                  <p class="text-v2-text-text-muted mx-auto max-w-[460px] text-[15px] leading-relaxed">
                    Say it in your own words. IRIS uses what you connected only for what you ask.
                  </p>
                </div>
                <GoalAsk initial={s().initial} onAsk={(g) => void ask(g)} />
              </div>
            )}
          </Match>

          <Match when={(step().kind === "thinking" || step().kind === "ask") && (step() as Extract<Step, { kind: "thinking" | "ask" }>)}>
            {(s) => (
              <div class="fr-rise flex flex-col gap-4">
                <button class="fr-asked" onClick={() => setStep({ kind: "goal", initial: s().goal })}>
                  <span class="text-[13px] text-v2-text-text-muted">You asked</span>
                  <span class="min-w-0 flex-1 truncate text-[15px] text-v2-text-text-base [font-weight:600]">“{s().goal}”</span>
                  <span class="fr-mono text-[12px] text-v2-text-text-faint">Edit</span>
                </button>
                <Show
                  when={s().kind === "ask" && (s() as Extract<Step, { kind: "ask" }>)}
                  fallback={
                    <p class="flex items-center justify-center gap-2 text-[13.5px] text-v2-text-text-muted">
                      <Spinner /> {mailConnected ? "Working out what you need, and checking your inbox for it…" : "Working out what you need…"}
                    </p>
                  }
                >
                  {(a) => (
                    <QuestionCard
                      goal={a().goal}
                      capabilities={a().capabilities}
                      threads={a().threads}
                      onSubmit={(prompt) => void start(prompt, a())}
                      onDismiss={() => setStep({ kind: "goal", initial: a().goal })}
                    />
                  )}
                </Show>
              </div>
            )}
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
