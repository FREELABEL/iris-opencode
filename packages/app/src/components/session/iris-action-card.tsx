import { createMemo } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { ActionCard } from "@opencode-ai/ui/action-card"
import { registerToolActionCard } from "@opencode-ai/session-ui/message-part"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSessionLayout } from "@/pages/session/session-layout"
import { describeAgentAction, type AgentAction } from "./iris-agent-actions"
import { irisNames } from "./iris-names"
import { requestIrisNav } from "./iris-nav"
import "./iris-action-card.css"

/**
 * The chat's card for an agent's IRIS write (#194362): "Added Ethan Okafor — Blue Mesa Yoga ($40k)"
 * to "Atlas › Call today", an Open that shows it in the side panel, and the command behind
 * "Command". Registered with the commands row; reads and other commands stay in the fold.
 */

const ICON: Record<AgentAction["icon"], string> = {
  plus: "+",
  move: "→",
  edit: "✎",
  note: "✎",
  publish: "↗",
  remove: "×",
  run: "▸",
}

function tryUse<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

function statusOf(part: ToolPart): "running" | "done" | "failed" {
  const st = part.state
  if (st.status === "pending" || st.status === "running") return "running"
  if (st.status === "error") return "failed"
  const exit = (st as { metadata?: { exit?: unknown } }).metadata?.exit
  return typeof exit === "number" && exit !== 0 ? "failed" : "done"
}

function IrisActionCard(props: { part: ToolPart }) {
  const language = useLanguage()
  const layout = tryUse(() => useLayout())
  const session = tryUse(() => useSessionLayout())
  const action = createMemo(() => describeAgentAction(props.part, irisNames))
  const open = () => {
    const nav = action()?.nav
    if (!nav) return
    requestIrisNav({ surface: nav.surface, sub: nav.sub, bloqId: nav.bloqId })
    if (!session || !layout) return
    // Same steps as the Atlas and Genesis cards: open the side panel on the IRIS tab.
    session.view().reviewPanel.open("other")
    if (layout.fileTree.opened() && layout.fileTree.tab() !== "all") layout.fileTree.setTab("all")
    void session.tabs().open("iris")
    session.tabs().setActive("iris")
  }
  return (
    <ActionCard
      data-slot="iris-action-card"
      icon={ICON[action()?.icon ?? "edit"]}
      status={statusOf(props.part)}
      title={action()?.title ?? ""}
      target={action()?.target}
      detail={action()?.command}
      detailLabel={language.t("iris.action.command")}
      onOpen={action()?.nav ? open : undefined}
      openLabel={language.t("iris.action.open")}
    />
  )
}

registerToolActionCard({
  // Finished or running writes only; a write that has not started yet has nothing to say.
  accepts: (part) => part.state.status !== "pending" && !!describeAgentAction(part, irisNames),
  render: IrisActionCard,
})
