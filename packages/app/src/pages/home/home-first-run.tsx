import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"

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

export function firstRunPending(): boolean {
  try {
    return !localStorage.getItem(FIRST_RUN_KEY)
  } catch {
    return false
  }
}

type Thread = { id: string; subject: string; from: string; snippet: string }
type Step =
  | { kind: "loading" }
  | { kind: "connect"; note?: string }
  | { kind: "reading" }
  | { kind: "seen"; threads: Thread[]; waiting: Thread[]; line?: string; industry?: string; choices: string[] }
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
    if (s.mail?.connected) return read()
    setStep({ kind: "connect" })
  }

  async function connect(type: "gmail") {
    const r = await post("/iris/integrations/connect", { type }).catch(() => null)
    if (!r?.measured || !r.url) {
      return setStep({ kind: "connect", note: r?.reason ?? "Couldn't start the connection. Try again." })
    }
    platform.openExternal(r.url)
    setStep({ kind: "connect", note: "Approve IRIS in your browser — this page continues on its own." })

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
        void read()
      }
    }, POLL_MS)
  }

  async function read() {
    setStep({ kind: "reading" })
    const m = await call("/iris/onboarding/mail").catch(() => null)
    if (!m?.measured) {
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
      waiting: m.waiting ?? [],
      line: g?.line,
      industry: g?.industry,
      choices: g?.choices?.length ? g.choices : ["Reply to what's waiting on me", "Summarise my week", "Find what I've missed"],
    })
  }

  async function start(seen: Extract<Step, { kind: "seen" }>, text: string) {
    const want = text.trim()
    if (!want) return
    track("onboarding.question_answered", want.slice(0, 120))
    setStep({ kind: "starting" })

    const ws = await post("/iris/onboarding/workspace", { name: seen.industry || "my-work" }).catch(() => null)
    if (!ws?.measured || !ws.path) {
      return setStep({ kind: "error", reason: `Couldn't create your workspace: ${ws?.reason ?? "no answer"}`, retry: () => setStep(seen) })
    }
    track("onboarding.workspace_created")

    const context = seen.waiting
      .map((t) => `- ${senderName(t.from)}: "${t.subject}" — ${t.snippet.slice(0, 160)}`)
      .join("\n")
    const prompt =
      `${want}\n\nStart with what's waiting on me in my inbox:\n${context}\n\n` +
      `Use my connected email to read the full threads. Draft, don't send.`
    track("onboarding.working")
    finish("done")
    props.onStart(ws.path, prompt)
  }

  onMount(begin)

  return (
    <div class="mx-auto flex w-full max-w-[640px] flex-col gap-6 px-6 py-14">
      <Switch>
        <Match when={step().kind === "loading" || step().kind === "reading" || step().kind === "starting"}>
          <div class="flex flex-col gap-2">
            <h1 class="text-v2-text-text-base text-[22px] [font-weight:600]">
              {step().kind === "reading" ? "Reading your recent mail…" : step().kind === "starting" ? "Setting up your workspace…" : "One moment…"}
            </h1>
            <p class="text-v2-text-text-muted text-[14px]">
              {step().kind === "reading" ? "Only to see what's waiting on you. Nothing is sent." : ""}
            </p>
            <div class="mt-2 h-1 w-full overflow-hidden rounded bg-v2-background-bg-subtle">
              <div class="h-full w-1/3 animate-pulse rounded bg-v2-text-text-muted" />
            </div>
          </div>
        </Match>

        <Match when={step().kind === "connect" && (step() as Extract<Step, { kind: "connect" }>)}>
          {(s) => (
            <div class="flex flex-col gap-4">
              <h1 class="text-v2-text-text-base text-[24px] [font-weight:600]">Connect your inbox</h1>
              <p class="text-v2-text-text-muted text-[15px] leading-relaxed">
                IRIS reads your recent mail to see what's waiting on you, then gets to work on it. It drafts — it
                never sends without you.
              </p>
              <button
                class="rounded-[10px] bg-white px-4 py-3 text-[15px] text-[#1f1f1f] [font-weight:600] hover:bg-[#f1f1f1]"
                onClick={() => void connect("gmail")}
              >
                Connect Gmail
              </button>
              <button disabled class="rounded-[10px] border border-v2-border-border-base px-4 py-3 text-[15px] opacity-50">
                Outlook — coming soon
              </button>
              <Show when={s().note}>
                <p class="text-v2-text-text-muted text-[13px]">{s().note}</p>
              </Show>
            </div>
          )}
        </Match>

        <Match when={step().kind === "seen" && (step() as Extract<Step, { kind: "seen" }>)}>
          {(s) => (
            <div class="flex flex-col gap-5">
              <div class="flex flex-col gap-2">
                <p class="text-v2-text-text-muted text-[13px] uppercase tracking-wide">Here's what I see</p>
                <h1 class="text-v2-text-text-base text-[22px] leading-snug [font-weight:600]">
                  {s().line ?? (s().industry ? `Looks like you work in ${s().industry}.` : "Here's your inbox.")}
                </h1>
              </div>

              <Show when={s().waiting.length}>
                <div class="flex flex-col gap-2">
                  <p class="text-v2-text-text-base text-[14px] [font-weight:530]">
                    {s().waiting.length} {s().waiting.length === 1 ? "thread is" : "threads are"} waiting on you
                  </p>
                  <For each={s().waiting}>
                    {(t) => (
                      <div class="rounded-[10px] border border-v2-border-border-base px-4 py-3">
                        <div class="text-v2-text-text-base text-[14px] [font-weight:530]">{senderName(t.from)}</div>
                        <div class="text-v2-text-text-base text-[14px]">{t.subject}</div>
                        <div class="text-v2-text-text-muted truncate text-[13px]">{t.snippet}</div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <div class="flex flex-col gap-3">
                <p class="text-v2-text-text-base text-[15px] [font-weight:530]">What do you want off your plate first?</p>
                <div class="flex flex-wrap gap-2">
                  <For each={s().choices}>
                    {(c) => (
                      <button
                        class="rounded-full border border-v2-border-border-base px-3 py-1.5 text-[13px] hover:bg-v2-background-bg-subtle"
                        onClick={() => void start(s(), c)}
                      >
                        {c}
                      </button>
                    )}
                  </For>
                </div>
                <form
                  class="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void start(s(), answer())
                  }}
                >
                  <input
                    class="flex-1 rounded-[10px] border border-v2-border-border-base bg-transparent px-3 py-2 text-[14px]"
                    placeholder="Or say it in your own words…"
                    value={answer()}
                    onInput={(e) => setAnswer(e.currentTarget.value)}
                  />
                  <button class="rounded-[10px] bg-v2-text-text-base px-4 py-2 text-[14px] text-v2-background-bg-base [font-weight:600]">
                    Start
                  </button>
                </form>
              </div>
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
      <Show when={step().kind !== "starting"}>
        <button class="text-v2-text-text-muted w-fit text-[13px] hover:underline" onClick={() => finish("skipped")}>
          Skip — I'll open a folder myself
        </button>
      </Show>
    </div>
  )
}
