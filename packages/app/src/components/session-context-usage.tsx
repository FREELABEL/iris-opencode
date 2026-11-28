import { Match, Show, Switch, createMemo, createSignal, type ComponentProps, type JSX } from "solid-js"
import { ProgressCircle } from "@opencode-ai/ui/progress-circle"
import { ProgressCircleV2 } from "@opencode-ai/ui/v2/progress-circle-v2"
import { Button } from "@opencode-ai/ui/button"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { createMediaQuery } from "@solid-primitives/media"

import { useFile } from "@/context/file"
import { useLayout } from "@/context/layout"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useSDK } from "@/context/sdk"
import { getSessionContext } from "@/components/session/session-context-metrics"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"
import { useSettings } from "@/context/settings"
import { Popover } from "@opencode-ai/ui/popover"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { irisPlan, watchIrisPlan } from "@/utils/iris-plan-store"
import { RING_COLOR, RING_TEXT, ringState } from "@/components/usage/usage-model"
import { UsageRings } from "@/components/usage/usage-rings"
import { UsagePopoverBody } from "@/components/usage/usage-popover"
import { DialogUpgrade, plansDialogCopy } from "@/components/dialog-upgrade"

interface SessionContextUsageProps {
  variant?: "button" | "indicator"
  buttonAppearance?: "default" | "v2"
  placement?: ComponentProps<typeof TooltipV2>["placement"]
}

function ContextTooltipRow(props: { name: JSX.Element; value: JSX.Element }) {
  return (
    <div class="flex min-w-0 items-center gap-4">
      <span class="shrink-0 text-v2-text-text-muted">{props.name}</span>
      <span class="ml-auto min-w-0 truncate text-right text-v2-text-text-base">{props.value}</span>
    </div>
  )
}

function openSessionContext(args: {
  view: ReturnType<ReturnType<typeof useLayout>["view"]>
  layout: ReturnType<typeof useLayout>
  tabs: ReturnType<ReturnType<typeof useLayout>["tabs"]>
}) {
  args.view.reviewPanel.open(args.view.reviewPanel.opened() ? "other" : "context-button")
  if (args.layout.fileTree.opened() && args.layout.fileTree.tab() !== "all") args.layout.fileTree.setTab("all")
  void args.tabs.open("context")
  args.tabs.setActive("context")
}

