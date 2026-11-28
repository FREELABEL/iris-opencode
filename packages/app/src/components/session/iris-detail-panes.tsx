import { createResource, createSignal, For, type JSX, Match, Show, Switch } from "solid-js"
import { Avatar } from "@opencode-ai/ui/avatar"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DetailView, type DetailFact } from "@opencode-ai/ui/detail-view"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { RelativeTime } from "@opencode-ai/ui/relative-time"
import { Spinner } from "@opencode-ai/ui/spinner"
import { StatusBadge } from "@opencode-ai/ui/status-badge"
import { CommandAction } from "@/components/command-action"
import { useLanguage } from "@/context/language"
import { formatIrisLine } from "@/utils/iris-run"
import { showToast } from "@/utils/toast"
import {
  integrationState,
  paneDetail,
  peerInviteText,
  schemaFieldRows,
  siteOpenUrl,
  type PaneDetail,
  type PaneFact,
} from "./iris-detail-models"
import "./iris-detail-panes.css"

/**
 * The detail views of five IRIS panes, with real actions (#194582): Integrations, Genesis Sites,
 * MCP, Hive Peers, Atlas Schemas. Each was a raw key/value list ending in "copy this command".
 *
 * Where the engine has a route, the button calls it: Reconnect (/iris/integrations/connect),
 * Publish (/iris/site/:id/publish), Revoke (/iris/hive/peers/:id), MCP sign in / on / off (/mcp/…)
 * and Remove (/iris/mcp-remove). The rest run the iris CLI through CommandAction: Test and
 * Disconnect an integration, Accept an invite, Add record. Every write asks first, in words.
 */

type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type T = (key: string, params?: Record<string, string>) => string

export interface IrisPaneDetailProps {
  pane: string
  row: any
  doFetch: Fetch
  /** /mcp routes answer for a folder: add it. */
  withMcpDir: (path: string) => string
  project?: string
  board?: number
  /** Connected tools of the open MCP server, when known. */
  mcpTools?: number
  /** Integrations: start the connect flow again (the pane owns it and its message). */
  onReconnect?: (type: string) => void
  connectNote?: { state: string; message?: string }
  openExternal: (url: string) => void
  /** Show another of the record's tabs. */
  onTab: (id: string) => void
  /** Sites: open the Pages tab ready to add. */
  onAddPage?: () => void
  /** After any change: read the list again. */
  onChanged: () => void
  /** The record is gone (revoked, removed): close it. */
  onGone: (name?: string) => void
}

