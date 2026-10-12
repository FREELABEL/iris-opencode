import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import "./iris-hive-scripts.css"
import "./iris-hive-machines.css"
import { ago, diskOf, SKILLS, skillsOf, type HiveNodeRow } from "./iris-hive-scripts-model"
import {
  attentionOf,
  fleetSummary,
  gb,
  machinesOf,
  mapLayout,
  readMachinesView,
  specOf,
  statusOf,
  type Computer,
  type HivePeerRow,
  type MachinesView,
} from "./iris-hive-machines-model"
import { focusHiveNode, requestIrisNav } from "./iris-nav"

/**
 * Hive › Machines (heyiris.io/p/hive-panel-directions#pick): your computers as a team — who is
 * online, who can take work, what needs you — with the same fleet as a map one click away.
 */
type IconName = IconProps["name"]
type HivePayload = { measured: boolean; reason?: string | null; nodes: HiveNodeRow[] }
type PeersPayload = { measured: boolean; reason?: string | null; peers: HivePeerRow[] }

const VIEW_KEY = "iris.hive.machines.view"
const MAP_W = 520
const MAP_H = 380

function Ic(props: { name: IconName; title?: string; class?: string }) {
  return (
    <span class={`hsc-ic ${props.class ?? ""}`} title={props.title} aria-hidden={props.title ? undefined : "true"}>
      <Icon name={props.name} size="small" />
    </span>
  )
}

