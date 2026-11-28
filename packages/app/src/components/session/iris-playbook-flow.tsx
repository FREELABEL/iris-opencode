import { createEffect, createSignal, For, on, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { openCommandRun, useIrisRunner } from "@/components/command-action"
import { useLanguage } from "@/context/language"
import type { IrisRunResult } from "@/utils/iris-run"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import {
  areaTag,
  FILTER_ICON,
  flowSteps,
  HANDS_FILTERS,
  handsLevel,
  handsTag,
  humanSteps,
  neededPhrase,
  outcomeLine,
  playbookSources,
  playbookSlugLine,
  playbookTitle,
  scopeIcon,
  scopeWords,
  stripLabel,
  updatedAgo,
  WHO_ICON,
  WHO_LABEL,
  type FlowStep,
  type HandsFilter,
} from "./playbook-flow"

/**
 * THE PLAYBOOKS PANEL, "03 Flow" (heyiris.io/p/playbooks-panel-directions).
 *
 * The signature is the work strip: one segment per step, coloured by who does it. It is the one
 * shape only a playbook has, and it answers "will this bother me" at a glance — amber is a step
 * that waits for you. The pure derivations live in ./playbook-flow; this file only draws them.
 */

/**
 * Motion once. Strips fill left-to-right on the panel's FIRST render only — a refetch rebuilds
 * the rows, and a list that re-animates every time it refreshes is noise, not information.
 * Reduced motion is honoured in CSS.
 */
let stripsSettled = false
let settleTimer: ReturnType<typeof setTimeout> | undefined
function claimEntrance(): boolean {
  if (stripsSettled) return false
  if (!settleTimer)
    settleTimer = setTimeout(() => {
      stripsSettled = true
    }, 1200)
  return true
}

/**
 * An icon from the app's own set, sized for where it sits (13px in tags, chips and labels; 14–15px
 * in the legend, buttons and fact tiles) and coloured by its text. Always aria-hidden: the words
 * beside it carry the meaning, so a screen reader hears them once.
 */
export function Ic(props: { name: IconProps["name"] | undefined; size?: 13 | 14 | 15 }) {
  return (
    <Show when={props.name}>
      {(name) => (
        <span class="pbf-ic" style={{ "--pbf-ic": `${props.size ?? 13}px` }} aria-hidden="true" data-icon={name()}>
          <Icon name={name()} size="small" />
        </span>
      )}
    </Show>
  )
}

export function WorkStrip(props: { steps: FlowStep[]; big?: boolean }) {
  const animate = claimEntrance()
  return (
    <Show
      when={props.steps.length > 0}
      fallback={
        // HONEST EMPTY. A local-only or v1 skill publishes no steps; a made-up strip would be a
        // claim about work nobody described.
        <span class="pbf-strip pbf-strip--empty" role="img" aria-label={stripLabel([])} data-slot="pbf-strip">
          steps not published
        </span>
      }
    >
      <span
        class="pbf-strip"
        classList={{ "pbf-strip--big": props.big, "pbf-strip--enter": animate }}
        role="img"
        aria-label={stripLabel(props.steps)}
        data-slot="pbf-strip"
      >
        <For each={props.steps}>
          {(s, i) => (
            <i
              class="pbf-seg"
              data-who={s.who}
              style={{ "--pbf-i": String(Math.min(i(), 8)) }}
              title={`${WHO_LABEL[s.who]} — ${s.title}`}
            />
          )}
        </For>
      </span>
    </Show>
  )
}

export function WhoLegend() {
  return (
    <div class="pbf-legend" aria-label="What the colours mean">
      <For each={["think", "auto", "you"] as const}>
        {(w) => (
          <span class="pbf-leg" data-who={w}>
            <Ic name={WHO_ICON[w]} size={14} />
            {WHO_LABEL[w]}
          </span>
        )}
      </For>
    </div>
  )
}

/**
 * The chips above the list: how hands-off. Buttons with aria-pressed. The count line shows only
 * while a chip is narrowing, so a filtered page never reads as the whole set.
 */
export function PlaybookFilters(props: {
  value: HandsFilter
  onChange: (f: HandsFilter) => void
  shown: number
  total: number
}) {
  return (
    <div class="pbf-filters shrink-0" data-slot="pbf-filters">
      {/* One segmented control (#191697). No icons and no legend: each row's dots say it. */}
      <div class="pbf-segctl" role="group" aria-label="How hands-off">
        <For each={HANDS_FILTERS}>
          {(f) => (
            <button type="button" aria-pressed={props.value === f.id} onClick={() => props.onChange(f.id)}>
              {f.label}
            </button>
          )}
        </For>
      </div>
      <Show when={props.value !== "any"}>
        <p class="pbf-count">
          {props.shown} of {props.total} loaded
        </p>
      </Show>
    </div>
  )
}

/** The tags every playbook surface shares: area (only if carried), hands-off, scope, and state. */
export function PlaybookTags(props: { row: any; withState?: boolean }) {
  const hands = () => handsTag(props.row)
  return (
    <span class="pbf-tags">
      <Show when={areaTag(props.row)}>{(a) => <span class="pbf-tag pbf-tag--area">{a()}</span>}</Show>
      <Show when={hands()}>
        {(h) => (
          <span class="pbf-tag" data-tone={h().tone}>
            <Ic name={h().tone === "you" ? WHO_ICON.you : WHO_ICON.auto} />
            {h().label}
          </span>
        )}
      </Show>
      <Show when={scopeWords(props.row?.scope)}>
        {(s) => (
          <span class="pbf-tag" title={`Who can see it (${props.row.scope})`}>
            <Ic name={scopeIcon(props.row.scope)} />
            {s()}
          </span>
        )}
      </Show>
      <Show when={props.withState && props.row?.hasLocal}>
        <span
          class="pbf-tag pbf-tag--state"
          data-state={props.row.action === "update" ? "update" : "installed"}
          title={props.row.localWhere ? `Installed — ${props.row.localWhere}` : "Installed"}
        >
          <Ic name={props.row.action === "update" ? "arrow-up" : "check"} size={13} />
          {props.row.action === "update" ? `Update · v${props.row.version}` : "Installed"}
        </span>
      </Show>
      <Show when={props.withState && props.row?.attached}>
        <span class="pbf-tag pbf-tag--state" title="Attached to this board">
          ★ This board
        </span>
      </Show>
      {/* All only: where this row comes from — "why is this here" is the question a union raises. */}
      {/* Only when it comes from more than one place — a lone "account" tag on every row is noise. */}
      <Show when={props.withState && (props.row?.sources?.length ?? 0) > 1}>
        <span class="pbf-tag pbf-tag--src" data-slot="iris-playbook-sources" title="Where this playbook comes from">
          {playbookSources(props.row)}
        </span>
      </Show>
    </span>
  )
}

/**
 * One list row (#191697): the name and one line of what it does on the left; on the right, how
 * hands-off it is as three dots and a word, with the step count under it. That is all a row
 * says. The work strip, the tags and the view count live on the playbook's own page, where there
 * is room for them; in the list they were seven things to read per row.
 */
export function PlaybookFlowRow(props: { row: any; onOpen: () => void }) {
  const steps = () => flowSteps(props.row)
  const level = () => handsLevel(props.row)
  // Who can see it and whether you have it: an icon each, the words on hover (Alex, 2026-10-29).
  const scope = () => {
    const words = scopeWords(props.row?.scope)
    return words ? { words, icon: scopeIcon(props.row.scope) } : undefined
  }
  const state = () =>
    props.row?.hasLocal
      ? props.row.action === "update"
        ? { words: `Update available · v${props.row.version}`, icon: "arrow-up" as const }
        : { words: "Installed", icon: "check" as const }
      : undefined
  return (
    <button
      type="button"
      class="pbf-row"
      classList={{ "pbf-row--theirs": !props.row?.owned }}
      title={props.row?.name}
      data-slot="pbf-row"
      data-name={props.row?.name}
      onClick={() => props.onOpen()}
    >
      <span class="pbf-row__main">
        <span class="pbf-row__head">
          <span class="pbf-row__title">{playbookTitle(props.row)}</span>
          <Show when={scope()}>
            {(sc) => (
              <span class="pbf-row__icon" title={`Who can see it: ${sc().words}`} aria-label={`Who can see it: ${sc().words}`}>
                <Ic name={sc().icon} />
              </span>
            )}
          </Show>
          <Show when={state()}>
            {(st) => (
              <span
                class="pbf-row__icon"
                data-state={props.row.action === "update" ? "update" : "installed"}
                title={props.row.localWhere ? `${st().words} — ${props.row.localWhere}` : st().words}
                aria-label={st().words}
              >
                <Ic name={st().icon} />
              </span>
            )}
          </Show>
        </span>
        <Show when={outcomeLine(props.row?.description)}>{(o) => <span class="pbf-row__out">{o()}</span>}</Show>
      </span>
      <span class="pbf-row__side">
        <Show when={level()} fallback={<span class="pbf-ind pbf-ind--none">No steps listed</span>}>
          {(lv) => (
            <span class="pbf-ind" data-tone={lv().tone} title={handsTag(props.row)?.label}>
              <span class="pbf-dots" aria-hidden="true">
                <For each={[1, 2, 3]}>{(n) => <i classList={{ on: n <= lv().filled }} />}</For>
              </span>
              {lv().label}
            </span>
          )}
        </Show>
        <Show when={steps().length > 0}>
          <span class="pbf-row__n">
            {steps().length} step{steps().length === 1 ? "" : "s"}
          </span>
        </Show>
      </span>
    </button>
  )
}

/**
 * The list. NOT YOURS starts at the first row whose owner is not you — the server sorts owned
 * first — and is drawn once, as a heading, rather than badged on every row.
 *
 * It does NOT print the owner's account number (#194360). It used to, for one person with two
 * logins; on every other account the marketplace is someone else's, and the heading showed the
 * platform owner's user id to every customer. Another account's id is never shown.
 */
export function PlaybookFlowList(props: {
  rows: any[]
  total: number
  filter: HandsFilter
  onOpen: (row: any) => void
  onReset: () => void
}) {
  return (
    <div class="pbf-list" data-slot="pbf-list">
      <For each={props.rows}>
        {(pb, i) => (
          <>
            <Show when={!pb.owned && (i() === 0 || props.rows[i() - 1]?.owned)}>
              <h4 class="pbf-group">
                Owned by another account — you can run these, not edit them
              </h4>
            </Show>
            <PlaybookFlowRow row={pb} onOpen={() => props.onOpen(pb)} />
          </>
        )}
      </For>
      {/* The chips emptied a list that has rows — say so, and offer the way back. */}
      <Show when={props.total > 0 && props.rows.length === 0}>
        <p class="pbf-none">
          None of the {props.total} loaded here{" "}
          {props.filter === "auto"
            ? "run fully on their own"
            : props.filter === "once"
              ? "ask you exactly once"
              : "ask you more than once"}
          .{" "}
          <button type="button" class="pbf-link" onClick={() => props.onReset()}>
            Show anything
          </button>
        </p>
      </Show>
    </div>
  )
}

/**
 * The Info tab of an open playbook — replaces the key/value table.
 *
 * "Run it" RUNS it (#194583): when the playbook is not here yet it installs it (the existing
 * install, same endpoint), then `iris playbook run <name>` goes through the engine's command
 * runner (`POST /iris/run`) — a write, so the person confirms it first, in words. A playbook that
 * needs values opens its line to fill them in. The result (exit, output) is shown in the dialog
 * and summarised under the button. The runner has no terminal: a step that waits for a person
 * stops there and says so, and a run longer than its time limit is reported as timed out.
 */
export function PlaybookFlowInfo(props: {
  row: any
  button: { label: string; force: boolean; warn?: string } | null
  command: string
  installing: boolean
  installResult: { ok: boolean; message: string } | null
  projectDir?: string
  onInstall: (force: boolean) => Promise<boolean>
}) {
  const steps = () => flowSteps(props.row)
  const you = () => humanSteps(props.row)
  const runCommand = () => `iris playbook run ${props.row?.name}`
  const language = useLanguage()
  const dialog = useDialog()
  const runner = useIrisRunner()
  const [runNote, setRunNote] = createSignal<IrisRunResult | null>(null)
  createEffect(
    on(
      () => props.row?.name,
      () => setRunNote(null),
      { defer: true },
    ),
  )

  const needsInstall = () => props.button != null && !props.button.force
  const addLabel = () => {
    const b = props.button
    if (!b) return ""
    if (b.force) return b.label
    return props.projectDir ? "Add to this project" : "Add to my playbooks"
  }

  async function run() {
    if (props.installing) return
    if (needsInstall()) {
      const ok = await props.onInstall(false)
      if (!ok) return
    }
    const needsValues = neededPhrase(props.row?.args) !== "Nothing"
    openCommandRun(dialog, {
      line: runCommand(),
      start: needsValues ? "edit" : "confirm",
      describe: language.t(needsValues ? "iris.playbook.run.describeArgs" : "iris.playbook.run.describe", {
        name: playbookTitle(props.row) || String(props.row?.name ?? ""),
      }),
      run: runner,
      t: language.t,
      onDone: (r) => setRunNote(r),
    })
  }

  const devFields = (): [string, string][] => {
    const r = props.row ?? {}
    const out: [string, unknown][] = [
      ["name", r.name],
      ["version", r.version],
      ["installed here", r.hasLocal ? (r.localWhere ? `yes — ${r.localWhere}` : "yes") : "no"],
      ["installed version", r.installedVersion],
      ["local edits", r.edited ? "yes" : undefined],
      ["found in", r.sources?.length ? playbookSources(r) : undefined],
      ["scope", r.scope],
      ["access", r.accessType],
      ["active", r.active == null ? undefined : String(r.active)],
      // Yours or not — never another account's id (#194360).
      ["owner", r.owned ? "you" : r.ownerUserId != null ? "another account" : undefined],
      ["landing page", r.publicUrl],
    ]
    return out.filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)])
  }

  return (
    <div class="pbf-detail" data-slot="pbf-detail">
      <Show when={props.row?.description}>
        <p class="pbf-detail__out">{props.row.description}</p>
      </Show>
      <PlaybookTags row={props.row} withState />

      <div class="pbf-actions" data-slot="iris-playbook-install">
        <Button size="small" variant="primary" class="pbf-run" disabled={props.installing} onClick={() => void run()}>
          <Ic name="play" size={14} />
          {props.installing && needsInstall() ? "Adding…" : "Run it"}
        </Button>
        <Show when={props.button}>
          <Button
            size="small"
            variant="secondary"
            disabled={props.installing}
            onClick={() => void props.onInstall(props.button!.force)}
          >
            <Ic name="plus" size={14} />
            {props.installing ? "Adding…" : addLabel()}
          </Button>
        </Show>
        <span class="pbf-need">
          You'll need: <b>{neededPhrase(props.row?.args)}</b>
        </span>
      </div>
      <Show when={props.button?.warn}>
        <p class="pbf-note" data-tone="bad">
          {props.button!.warn}
        </p>
      </Show>
      <Show when={props.installResult}>
        {(r) => (
          <p class="pbf-note pbf-note--result" data-tone={r().ok ? "good" : "bad"} role="status">
            <Ic name={r().ok ? "check" : "circle-x"} size={14} />
            <span>{r().message}</span>
          </p>
        )}
      </Show>
      <Show when={runNote()}>
        {(r) => {
          const ok = () => r().ran && r().code === 0 && !r().timedOut
          return (
            <p class="pbf-note pbf-note--result" data-slot="pbf-run-note" data-tone={ok() ? "good" : "bad"} role="status">
              <Ic name={ok() ? "check" : "circle-x"} size={14} />
              <span>
                {ok()
                  ? language.t("iris.playbook.run.ok")
                  : r().timedOut
                    ? language.t("iris.playbook.run.timedOut")
                    : r().refused
                      ? r().refused
                      : language.t("iris.playbook.run.failed", { code: String(r().code ?? "—") })}
              </span>
            </p>
          )
        }}
      </Show>

      <dl class="pbf-facts">
        <div>
          <dt>
            <Ic name="checklist" size={14} />
            Steps
          </dt>
          <dd class="pbf-num">{steps().length || "—"}</dd>
        </div>
        <div>
          <dt data-who="you">
            <Ic name={WHO_ICON.you} size={14} />
            Needs you
          </dt>
          <dd classList={{ "pbf-num": you() > 0 }}>
            {steps().length === 0 ? "—" : you() === 0 ? "Never" : `${you()}×`}
          </dd>
        </div>
        <div>
          <dt>
            <Ic name="eye" size={14} />
            Looked at
          </dt>
          <dd class="pbf-num">{typeof props.row?.views === "number" ? props.row.views.toLocaleString() : "—"}</dd>
        </div>
        <div>
          <dt>
            <Ic name="clock" size={14} />
            Updated
          </dt>
          <dd title={props.row?.publishedAt}>{updatedAgo(props.row?.publishedAt) ?? "—"}</dd>
        </div>
      </dl>

      <h5 class="pbf-h">How it works</h5>
      <Show
        when={steps().length > 0}
        fallback={
          <p class="pbf-note">
            This playbook doesn't publish its steps. The Document tab has the full write-up when it is installed or
            published.
          </p>
        }
      >
        <ol class="pbf-steps">
          <For each={steps()}>
            {(s, i) => (
              <li class="pbf-step" data-who={s.who}>
                <span class="pbf-step__n">{i() + 1}</span>
                <span class="pbf-step__t">{s.title}</span>
                <span class="pbf-step__who">
                  <Ic name={WHO_ICON[s.who]} />
                  {WHO_LABEL[s.who]}
                </span>
              </li>
            )}
          </For>
        </ol>
      </Show>

      <details class="pbf-dev">
        <summary>
          <Ic name="code" />
          For developers
        </summary>
        <button
          type="button"
          class="iris-command"
          title="Click to copy"
          onClick={() => navigator.clipboard?.writeText(props.command)}
        >
          {props.command}
        </button>
        <Show when={props.command !== runCommand()}>
          <button
            type="button"
            class="iris-command"
            title="Click to copy"
            onClick={() => navigator.clipboard?.writeText(runCommand())}
          >
            {runCommand()}
          </button>
        </Show>
        <dl class="pbf-devlist">
          <For each={devFields()}>
            {([k, v]) => (
              <>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </>
            )}
          </For>
        </dl>
      </details>
    </div>
  )
}