const post = async (f: Fetch, path: string, method = "POST", body?: unknown): Promise<{ ok: boolean; reason?: string }> => {
  try {
    const res = await f(path, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const j = (await res.json().catch(() => null)) as any
    if (!res.ok) return { ok: false, reason: String(j?.reason ?? j?.message ?? j?.data?.message ?? `IRIS answered ${res.status}`) }
    // /mcp/:name/connect answers a bare boolean; the /iris writes answer {ok, reason}.
    if (typeof j === "boolean") return { ok: j, reason: j ? undefined : "it did not answer yes" }
    return { ok: j?.ok !== false, reason: j?.reason }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

function copy(t: T, text: string, done = t("iris.dv.copied")) {
  void navigator.clipboard
    ?.writeText(text)
    .then(() => showToast({ variant: "success", icon: "check", description: done }))
    .catch(() => showToast({ description: text }))
}

/** A write through an engine route: a confirm in words, then the call, then a toast. */
function ConfirmWrite(props: {
  title: string
  body: string
  confirm: string
  run: () => Promise<{ ok: boolean; reason?: string }>
  done: string
  onDone: () => void
  close: () => void
  t: T
}) {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const go = async () => {
    setBusy(true)
    setError(undefined)
    const r = await props.run().finally(() => setBusy(false))
    if (!r.ok) return setError(props.t("iris.dv.failed", { reason: r.reason ?? "" }))
    showToast({ variant: "success", icon: "circle-check", description: props.done })
    props.close()
    props.onDone()
  }
  return (
    <Dialog fit size="normal" title={props.title} class="command-run-dialog">
      <div data-component="command-run" data-stage="confirm" data-slot="iris-dv-confirm">
        <div data-slot="command-run-confirm">
          <p data-slot="command-run-lead">{props.body}</p>
          <p data-slot="command-run-why">{props.t("iris.dv.confirm.why")}</p>
          <Show when={error()}>
            <p data-slot="iris-dv-error" role="alert">
              {error()}
            </p>
          </Show>
          <div data-slot="command-run-actions">
            <span data-slot="command-run-spacer" />
            <Button type="button" variant="secondary" onClick={props.close}>
              {props.t("iris.dv.cancel")}
            </Button>
            <Button type="button" variant="primary" disabled={busy()} data-autofocus ref={(el: HTMLButtonElement) => requestAnimationFrame(() => el.focus())} onClick={() => void go()}>
              <Show when={busy()} fallback={props.confirm}>
                <Spinner class="command-action-spinner" />
                {props.t("iris.dv.working")}
              </Show>
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

/** The overflow menu beside a detail's buttons: ids live here, never in the copy. */
function Overflow(props: { items: { label: string; run: () => void }[]; t: T }) {
  return (
    <Show when={props.items.length}>
      <DropdownMenu gutter={4} placement="bottom-end">
        <DropdownMenu.Trigger as={IconButton} icon="dot-grid" variant="ghost" size="small" aria-label={props.t("iris.dv.more")} />
        <DropdownMenu.Portal>
          <DropdownMenu.Content>
            <For each={props.items}>
              {(i) => (
                <DropdownMenu.Item onSelect={i.run}>
                  <DropdownMenu.ItemLabel>{i.label}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              )}
            </For>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </Show>
  )
}

function factsOf(d: PaneDetail): DetailFact[] {
  return d.facts.map((f: PaneFact) => ({
    label: f.label,
    numeric: f.numeric,
    wide: f.wide,
    value: f.chips?.length ? (
      <span data-slot="iris-dv-chips">
        <For each={f.chips}>{(c) => <span data-slot="iris-dv-chip">{c}</span>}</For>
      </span>
    ) : f.time ? (
      <RelativeTime value={f.time} />
    ) : (
      f.value
    ),
  }))
}

export function IrisPaneDetail(props: IrisPaneDetailProps) {
  const language = useLanguage()
  const dialog = useDialog()
  const t: T = (k, p) => language.t(k as any, p as any)
  const r = () => props.row
  const d = () => paneDetail(props.pane, r(), t, { tools: props.mcpTools })
  const [busy, setBusy] = createSignal<string>()

  const confirmWrite = (o: { title: string; body: string; confirm: string; done: string; run: () => Promise<{ ok: boolean; reason?: string }>; after?: () => void }) =>
    void dialog.show(() => (
      <ConfirmWrite
        {...o}
        t={t}
        close={() => dialog.close()}
        onDone={() => {
          o.after?.()
          props.onChanged()
        }}
      />
    ))

  /** A reversible action through a route: no confirm, progress on the button, a toast. */
  const act = async (id: string, run: () => Promise<{ ok: boolean; reason?: string }>, done: string) => {
    if (busy()) return
    setBusy(id)
    const res = await run().finally(() => setBusy(undefined))
    showToast(
      res.ok
        ? { variant: "success", icon: "circle-check", description: done }
        : { variant: "error", icon: "warning", description: t("iris.dv.failed", { reason: res.reason ?? "" }) },
    )
    if (res.ok) props.onChanged()
  }
  const busyLabel = (id: string, label: string) => (busy() === id ? t("iris.dv.working") : label)

  const name = () => String(r()?.name ?? "")
  const mcpPath = (verb: string) => props.withMcpDir(`/mcp/${encodeURIComponent(name())}/${verb}`)

  const actions = (): JSX.Element => (
    <Switch>
      <Match when={props.pane === "integrations"}>
        {(() => {
          const state = () => integrationState(r())
          const type = () => String(r()?.type ?? r()?.provider ?? "")
          return (
            <>
              <Show when={type()}>
                <CommandAction
                  command={formatIrisLine(["integrations", "test", type()])}
                  label={t("iris.dv.int.test")}
                  describe={t("iris.dv.int.test.describe", { name: name() })}
                  variant={state() === "attention" ? "secondary" : "primary"}
                  fetch={props.doFetch}
                  base=""
                  onDone={() => props.onChanged()}
                />
                <Button size="small" variant={state() === "attention" || state() === "off" ? "primary" : "secondary"} onClick={() => props.onReconnect?.(type())}>
                  {t("iris.dv.int.reconnect")}
                </Button>
              </Show>
              <Show when={r()?.id != null && r()?.connected}>
                <CommandAction
                  command={formatIrisLine(["integrations", "disconnect", String(r().id)])}
                  label={t("iris.dv.int.disconnect")}
                  describe={t("iris.dv.int.disconnect.describe", { name: name() })}
                  write
                  variant="ghost"
                  fetch={props.doFetch}
                  base=""
                  onDone={(x) => x.ran && x.code === 0 && props.onChanged()}
                />
              </Show>
              <Overflow t={t} items={r()?.id != null ? [{ label: t("iris.dv.copyId"), run: () => copy(t, String(r().id)) }] : []} />
            </>
          )
        })()}
      </Match>

      <Match when={props.pane === "sites"}>
        <Button size="small" variant="secondary" icon="square-arrow-top-right" disabled={!siteOpenUrl(r())} title={siteOpenUrl(r()) ? undefined : t("iris.dv.site.noAddress")} onClick={() => props.openExternal(siteOpenUrl(r())!)}>
          {t("iris.dv.site.open")}
        </Button>
        <Show when={r()?.status !== "published"}>
          <Button
            size="small"
            variant="primary"
            onClick={() =>
              confirmWrite({
                title: t("iris.dv.site.publish.title", { name: name() }),
                body: t("iris.dv.site.publish.body"),
                confirm: t("iris.dv.site.publish.confirm"),
                done: t("iris.dv.site.publish.done", { name: name() }),
                run: () => post(props.doFetch, `/iris/site/${Number(r().id)}/publish`),
              })
            }
          >
            {t("iris.dv.site.publish")}
          </Button>
        </Show>
        <Button size="small" variant="secondary" icon="plus-small" onClick={() => props.onAddPage?.()}>
          {t("iris.dv.site.addPage")}
        </Button>
        <Overflow t={t} items={r()?.id != null ? [{ label: t("iris.dv.copyId"), run: () => copy(t, String(r().id)) }] : []} />
      </Match>

      <Match when={props.pane === "mcp"}>
        <Show when={r()?.status === "needs_auth" || r()?.status === "needs_client_registration" || (r()?.type === "remote" && r()?.status === "failed")}>
          <Button size="small" variant="primary" disabled={!!busy()} onClick={() => void act("auth", () => post(props.doFetch, mcpPath("auth/authenticate")), t("iris.dv.mcp.authenticated", { name: name() }))}>
            {busy() === "auth" ? t("iris.dv.mcp.authenticating") : t("iris.dv.mcp.authenticate")}
          </Button>
        </Show>
        <Show
          when={r()?.status === "connected"}
          fallback={
            <Button size="small" variant={r()?.status === "needs_auth" ? "secondary" : "primary"} disabled={!!busy()} onClick={() => void act("on", () => post(props.doFetch, mcpPath("connect")), t("iris.dv.mcp.enabled", { name: name() }))}>
              {busyLabel("on", t("iris.dv.mcp.enable"))}
            </Button>
          }
        >
          <Button size="small" variant="secondary" disabled={!!busy()} onClick={() => void act("off", () => post(props.doFetch, mcpPath("disconnect")), t("iris.dv.mcp.disabled", { name: name() }))}>
            {busyLabel("off", t("iris.dv.mcp.disable"))}
          </Button>
        </Show>
        <Button
          size="small"
          variant="ghost"
          onClick={() =>
            confirmWrite({
              title: t("iris.dv.mcp.remove.title", { name: name() }),
              body: t("iris.dv.mcp.remove.body"),
              confirm: t("iris.dv.mcp.remove.confirm"),
              done: t("iris.dv.mcp.removed", { name: name() }),
              run: async () => {
                // Stop it first, so its tools are gone now and not at the next project load.
                await post(props.doFetch, mcpPath("disconnect"))
                return post(props.doFetch, "/iris/mcp-remove", "POST", { name: name(), project: props.project })
              },
              after: () => props.onGone(name()),
            })
          }
        >
          {t("iris.dv.mcp.remove")}
        </Button>
      </Match>

      <Match when={props.pane === "peers"}>
        <Show when={r()?.status === "pending" && peerInviteText(r(), t)}>
          {(invite) => (
            <Button size="small" variant="primary" icon="copy" onClick={() => copy(t, invite(), t("iris.dv.peer.inviteCopied"))}>
              {t("iris.dv.peer.copyInvite")}
            </Button>
          )}
        </Show>
        <Show when={r()?.status === "active" || r()?.status === "pending"}>
          <Button
            size="small"
            variant={r()?.status === "pending" ? "ghost" : "secondary"}
            onClick={() => {
              const pending = r().status === "pending"
              confirmWrite({
                title: pending ? t("iris.dv.peer.cancel.title") : t("iris.dv.peer.revoke.title", { name: name() }),
                body: pending ? t("iris.dv.peer.cancel.body") : t("iris.dv.peer.revoke.body"),
                confirm: pending ? t("iris.dv.peer.cancelInvite") : t("iris.dv.peer.revoke"),
                done: t("iris.dv.peer.revoked"),
                run: () => post(props.doFetch, `/iris/hive/peers/${encodeURIComponent(String(r().id))}`, "DELETE"),
                after: () => props.onGone(),
              })
            }}
          >
            {r()?.status === "pending" ? t("iris.dv.peer.cancelInvite") : t("iris.dv.peer.revoke")}
          </Button>
        </Show>
        <PeerAccept doFetch={props.doFetch} onChanged={props.onChanged} variant="ghost" />
        <Overflow t={t} items={r()?.id ? [{ label: t("iris.dv.copyId"), run: () => copy(t, String(r().id)) }] : []} />
      </Match>

      <Match when={props.pane === "schemas"}>
        <Show when={r()?.slug}>
          <CommandAction
            command={addRecordLine(r(), props.board)}
            label={t("iris.dv.schema.addRecord")}
            describe={t("iris.dv.schema.addRecord.describe", { name: name() })}
            editable
            icon="plus-small"
            fetch={props.doFetch}
            base=""
            onDone={(x) => x.ran && x.code === 0 && props.onChanged()}
          />
        </Show>
        <Button size="small" variant="secondary" onClick={() => props.onTab("records")}>
          {t("iris.dv.schema.openRecords")}
        </Button>
        <Overflow t={t} items={r()?.slug ? [{ label: t("iris.dv.copyId"), run: () => copy(t, String(r().slug)) }] : []} />
      </Match>
    </Switch>
  )

  const media = () => {
    if (props.pane === "peers")
      return (
        <Avatar
          size="normal"
          fallback={initials(name())}
          background="color-mix(in srgb, var(--text-base) 10%, transparent)"
          foreground="var(--text-base)"
        />
      )
    if (props.pane === "integrations" && r()?.logoUrl) return <img data-slot="iris-dv-logo" src={r().logoUrl} alt="" aria-hidden="true" />
    return undefined
  }

  return (
    <Show when={d()}>
      {(detail) => (
        <DetailView
          data-slot="iris-record-detail"
          data-pane={props.pane}
          title={detail().title}
          subtitle={detail().subtitle}
          media={media()}
          badge={detail().badge ? <StatusBadge tone={detail().badge!.tone}>{detail().badge!.label}</StatusBadge> : undefined}
          facts={factsOf(detail())}
          actions={actions()}
        >
          <Show when={props.pane === "integrations" && props.connectNote?.message}>
            <p data-slot="iris-dv-note" data-state={props.connectNote!.state}>
              {props.connectNote!.message}
            </p>
          </Show>
          <Show when={props.pane === "schemas"}>
            <SchemaFieldsTable row={r()} t={t} />
          </Show>
        </DetailView>
      )}
    </Show>
  )
}

const initials = (s: string) =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?"

/** The add-record line, prefilled with the schema's own fields (required first) to fill in. */
export function addRecordLine(r: any, board?: number): string {
  const fields: any[] = Array.isArray(r?.fields) ? r.fields : []
  const pick = [...fields.filter((f) => f.required === true), ...fields.filter((f) => f.required !== true)].slice(0, 4)
  const data = JSON.stringify(Object.fromEntries(pick.map((f) => [String(f.key), ""])))
  return formatIrisLine(["atlas:datasets", "records", "add", "--schema", String(r?.slug ?? ""), ...(board != null ? ["--bloq", String(board)] : []), "--data", data])
}

/** Accept a code someone sent: the line opens editable, CODE to replace. */
export function PeerAccept(props: { doFetch: Fetch; onChanged: () => void; variant?: "primary" | "secondary" | "ghost" }) {
  const language = useLanguage()
  return (
    <CommandAction
      command="iris hive accept CODE"
      label={language.t("iris.dv.peer.accept" as any)}
      describe={language.t("iris.dv.peer.accept.describe" as any)}
      editable
      variant={props.variant ?? "secondary"}
      noCopy
      fetch={props.doFetch}
      base=""
      onDone={(x) => x.ran && x.code === 0 && props.onChanged()}
    />
  )
}

/** A schema's fields as a table: what each is called, what kind of value, whether it is required. */
function SchemaFieldsTable(props: { row: any; t: T }) {
  const rows = () => schemaFieldRows(props.row, props.t)
  return (
    <Show when={rows().length} fallback={<p data-slot="iris-dv-note">{props.t("iris.dv.schema.noFields")}</p>}>
      <table data-slot="iris-dv-fields">
        <thead>
          <tr>
            <th scope="col">{props.t("iris.dv.schema.col.name")}</th>
            <th scope="col">{props.t("iris.dv.schema.col.type")}</th>
            <th scope="col">{props.t("iris.dv.schema.col.required")}</th>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(f) => (
              <tr>
                <td>
                  <span data-slot="iris-dv-field-name" title={f.key}>
                    {f.name}
                  </span>
                  <Show when={f.phi}>
                    <StatusBadge tone="warning" size="small">
                      {props.t("iris.dv.schema.phi")}
                    </StatusBadge>
                  </Show>
                </td>
                <td>{f.type}</td>
                <td data-required={f.required ? "" : undefined}>{f.required ? props.t("iris.dv.schema.required") : props.t("iris.dv.schema.optional")}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Show>
  )
}

/**
 * How many tools each connected MCP server gives (#194582) — the row says "12 tools", not "local".
 * One small read per connected server; servers that are off have none to count.
 */
export function useMcpToolCounts(rows: () => any[] | undefined, doFetch: Fetch, withMcpDir: (p: string) => string) {
  const [counts] = createResource(
    () => {
      const names = (rows() ?? []).filter((m) => m?.status === "connected").map((m) => String(m.name))
      return names.length ? names.join("\u0000") : undefined
    },
    async (key) => {
      const out: Record<string, number> = {}
      await Promise.all(
        key.split("\u0000").map(async (n) => {
          const res = await doFetch(withMcpDir(`/mcp/${encodeURIComponent(n)}/tools`)).catch(() => undefined)
          const j = res?.ok ? await res.json().catch(() => null) : null
          if (Array.isArray(j)) out[n] = j.length
        }),
      )
      return out
    },
  )
  return () => counts.latest ?? {}
}
