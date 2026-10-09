import { createEffect, createSignal, For, on, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import {
  areaTag,
  FILTER_ICON,
  flowSteps,
  HANDS_FILTERS,
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
      <div class="pbf-chips" role="group" aria-label="How hands-off">
        <For each={HANDS_FILTERS}>
          {(f) => (
            <button
              type="button"
              class="pbf-chip"
              aria-pressed={props.value === f.id}
              onClick={() => props.onChange(f.id)}
            >
              <Ic name={FILTER_ICON[f.id]} />
              {f.label}
            </button>
          )}
        </For>
      </div>
      <WhoLegend />
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
          title={props.row.localWhere ? `Installed — ${props.row.localWhere}` : "Installed"}
        >
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

/** One list row: plain title, the outcome, tags, then the strip and "N steps". */
export function PlaybookFlowRow(props: { row: any; onOpen: () => void }) {
  const steps = () => flowSteps(props.row)
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
        <span class="pbf-row__title" classList={{ "pbf-slug": !playbookSlugLine(props.row) }}>
          {playbookTitle(props.row)}
        </span>
        <Show when={playbookSlugLine(props.row)}>{(slug) => <span class="pbf-row__slug pbf-slug">{slug()}</span>}</Show>
        <Show when={outcomeLine(props.row?.description)}>{(o) => <span class="pbf-row__out">{o()}</span>}</Show>
        <span class="pbf-row__meta">
          <PlaybookTags row={props.row} withState />
          {/* A quiet stat — views, never installs (two across the whole catalogue reads as dead). */}
          <Show when={typeof props.row?.views === "number"}>
            <span class="pbf-views" title={`Looked at ${props.row.views.toLocaleString()} times`}>
              <Ic name="eye" />
              <span class="pbf-num">{props.row.views.toLocaleString()}</span>
            </span>
          </Show>
        </span>
      </span>
      <span class="pbf-row__flow">
        <WorkStrip steps={steps()} big />
        <span class="pbf-row__n">
          <Show when={steps().length > 0} fallback="—">
            <Ic name="checklist" />
            {steps().length} step{steps().length === 1 ? "" : "s"}
          </Show>
        </span>
      </span>
    </button>
  )
}

/**
 * The list. NOT YOURS starts at the first row whose owner is not you — the server sorts owned
 * first — and is drawn once, as a heading, rather than badged on every row. It NAMES THE OWNER
 * rather than saying "not yours": on this account every one belongs to user 2945, the same
 * person's second login, and an account number is a fact they can act on.
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
                Owned by another account
                {pb.ownerUserId ? ` · #${pb.ownerUserId}` : ""} — you can run these, not edit them
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
 * "Run it" — nothing in the panel or the sidecar RUNS a playbook; what the panel has always
 * offered is the `iris playbook run` command and the real install. So Run it is install-then-run
 * through those two: when the playbook is not here yet it installs it (the existing install, same
 * endpoint), then copies the run command and shows it. It never claims to have run anything.
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
  const [runNote, setRunNote] = createSignal<"copied" | "manual" | null>(null)
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
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard")
      await navigator.clipboard.writeText(runCommand())
      setRunNote("copied")
    } catch {
      setRunNote("manual")
    }
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
      ["owner", r.ownerUserId != null ? `#${r.ownerUserId}${r.owned ? " (you)" : ""}` : undefined],
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
          <p class="pbf-note" data-tone={r().ok ? undefined : "bad"}>
            {r().message}
          </p>
        )}
      </Show>
      <Show when={runNote()}>
        <p class="pbf-note" data-slot="pbf-run-note">
          {runNote() === "copied" ? "Copied — paste it into a terminal to run it: " : "Run this in a terminal: "}
          <code>{runCommand()}</code>
        </p>
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