export function SessionContextUsage(props: SessionContextUsageProps) {
  const sync = useSync()
  const file = useFile()
  const layout = useLayout()
  const language = useLanguage()
  const sdk = useSDK()
  const settings = useSettings()
  const providers = useProviders(() => sdk().directory)
  const { params, tabs, view } = useSessionLayout()
  const isDesktop = createMediaQuery("(min-width: 768px)")

  const variant = createMemo(() => props.variant ?? "button")
  const buttonAppearance = createMemo(() => props.buttonAppearance ?? "default")
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
    fileBrowser: () => settings.general.newLayoutDesigns() && isDesktop() && !!params.id,
  })
  const messages = createMemo(() => (params.id ? (sync().data.message[params.id] ?? []) : []))
  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const context = createMemo(() => getSessionContext(messages(), [...providers.all().values()]))
  const cost = createMemo(() => {
    return usd().format(info()?.cost ?? 0)
  })
  const contextVisible = createMemo(() => view().reviewPanel.opened() && tabState.activeTab() === "context")
  const hasOtherTabs = createMemo(() =>
    tabs()
      .all()
      .some((tab) => tab !== "context" && tab !== "review"),
  )

  const openContext = () => {
    if (!params.id) return

    const sessionView = view()
    if (contextVisible()) {
      tabs().close("context")
      if (sessionView.reviewPanel.source() === "context-button" && !hasOtherTabs()) sessionView.reviewPanel.close()
      return
    }

    openSessionContext({
      view: sessionView,
      layout,
      tabs: tabs(),
    })
  }

  const circle = () => (
    <div class="flex items-center justify-center">
      <ProgressCircle
        size={16}
        strokeWidth={2}
        percentage={context()?.usage ?? 0}
        style={
          variant() === "indicator"
            ? {
                "--progress-circle-background": "var(--v2-background-bg-layer-04, var(--border-weak-base))",
                "--progress-circle-background-overlay": "var(--v2-overlay-simple-overlay-pressed, transparent)",
                "--progress-circle-progress": "var(--v2-icon-icon-base, var(--icon-base))",
              }
            : undefined
        }
      />
    </div>
  )
  const circleV2 = () => (
    <div class="flex items-center justify-center">
      <ProgressCircleV2 percentage={context()?.usage ?? 0} />
    </div>
  )

  const tooltipValue = () => (
    <div class="flex w-[120px] flex-col gap-2">
      <ContextTooltipRow name={language.t("context.usage.cost")} value={cost()} />
      <ContextTooltipRow name={language.t("context.usage.usage")} value={`${context()?.usage ?? 0}%`} />
      <ContextTooltipRow
        name={language.t("context.usage.tokens")}
        value={context()?.total.toLocaleString(language.intl()) ?? "0"}
      />
    </div>
  )

  // Your week, around this chat (#194529). The week comes from the one shared /iris/plan read the
  // title bar and the allowance tab use. Unmeasured or unknown → ring is null and everything below
  // renders exactly as before: never a verdict on a loading state.
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const base = createMemo(() => server.current?.http?.url?.replace(/\/$/, ""))
  const doFetch = (path: string, init?: RequestInit) => (platform.fetch ?? globalThis.fetch)(`${base()}${path}`, init)
  const fetchJson = async <T,>(path: string, init?: RequestInit) => (await (await doFetch(path, init)).json()) as T
  if (base()) watchIrisPlan(doFetch)
  const ring = createMemo(() => (variant() === "indicator" ? null : ringState(irisPlan())))
  const [popoverOpen, setPopoverOpen] = createSignal(false)

  const openUpgrade = (paidCopy: boolean) => {
    setPopoverOpen(false)
    const plan = irisPlan()
    const copy = plansDialogCopy(paidCopy ? true : plan?.measured ? plan.paid : undefined)
    dialog.show(() => (
      <DialogUpgrade source="ring" title={copy.title} description={copy.description} usage={plan} fetchJson={fetchJson} />
    ))
  }

  const ringTrigger = () => (
    <span class="flex items-center gap-1.5">
      <UsageRings size={18} week={ring()!.week} context={context()?.usage ?? null} color={RING_COLOR[ring()!.tone]} />
      <Show when={ring()!.label}>
        <span data-slot="usage-ring-label" class={`whitespace-nowrap text-[12px] font-medium ${RING_TEXT[ring()!.tone]}`}>
          {ring()!.label}
        </span>
      </Show>
    </span>
  )

  return (
    <Show when={params.id}>
      <Show
        when={ring()}
        fallback={contextOnly()}
      >
        <Popover
          open={popoverOpen()}
          onOpenChange={setPopoverOpen}
          triggerAs="button"
          triggerProps={{
            type: "button",
            "data-slot": "usage-ring",
            "data-tone": ring()!.tone,
            class: "inline-flex h-7 shrink-0 items-center rounded-md px-1.5 hover:bg-v2-overlay-simple-overlay-hover",
            "aria-label": ring()!.label ? `${ring()!.label} — your week and this chat` : "Your week and this chat",
          } as any}
          trigger={ringTrigger()}
          placement={props.placement === "top" ? "top-start" : "bottom-start"}
          gutter={6}
          class="w-[400px] !max-w-[calc(100vw-40px)] rounded-xl border border-v2-border-border-base !bg-v2-background-bg-layer-01 shadow-lg [&_[data-slot=popover-body]]:p-0"
        >
          <Show when={popoverOpen() && irisPlan()}>
            <UsagePopoverBody
              plan={irisPlan()!}
              context={context() ? { usage: context()!.usage } : undefined}
              fetchJson={fetchJson}
              onUpgrade={() => openUpgrade(false)}
              onPlans={() => openUpgrade(true)}
              onClose={() => setPopoverOpen(false)}
              onContextDetails={() => {
                setPopoverOpen(false)
                if (!contextVisible()) openContext()
              }}
            />
          </Show>
        </Popover>
      </Show>
    </Show>
  )

  function contextOnly() {
    return (
      <TooltipV2 value={tooltipValue()} placement={props.placement ?? "top"} shift={-8}>
        <Switch>
          <Match when={variant() === "indicator"}>{circle()}</Match>
          <Match when={buttonAppearance() === "v2"}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="large"
              icon={circleV2()}
              onClick={openContext}
              aria-label={language.t("context.usage.view")}
            />
          </Match>
          <Match when={true}>
            <Button
              type="button"
              variant="ghost"
              class="size-6"
              onClick={openContext}
              aria-label={language.t("context.usage.view")}
            >
              {circle()}
            </Button>
          </Match>
        </Switch>
      </TooltipV2>
    )
  }
}
