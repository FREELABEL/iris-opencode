import { For, Show } from "solid-js"
import { StatusBadge } from "@opencode-ai/ui/status-badge"
import { useLanguage } from "@/context/language"
import { agoLine, displayName, initials, moneyLine, type LeadRow } from "./iris-leads-model"
import { compactMoney, pipelineTotal, stageTone, type PipelineStage } from "./iris-leads-list-model"
import "./iris-leads-list.css"

/**
 * THE LEADS LIST (#194364): what a seller scans for, one lead per row — name strong, company weak,
 * the stage as a badge and the deal value right-aligned in tabular figures — and the pipeline above
 * it: each stage's count and value, a click away from filtering by it.
 */

/** The pipeline strip: one cell per stage. `active` is the stage being filtered on. */
export function LeadsPipeline(props: {
  stages: PipelineStage[]
  active?: string
  onPick?: (status: string | undefined) => void
}) {
  const language = useLanguage()
  const total = () => pipelineTotal(props.stages)
  return (
    <Show when={props.stages.length > 0}>
      <section class="iris-pipe" aria-label={language.t("iris.leads.pipeline.label")} data-slot="iris-leads-pipeline">
        <div class="iris-pipe__head">
          <span class="iris-pipe__title">{language.t("iris.leads.pipeline.label")}</span>
          <span class="iris-pipe__total">
            {language.t(total().count === 1 ? "iris.leads.count.one" : "iris.leads.count.other", { count: total().count.toLocaleString() })}
            <Show when={total().open}>
              {(v) => <> · {language.t("iris.leads.pipeline.open", { value: compactMoney(v()) })}</>}
            </Show>
          </span>
        </div>
        <div class="iris-pipe__cells" role="group">
          <For each={props.stages}>
            {(s) => (
              <button
                type="button"
                class="iris-pipe__cell"
                aria-pressed={props.active === s.status}
                title={language.t("iris.leads.pipeline.filter", { stage: s.status })}
                onClick={() => props.onPick?.(props.active === s.status ? undefined : s.status)}
              >
                <StatusBadge tone={s.tone} size="small" mark="dot">
                  {s.status}
                </StatusBadge>
                <span class="iris-pipe__count">{s.count.toLocaleString()}</span>
                <span class="iris-pipe__value">{s.value ? compactMoney(s.value) : " "}</span>
              </button>
            )}
          </For>
        </div>
      </section>
    </Show>
  )
}

/** One lead. A button row: clicking opens the lead. `selection` adds the bulk-action checkbox. */
export function LeadsListRow(props: {
  lead: LeadRow
  current?: boolean
  onOpen: () => void
  selection?: { checked: boolean; onToggle: () => void; label: string }
}) {
  const company = () => (props.lead.company && props.lead.company !== displayName(props.lead) ? props.lead.company : "")
  const when = () => agoLine(props.lead.updated_at)
  return (
    <div class="iris-lrow" data-slot="iris-lead-row" aria-current={props.current || undefined}>
      <Show when={props.selection}>
        {(sel) => (
          <span class="iris-lrow__cb">
            <input type="checkbox" aria-label={sel().label} checked={sel().checked} onChange={() => sel().onToggle()} />
          </span>
        )}
      </Show>
      <button type="button" class="iris-lrow__open" onClick={() => props.onOpen()}>
        <span class="iris-lrow__av" aria-hidden="true">
          {initials(props.lead)}
        </span>
        <span class="iris-lrow__who">
          <span class="iris-lrow__name">{displayName(props.lead)}</span>
          <span class="iris-lrow__sub">
            {[company(), when()].filter(Boolean).join(" · ")}
          </span>
        </span>
        <span class="iris-lrow__stage">
          <Show when={props.lead.status}>
            <StatusBadge tone={stageTone(props.lead.status)} mark={stageTone(props.lead.status) === "success" ? "✓" : undefined}>
              {props.lead.status}
            </StatusBadge>
          </Show>
        </span>
        <span class="iris-lrow__value">{moneyLine(props.lead.price_bid)}</span>
      </button>
    </div>
  )
}
