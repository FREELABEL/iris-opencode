import { createSignal, For, Show } from "solid-js"
import "./iris-leads-add.css"
import { Button } from "@opencode-ai/ui/button"
import { Notice } from "@opencode-ai/ui/notice"
import { Select } from "@opencode-ai/ui/select"
import { Spinner } from "@opencode-ai/ui/spinner"
import { StatusBadge } from "@opencode-ai/ui/status-badge"
import { TextField } from "@opencode-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { PaneDialog, PaneDialogActions } from "./iris-pane-dialog"
import type { Answer, Op } from "./iris-leads"
import type { LeadRow } from "./iris-leads-model"
import {
  EMPTY_FORM,
  fieldKey,
  fileProblem,
  groupReasons,
  NEW_LEAD_STAGES,
  newLeadBody,
  newLeadProblem,
  rowState,
  valueColumns,
  type ImportPreview,
  type ImportResult,
  type NewLeadForm,
} from "./iris-leads-add-model"

/**
 * New lead (#194506): the Leads tab's form, through the engine's leads route (`op: create`). Name or
 * email is enough. fl-api upserts by email, so an address it already has is said out loud and the
 * existing lead offered, rather than reported as added.
 */
export function NewLeadDialog(props: {
  open: boolean
  bloqId: number
  call: (o: Op) => Promise<Answer>
  onClose: () => void
  /** A lead was added (or matched): the list re-reads, and the lead can be opened. */
  onAdded: (lead: LeadRow, opened: boolean) => void
}) {
  const language = useLanguage()
  const [form, setForm] = createSignal<NewLeadForm>({ ...EMPTY_FORM })
  const [tried, setTried] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [matched, setMatched] = createSignal<LeadRow>()
  const set = (k: keyof NewLeadForm) => (v: string) => {
    setForm({ ...form(), [k]: v })
    setMatched(undefined)
    setError(undefined)
  }
  const problem = () => newLeadProblem(form())
  const close = () => {
    setForm({ ...EMPTY_FORM })
    setTried(false)
    setError(undefined)
    setMatched(undefined)
    props.onClose()
  }
  async function submit(e?: Event) {
    e?.preventDefault()
    setTried(true)
    if (problem() || busy()) return
    setBusy(true)
    setError(undefined)
    const r = await props.call({ op: "create", body: newLeadBody(form(), props.bloqId) })
    setBusy(false)
    if (!r.measured) return setError(r.reason ?? language.t("iris.leads.new.failed"))
    const lead = r.data?.lead as LeadRow
    if (r.data?.matchedExisting) {
      setMatched(lead)
      props.onAdded(lead, false)
      return
    }
    showToast({ variant: "success", title: language.t("iris.leads.new.added", { name: lead?.name ?? form().name }) })
    props.onAdded(lead, false)
    close()
  }

  return (
    <PaneDialog when={props.open ? true : undefined} onClose={close} title={() => language.t("iris.leads.new.title")} id="iris-lead-new" size="normal">
      {() => (
        <form class="iris-la-form" onSubmit={submit} novalidate>
          <p class="iris-la-hint">{language.t("iris.leads.new.hint")}</p>
          <div class="iris-la-grid">
            <TextField label={language.t("iris.leads.field.name")} value={form().name} onChange={set("name")} autofocus />
            <TextField label={language.t("iris.leads.field.company")} value={form().company} onChange={set("company")} />
            <TextField
              type="email"
              label={language.t("iris.leads.field.email")}
              value={form().email}
              onChange={set("email")}
              error={tried() && problem() === "iris.leads.new.badEmail" ? language.t("iris.leads.new.badEmail") : undefined}
            />
            <TextField
              inputMode="decimal"
              label={language.t("iris.leads.field.value")}
              placeholder="0"
              value={form().value}
              onChange={set("value")}
              error={tried() && problem() === "iris.leads.new.badValue" ? language.t("iris.leads.new.badValue") : undefined}
            />
            <div class="iris-la-select">
              <span id="iris-la-stage">{language.t("iris.leads.field.stage")}</span>
              <Select
                size="normal"
                options={[...NEW_LEAD_STAGES]}
                current={form().stage}
                onSelect={(x) => x && set("stage")(x)}
                aria-labelledby="iris-la-stage"
                triggerProps={{ "data-slot": "iris-la-stage" }}
              />
            </div>
          </div>
          <Show when={tried() && problem() === "iris.leads.new.need"}>
            <Notice tone="warning" role="alert">{language.t("iris.leads.new.need")}</Notice>
          </Show>
          <Show when={error()}>
            <Notice tone="critical" role="alert">{error()}</Notice>
          </Show>
          <Show when={matched()}>
            {(m) => (
              <Notice
                tone="info"
                role="status"
                action={
                  <Button size="small" type="button" onClick={() => (props.onAdded(m(), true), close())}>
                    {language.t("iris.leads.new.openMatched", { name: m().name ?? "" })}
                  </Button>
                }
              >
                {language.t("iris.leads.new.matched", { email: form().email, name: m().name ?? "" })}
              </Notice>
            )}
          </Show>
          <PaneDialogActions>
            <Button size="small" type="button" onClick={close}>
              {language.t("common.cancel")}
            </Button>
            <Button size="small" variant="primary" type="submit" disabled={busy()} data-slot="iris-la-add">
              <Show when={busy()}>
                <Spinner class="iris-ui-spin" />
              </Show>
              {busy() ? language.t("iris.leads.new.adding") : language.t("iris.leads.new.add")}
            </Button>
          </PaneDialogActions>
        </form>
      )}
    </PaneDialog>
  )
}

