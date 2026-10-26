// @ts-nocheck — preview harness, not shipped.
import { render } from "solid-js/web"
import { createSignal, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import "@/index.css"
import "@/components/prompt-input-glow.css"
import { PromptInputV2 } from "@opencode-ai/session-ui/v2/prompt-input"
import { createPromptInputV2Controller } from "@opencode-ai/session-ui/v2/prompt-input/interaction"
import { createPromptInputV2Store } from "@opencode-ai/session-ui/v2/prompt-input/store"
import { NotificationBellView } from "@/components/notification-bell"
import { bellRows } from "@/components/notification-bell-model"

/**
 * Renders the REAL message box (session-ui PromptInputV2) with the REAL bell (NotificationBellView)
 * and fixture rows (#190993). `?step=` picks: rest | open | rise | working | quiet. Data is fictional.
 */
const step = new URLSearchParams(location.search).get("step") ?? "rest"

const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
const waiting = [
  { id: "1", from: "Maria Lopez <maria@example.com>", subject: "Rescheduling Thursday's cleaning", snippet: "Is anything open Friday morning instead?", date: ago(0.7) },
  { id: "2", from: "Dev Patel <dev@example.com>", subject: "Question about my insurance claim", snippet: "Could you resend it?", date: ago(27) },
  { id: "3", from: "Apex Dental Supply <billing@apex.example>", subject: "Invoice #4471 — overdue", snippet: "Due September 30", date: ago(5) },
  { id: "4", from: "Jordan Lee <jordan@example.com>", subject: "Saturday", snippet: "Can you cover the front desk?", date: ago(2) },
]
const work = [
  { id: "s1", title: "Friday newsletter", subagent: false, retrying: false },
  { id: "s2", title: "Sort October receipts", parent: "Books", subagent: true, retrying: false },
]
const rowsFor = (s: string, extra = 0) =>
  s === "quiet"
    ? []
    : s === "working"
      ? bellRows({ waiting: [], work, hiveUnread: 0 })
      : bellRows({ waiting: waiting.slice(0, 3 + extra), work, hiveUnread: 2, hiveFrom: "Kristen" })

function Composer() {
  const state = createStore({ prompt: [{ type: "text", content: "", start: 0, end: 0 }], cursor: 0, model: { providerID: "iris", modelID: "iris-ai", variant: null }, context: { items: [] } })
  const store = createPromptInputV2Store(state)
  const controller = createPromptInputV2Controller({
    store: state,
    commands: () => [],
    context: () => [],
    searchContextFiles: () => [],
    view: {
      add: { onAttach: () => {} },
      model: { options: () => [{ id: "iris-ai", label: "IRIS AI", providerID: "iris" }], current: () => "iris-ai", onSelect: () => {} },
      submit: { stopping: () => false, working: () => false, onSubmit: () => store.reset(), onStop: () => {} },
    },
  })
  const [rows, setRows] = createSignal(rowsFor(step))
  const [swing, setSwing] = createSignal(0)
  const [open, setOpen] = createSignal(step === "open")
  onMount(() => {
    if (step !== "rise") return
    setTimeout(() => {
      setRows(rowsFor(step, 1))
      setSwing(1)
    }, 900)
  })
  return (
    <div class="iris-glow" style={{ "--iris-glow-ring": "4s", "--iris-glow-under": "6s" }}>
      <PromptInputV2
        controller={controller}
        transcribeUrl={() => location.origin}
        dictateShortcut="Ctrl+Shift+Space"
        notifications={
          <NotificationBellView
            rows={rows()}
            working={rows().some((r) => r.kind === "work")}
            swing={swing()}
            open={open()}
            onOpenChange={setOpen}
            onChoose={() => setOpen(false)}
          />
        }
      />
    </div>
  )
}

render(
  () => (
    <div class="min-h-screen bg-v2-background-bg-base text-v2-text-text-base flex flex-col">
      <div class="flex-1 w-full max-w-[760px] mx-auto px-6 pt-10 flex flex-col gap-5 text-[14px] leading-6">
        <div class="flex justify-end">
          <div class="rounded-2xl px-4 py-2.5 bg-v2-background-bg-weak">Draft the newsletter for Friday</div>
        </div>
        <div>Here's a first draft of Friday's newsletter: three sections, about 300 words…</div>
      </div>
      <div class="w-full max-w-[760px] mx-auto px-3 pb-6">
        <Composer />
      </div>
    </div>
  ),
  document.getElementById("root")!,
)