export function IrisHiveMachines(props: {
  doFetch: (path: string, init?: RequestInit) => Promise<Response>
  now?: () => number
}) {
  const now = () => props.now?.() ?? Date.now()
  const getJson = async <T,>(path: string, fallback: T): Promise<T> => {
    try {
      const res = await props.doFetch(path)
      return (await res.json()) as T
    } catch (e) {
      return { ...fallback, reason: e instanceof Error ? e.message : String(e) }
    }
  }
  const [hive, { refetch }] = createResource(() =>
    getJson<HivePayload>("/iris/hive?perPage=200", { measured: false, nodes: [] }),
  )
  const [peerData] = createResource(() => getJson<PeersPayload>("/iris/hive/peers?perPage=100", { measured: false, peers: [] }))
  // Heartbeats move; a minute is fine-grained enough for "online" and "last seen".
  const timer = setInterval(() => void refetch(), 60_000)
  onCleanup(() => clearInterval(timer))

  const computers = createMemo(() => machinesOf(hive.latest?.nodes ?? []))
  const peers = createMemo(() => peerData.latest?.peers ?? [])
  const summary = createMemo(() => fleetSummary(computers(), now()))

  const [view, setViewRaw] = createSignal<MachinesView>(
    readMachinesView(
      (() => {
        try {
          return localStorage.getItem(VIEW_KEY)
        } catch {
          return null
        }
      })(),
    ),
  )
  const setView = (v: MachinesView) => {
    setViewRaw(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {}
  }

  const [openId, setOpenId] = createSignal<string | undefined>()
  const open = createMemo<Computer | undefined>(() => computers().find((c) => c.id === openId()) ?? computers()[0])

  const sendTask = (c: Computer) => {
    focusHiveNode(c.id)
    requestIrisNav({ surface: "hive", sub: "scripts" })
  }
  const [copied, setCopied] = createSignal(false)
  const copyCli = async (c: Computer) => {
    try {
      await navigator.clipboard.writeText(`iris hive nodes show ${c.id}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {}
  }

  return (
    <div class="hsc-wrap">
      <div class="hmc" data-view={view()}>
        <section class="hmc-main" aria-label="Your computers">
          <header class="hmc-top">
            <div class="hmc-sum">
              <span>
                <b class="hsc-num">{summary().online}</b> of <b class="hsc-num">{summary().total}</b> computers online
              </span>
              <Show when={summary().attention}>
                <span class="hmc-att">
                  <Ic name="warning" />
                  <b class="hsc-num">{summary().attention}</b> need{summary().attention === 1 ? "s" : ""} attention
                </span>
              </Show>
            </div>
            <div class="hmc-seg" role="tablist" aria-label="Show as">
              <button type="button" role="tab" aria-selected={view() === "list"} title="Cards" onClick={() => setView("list")}>
                <Ic name="bullet-list" />
                <span>List</span>
              </button>
              <button type="button" role="tab" aria-selected={view() === "map"} title="The network" onClick={() => setView("map")}>
                <Ic name="globe" />
                <span>Map</span>
              </button>
            </div>
          </header>

          <Show when={hive.latest && !hive.latest.measured}>
            <p class="hsc-warn">Could not read your computers{hive.latest!.reason ? ` — ${hive.latest!.reason}` : ""}</p>
          </Show>
          <Show when={hive.latest?.measured && computers().length === 0}>
            <p class="hsc-muted hmc-empty">
              No computers on this account yet. Run <code class="hsc-mono">iris hive connect</code> on one to add it.
            </p>
          </Show>

          <Show when={view() === "list"}>
            <ul class="hmc-cards" role="listbox" aria-label="Computers">
              <For each={computers()}>
                {(c) => {
                  const st = () => statusOf(c, now())
                  const att = () => attentionOf(c, now()).filter((a) => a.level !== "info")
                  const d = () => diskOf(c)
                  return (
                    <li
                      role="option"
                      tabIndex={0}
                      class="hmc-card"
                      aria-selected={open()?.id === c.id}
                      classList={{ off: !c.online }}
                      onClick={() => setOpenId(c.id)}
                      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpenId(c.id)}
                    >
                      <div class="hmc-row">
                        <i class="hsc-dot" classList={{ "hsc-dot--on": c.online, "hsc-dot--off": !c.online }} />
                        <span class="hmc-name" title={c.name}>
                          {c.name}
                        </span>
                        <Show when={c.regs > 1}>
                          <span class="hsc-num hmc-x" title={`Registered ${c.regs} times — same computer`}>
                            ×{c.regs}
                          </span>
                        </Show>
                      </div>
                      <div class="hmc-row">
                        <span class="hmc-status" data-tone={st().tone}>
                          {st().text}
                        </span>
                        <span class="hsc-spacer" />
                        <span class="hsc-num hmc-done" title="Tasks done, all time">
                          {(c.tasksCompleted ?? 0).toLocaleString("en-US")} done
                        </span>
                      </div>
                      <div class="hmc-disk" title={d() ? `${gb(d()!.free)} free of ${gb(d()!.total)}` : "Disk not reported"}>
                        <Show when={d()} fallback={<span class="hmc-faint">disk not reported</span>}>
                          <span class="hmc-bar" data-low={att().some((a) => a.kind === "disk") ? "1" : undefined}>
                            <i style={{ width: `${Math.max(2, 100 - d()!.pct)}%` }} />
                          </span>
                          <span class="hsc-num">{gb(d()!.free)} free</span>
                        </Show>
                      </div>
                      <Show when={skillsOf(c, 4).length}>
                        <div class="hmc-skills">
                          <For each={skillsOf(c, 4)}>{(s) => <Ic name={s.icon as IconName} title={s.word} class="hmc-skill" />}</For>
                        </div>
                      </Show>
                      <For each={att()}>
                        {(a) => (
                          <div class="hmc-chip" data-level={a.level} title={a.fix}>
                            <Ic name="warning" />
                            <span>{a.text}</span>
                          </div>
                        )}
                      </For>
                    </li>
                  )
                }}
              </For>
            </ul>
          </Show>

          <Show when={view() === "map"}>
            <div class="hmc-map">
              <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} role="img" aria-label="Your computers and the people you share with">
                {(() => {
                  const nodes = () => mapLayout(computers(), peers(), MAP_W, MAP_H, now())
                  const you = () => nodes()[0]
                  return (
                    <>
                      <For each={nodes().slice(1)}>
                        {(n) => (
                          <line
                            x1={you().x}
                            y1={you().y}
                            x2={n.x}
                            y2={n.y}
                            class="hmc-edge"
                            data-kind={n.kind}
                            data-on={n.online ? "1" : undefined}
                          />
                        )}
                      </For>
                      <For each={nodes()}>
                        {(n) => (
                          <g
                            class="hmc-node"
                            data-kind={n.kind}
                            data-on={n.online ? "1" : undefined}
                            data-att={n.attention ? "1" : undefined}
                            data-open={n.id === open()?.id ? "1" : undefined}
                            transform={`translate(${n.x} ${n.y})`}
                            onClick={() => n.kind === "computer" && setOpenId(n.id)}
                          >
                            <title>{n.kind === "peer" ? `${n.label} — you share with them` : n.label}</title>
                            <circle r={n.kind === "you" ? 18 : n.kind === "computer" ? 12 : 8} />
                            <text y={n.kind === "you" ? 4 : n.kind === "computer" ? 26 : 20} text-anchor="middle">
                              {n.label.length > 18 ? n.label.slice(0, 17) + "…" : n.label}
                              {n.regs && n.regs > 1 ? ` ×${n.regs}` : ""}
                            </text>
                          </g>
                        )}
                      </For>
                    </>
                  )
                })()}
              </svg>
              <div class="hmc-legend">
                <span><i class="hsc-dot hsc-dot--on" /> online</span>
                <span><i class="hsc-dot hsc-dot--off" /> offline</span>
                <span><i class="hmc-ring" /> needs attention</span>
                <span><i class="hmc-pdot" /> people you share with</span>
              </div>
            </div>
          </Show>
        </section>

        <Show when={open()}>
          {(c) => {
            const att = () => attentionOf(c(), now())
            const st = () => statusOf(c(), now())
            const d = () => diskOf(c())
            return (
              <aside class="hmc-detail" aria-label={c().name}>
                <h3 class="hmc-dname">
                  <i class="hsc-dot" classList={{ "hsc-dot--on": c().online, "hsc-dot--off": !c().online }} />
                  <span title={c().name}>{c().name}</span>
                </h3>
                <p class="hmc-spec">{specOf(c()) || "Hardware not reported"}</p>
                <div class="hmc-acts">
                  <button
                    type="button"
                    class="hmc-btn hmc-btn--go"
                    disabled={!c().online}
                    title={c().online ? "Open Scripts with this computer picked" : "It is offline"}
                    onClick={() => sendTask(c())}
                  >
                    <Ic name="arrow-right" />
                    Send a task
                  </button>
                  <button type="button" class="hmc-btn" title={`iris hive nodes show ${c().id}`} onClick={() => void copyCli(c())}>
                    <Ic name={copied() ? "check" : "copy"} />
                    {copied() ? "Copied" : "CLI command"}
                  </button>
                </div>
                <dl class="hmc-stats">
                  <div>
                    <dt>Tasks done</dt>
                    <dd class="hsc-num">{(c().tasksCompleted ?? 0).toLocaleString("en-US")}</dd>
                  </div>
                  <div>
                    <dt>Slots</dt>
                    <dd class="hsc-num" title={st().text}>
                      {c().online && c().maxConcurrent ? `${c().activeTasks ?? 0}/${c().maxConcurrent} busy` : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Disk</dt>
                    <dd class="hsc-num" data-low={att().some((a) => a.kind === "disk") ? "1" : undefined}>
                      {d() ? `${gb(d()!.free)} free` : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Last seen</dt>
                    <dd class="hsc-num">{c().online ? "now" : ago(c().lastHeartbeat, now())}</dd>
                  </div>
                </dl>
                <Show when={att().length}>
                  <h4>Needs attention</h4>
                  <ul class="hmc-att-list">
                    <For each={att()}>
                      {(a) => (
                        <li data-level={a.level}>
                          <b>{a.text}</b>
                          <span>{a.fix}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <h4>What it can do</h4>
                <Show when={skillsOf(c(), Infinity).length} fallback={<p class="hsc-muted">Nothing reported.</p>}>
                  <ul class="hmc-can">
                    <For each={skillsOf(c(), Infinity)}>
                      {(s) => (
                        <li>
                          <Ic name={s.icon as IconName} />
                          {s.word}
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <details class="hmc-dev">
                  <summary>For developers</summary>
                  <p class="hsc-mono">
                    id {c().id}
                    {c().daemonVersion ? ` · daemon ${c().daemonVersion}` : ""}
                  </p>
                  <Show when={c().regs > 1}>
                    <p class="hsc-mono">also registered as {c().ids.slice(1).join(", ")}</p>
                  </Show>
                  <Show when={(c().capabilities ?? []).some((k) => !SKILLS[k])}>
                    <p class="hsc-mono">runs {(c().capabilities ?? []).filter((k) => !SKILLS[k]).join(", ")}</p>
                  </Show>
                  <Show when={c().hardwareDetectedAt}>
                    <p class="hsc-mono">hardware as of {ago(c().hardwareDetectedAt, now())}</p>
                  </Show>
                </details>
              </aside>
            )
          }}
        </Show>
      </div>
    </div>
  )
}