/**
 * Import (#194506): pick a CSV, see how its columns map and what happens to each row, then import.
 * The engine reads the file both times (`importPreview`, then `import`) with the CLI's mapping, so
 * the preview is exactly what is sent. The result says what was added, updated and skipped, and why.
 */
export function ImportLeadsDialog(props: {
  open: boolean
  bloqId: number
  call: (o: Op) => Promise<Answer>
  onClose: () => void
  onImported: (result: ImportResult) => void
}) {
  const language = useLanguage()
  const [file, setFile] = createSignal<{ name: string; csv: string }>()
  const [preview, setPreview] = createSignal<ImportPreview>()
  const [result, setResult] = createSignal<ImportResult>()
  const [busy, setBusy] = createSignal<"reading" | "importing">()
  const [error, setError] = createSignal<string>()
  let input: HTMLInputElement | undefined
  const reset = () => {
    setFile(undefined)
    setPreview(undefined)
    setResult(undefined)
    setError(undefined)
    if (input) input.value = ""
  }
  const close = () => {
    reset()
    props.onClose()
  }

  async function pick(f: File | undefined) {
    if (!f) return
    reset()
    const bad = fileProblem(f)
    if (bad) return setError(language.t(bad))
    setBusy("reading")
    const csv = await f.text()
    const r = await props.call({ op: "importPreview", body: { csv } })
    setBusy(undefined)
    if (!r.measured) return setError(r.reason ?? language.t("iris.leads.import.unreadable"))
    setFile({ name: f.name, csv })
    setPreview(r.data as ImportPreview)
  }

  async function go() {
    const f = file()
    if (!f || busy()) return
    setBusy("importing")
    setError(undefined)
    const r = await props.call({ op: "import", body: { csv: f.csv, bloqId: props.bloqId } })
    setBusy(undefined)
    if (!r.measured) return setError(r.reason ?? language.t("iris.leads.import.failed"))
    const res = r.data as ImportResult
    setResult(res)
    props.onImported(res)
    if (res.created > 0) showToast({ variant: "success", title: language.plural("iris.leads.import.toast", res.created, { count: res.created }) })
  }

  const Reasons = (p: { list: { row: number; reason: string }[]; head: string; tone: "warning" | "critical" }) => (
    <Show when={p.list.length > 0}>
      <div class="iris-la-reasons" data-tone={p.tone}>
        <b>{p.head}</b>
        <ul>
          <For each={groupReasons(p.list)}>
            {(g) => (
              <li>
                <span class="iris-la-rows">{language.plural("iris.leads.import.rows", g.rows.length + g.more, { rows: g.rows.join(", ") + (g.more ? ` +${g.more}` : "") })}</span>
                <span>{g.reason}</span>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  )

  return (
    <PaneDialog when={props.open ? true : undefined} onClose={close} title={() => language.t("iris.leads.import.title")} id="iris-lead-import" size="large">
      {() => (
        <div class="iris-la-import">
          <input
            ref={input}
            type="file"
            accept=".csv,text/csv"
            class="iris-la-file"
            aria-label={language.t("iris.leads.import.pick")}
            onChange={(e) => void pick(e.currentTarget.files?.[0])}
          />
          <Show when={error()}>
            <Notice tone="critical" role="alert">{error()}</Notice>
          </Show>

          {/* 1. Pick */}
          <Show when={!preview() && !result()}>
            <p class="iris-la-hint">{language.t("iris.leads.import.intro")}</p>
            <div class="iris-la-drop">
              <Button size="normal" variant="primary" icon="cloud-upload" disabled={!!busy()} onClick={() => input?.click()}>
                {busy() === "reading" ? language.t("iris.leads.import.reading") : language.t("iris.leads.import.pick")}
              </Button>
              <span>{language.t("iris.leads.import.pickNote")}</span>
            </div>
            <PaneDialogActions>
              <Button size="small" onClick={close}>
                {language.t("common.cancel")}
              </Button>
            </PaneDialogActions>
          </Show>

          {/* 2. Preview: the columns as mapped, the first rows, every skip and note */}
          <Show when={!result() && preview()}>
            {(p) => (
              <div class="iris-la-preview" data-slot="import-preview">
                <div class="iris-la-file-line">
                  <b>{file()?.name}</b>
                  <span>
                    {language.t("iris.leads.import.summary", { total: p().total, ready: p().ready, skipped: p().skipped.length, noted: p().warnings.length })}
                  </span>
                </div>
                <div class="iris-la-cols" aria-label={language.t("iris.leads.import.columns")}>
                  <For each={p().columns}>
                    {(c) => (
                      <span class="iris-la-col" data-unused={c.field ? undefined : ""}>
                        {c.column} <span aria-hidden="true">→</span>{" "}
                        <b>{fieldKey(c.field) ? language.t(fieldKey(c.field)!) : language.t("iris.leads.import.notImported")}</b>
                      </span>
                    )}
                  </For>
                </div>
                <div class="iris-la-scroll">
                <Show when={valueColumns(p().columns).length > 0}>
                  <Notice tone="info" data-slot="import-novalue">
                    {language.t("iris.leads.import.noValue", { columns: valueColumns(p().columns).join(", ") })}
                  </Notice>
                </Show>
                <table class="iris-la-table">
                  <thead>
                    <tr>
                      <th>{language.t("iris.leads.import.row")}</th>
                      <th>{language.t("iris.leads.field.name")}</th>
                      <th>{language.t("iris.leads.field.email")}</th>
                      <th>{language.t("iris.leads.field.company")}</th>
                      <th>{language.t("iris.leads.field.stage")}</th>
                      <th>{language.t("iris.leads.import.what")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={p().rows}>
                      {(r) => (
                        <tr data-tone={rowState(r).tone}>
                          <td class="num">{r.row}</td>
                          <td>{r.lead?.name ?? "—"}</td>
                          <td>{r.lead?.email ?? ""}</td>
                          <td>{r.lead?.company ?? ""}</td>
                          <td>{r.error ? "" : (r.lead?.status ?? language.t("iris.leads.import.defaultStage"))}</td>
                          <td>
                            <StatusBadge size="small" tone={rowState(r).tone} title={rowState(r).text}>
                              {r.error ? language.t("iris.leads.import.skip") : r.warning ? language.t("iris.leads.import.note") : language.t("iris.leads.import.ready")}
                            </StatusBadge>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
                <Show when={p().total > p().rows.length}>
                  <span class="iris-la-more">{language.t("iris.leads.import.more", { count: p().total - p().rows.length })}</span>
                </Show>
                <Reasons list={p().skipped} head={language.t("iris.leads.import.skippedHead")} tone="critical" />
                <Reasons list={p().warnings} head={language.t("iris.leads.import.notesHead")} tone="warning" />
                </div>
                <PaneDialogActions>
                  <Button size="small" onClick={close}>
                    {language.t("common.cancel")}
                  </Button>
                  <Button size="small" disabled={!!busy()} onClick={() => input?.click()}>
                    {language.t("iris.leads.import.other")}
                  </Button>
                  <Button size="small" variant="primary" disabled={!!busy() || p().ready === 0} onClick={() => void go()}>
                    <Show when={busy() === "importing"}>
                      <Spinner class="iris-ui-spin" />
                    </Show>
                    {busy() === "importing" ? language.t("iris.leads.import.importing") : language.plural("iris.leads.import.go", p().ready, { count: p().ready })}
                  </Button>
                </PaneDialogActions>
              </div>
            )}
          </Show>

          {/* 3. What happened */}
          <Show when={result()}>
            {(r) => (
              <div class="iris-la-result" data-slot="import-result" role="status">
                <div class="iris-la-tally">
                  <div>
                    <b>{r().created}</b>
                    <span>{language.t("iris.leads.import.added")}</span>
                  </div>
                  <div>
                    <b>{r().merged}</b>
                    <span>{language.t("iris.leads.import.updated")}</span>
                  </div>
                  <div>
                    <b>{r().skipped.length}</b>
                    <span>{language.t("iris.leads.import.skipped")}</span>
                  </div>
                </div>
                <Show when={r().stopped}>
                  <Notice tone="warning">{r().stopped}</Notice>
                </Show>
                <Reasons list={r().skipped} head={language.t("iris.leads.import.skippedWhy")} tone="critical" />
                <Reasons list={r().warnings} head={language.t("iris.leads.import.notesHead")} tone="warning" />
                <PaneDialogActions>
                  <Button size="small" onClick={reset}>
                    {language.t("iris.leads.import.another")}
                  </Button>
                  <Button size="small" variant="primary" onClick={close}>
                    {language.t("iris.leads.import.done")}
                  </Button>
                </PaneDialogActions>
              </div>
            )}
          </Show>
        </div>
      )}
    </PaneDialog>
  )
}
