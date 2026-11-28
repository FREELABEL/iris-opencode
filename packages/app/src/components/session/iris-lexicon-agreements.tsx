import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { EmptyState } from "@opencode-ai/ui/empty-state"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Notice } from "@opencode-ai/ui/notice"
import { Select } from "@opencode-ai/ui/select"
import { SkeletonRows } from "@opencode-ai/ui/skeleton"
import { Spinner } from "@opencode-ai/ui/spinner"
import { StatusBadge } from "@opencode-ai/ui/status-badge"
import { Tabs } from "@opencode-ai/ui/tabs"
import { TextField } from "@opencode-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import { PaneDialog, PaneDialogActions, statusTone } from "./iris-pane-dialog"
import "./iris-pane-layout.css"
import "./iris-lexicon-agreements.css"
import {
  AGREEMENT_TYPES,
  BUCKET_WORD,
  BUCKETS,
  canRevoke,
  caseOf,
  emptyRaise,
  issueBlock,
  issueVerb,
  matches,
  raisePayload,
  raiseProblem,
  recipients,
  shortHash,
  stateWord,
  tally,
  toneOf,
  trailWord,
  waitLine,
  type Agreement,
  type AgreementDetail,
  type Bucket,
  type RaiseForm,
} from "./iris-lexicon-agreements-model"

/**
 * Lexicon › Agreements (#192484, epic #192479): engagement letters, fee agreements, releases and the
 * rest, filed against cases — the Desktop face of `iris lexicon agreements`.
 *
 * TWO THINGS HERE REACH SOMEONE OUTSIDE THE FIRM: Issue (emails a signing link) and Revoke (withdraws
 * access they relied on). Neither runs from one click — each opens a confirm that names who receives
 * it. Raise only ever saves a draft. There is no Sign: a signature must be the signer's own.
 *
 * Drawn with the ui library (#194375 W5): Button, IconButton, Tabs, StatusBadge, Notice, EmptyState,
 * TextField, Select and PaneDialog → Dialog. The words that come from the model (states, buckets,
 * the reasons Issue is blocked) stay there: its tests assert them.
 */
type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type ListPayload = { measured: boolean; reason?: string; summary?: Record<string, number>; agreements: Agreement[] }
type DetailPayload = { measured: boolean; reason?: string } & AgreementDetail
type ActionPayload = { measured: boolean; reason?: string; agreement: Agreement | null }
type Confirm = { kind: "issue" | "revoke"; a: Agreement }
const TYPE_OPTIONS = [...AGREEMENT_TYPES]

export function IrisLexiconAgreements(props: { doFetch: Fetch; initialCase?: string }) {
  const language = useLanguage()
  const [caseDraft, setCaseDraft] = createSignal(props.initialCase ?? "")
  const [caseRef, setCaseRef] = createSignal(props.initialCase ?? "")
  const [bucket, setBucket] = createSignal<Bucket>("all")
  const [selected, setSelected] = createSignal<number>()
  const [raising, setRaising] = createSignal<RaiseForm>()
  const [confirm, setConfirm] = createSignal<Confirm>()
  const [reason, setReason] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [note, setNote] = createSignal<string>()

  const readJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const res = await props.doFetch(path, init)
    const body = (await res.json().catch(() => null)) as T | null
    if (!body) throw new Error(`HTTP ${res.status}`)
    return body
  }

  // An object, not the string: "" (every case) is falsy, and a falsy source never fetches.
  const [list, { refetch: refetchList }] = createResource(() => ({ c: caseRef() }), async ({ c }): Promise<ListPayload> => {
    try {
      return await readJson<ListPayload>(`/iris/agreements${c.trim() ? `?case=${encodeURIComponent(c.trim())}` : ""}`)
    } catch (e: any) {
      return { measured: false, reason: e?.message ?? String(e), agreements: [] }
    }
  })
  const [detail, { refetch: refetchDetail }] = createResource(selected, async (id): Promise<DetailPayload> => {
    try {
      return await readJson<DetailPayload>(`/iris/agreements/${id}`)
    } catch (e: any) {
      return { measured: false, reason: e?.message ?? String(e), agreement: null, document: null, seal: null, trail: [] }
    }
  })

  const rows = createMemo(() => list.latest?.agreements ?? [])
  const counts = createMemo(() => tally(rows()))
  const visible = createMemo(() => rows().filter((a) => matches(a, bucket())))
  // The row is what we have instantly; the detail call adds the document and the trail.
  const current = createMemo(() => {
    const id = selected()
    const d = detail.latest
    if (d?.agreement && d.agreement.id === id) return d.agreement
    return rows().find((a) => a.id === id)
  })

  createEffect(() => {
    if (selected() === undefined && !raising() && visible()[0]) setSelected(visible()[0].id)
  })

  function applyCase(e?: Event) {
    e?.preventDefault()
    setSelected(undefined)
    setCaseRef(caseDraft().trim())
  }

  async function act(path: string, body: unknown, done: (a: Agreement | null) => string): Promise<Agreement | null | false> {
    setBusy(true)
    setError(undefined)
    setNote(undefined)
    try {
      const r = await readJson<ActionPayload>(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      })
      if (!r.measured) {
        setError(r.reason ?? language.t("iris.lexicon.refused"))
        return false
      }
      setNote(done(r.agreement))
      await refetchList()
      if (selected() !== undefined) await refetchDetail()
      return r.agreement
    } catch (e: any) {
      setError(e?.message ?? String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function submitRaise(e: Event) {
    e.preventDefault()
    const f = raising()
    if (!f) return
    const problem = raiseProblem(f)
    if (problem) return setError(problem)
    const a = await act("/iris/agreements", raisePayload(f), (x) =>
      language.t("iris.lexicon.note.raised", { id: x?.id ?? "?", name: f.name.trim() }),
    )
    if (a === false) return
    setRaising(undefined)
    if (f.case.trim() !== caseRef()) {
      setCaseDraft(f.case.trim())
      setCaseRef(f.case.trim())
    }
    if (a) setSelected(a.id)
  }

  async function runConfirm() {
    const c = confirm()
    if (!c) return
    const who = c.a.counterparty
    if (c.kind === "issue") {
      const ok = await act(`/iris/agreements/${c.a.id}/issue`, {}, () => language.t("iris.lexicon.note.issued", { name: who }))
      if (ok !== false) setConfirm(undefined)
      return
    }
    if (!reason().trim()) return setError(language.t("iris.lexicon.error.sayWhy"))
    const ok = await act(`/iris/agreements/${c.a.id}/revoke`, { reason: reason().trim() }, () =>
      language.t("iris.lexicon.note.revoked", { name: who }),
    )
    if (ok !== false) setConfirm(undefined)
  }

  function openConfirm(kind: Confirm["kind"], a: Agreement) {
    setError(undefined)
    setReason("")
    setConfirm({ kind, a })
  }

  const setField = (k: keyof RaiseForm) => (value: string) => setRaising((f) => (f ? { ...f, [k]: value } : f))

  return (
    <div class="iris-ui iris-lex" data-slot="iris-lexicon-agreements">
      <form class="iris-ui-bar iris-lex-head" onSubmit={applyCase}>
        <label class="iris-ui-search iris-lex-search">
          <Icon name="magnifying-glass" size="small" />
          <input
            aria-label={language.t("iris.lexicon.case")}
            placeholder={language.t("iris.lexicon.case.placeholder")}
            value={caseDraft()}
            onInput={(e) => setCaseDraft(e.currentTarget.value)}
            onBlur={() => caseDraft().trim() !== caseRef() && applyCase()}
          />
          <Show when={caseDraft()}>
            <IconButton
              type="button"
              icon="close-small"
              variant="ghost"
              size="small"
              title={language.t("iris.lexicon.case.every")}
              aria-label={language.t("iris.lexicon.case.clear")}
              onClick={() => {
                setCaseDraft("")
                applyCase()
              }}
            />
          </Show>
        </label>
        <span class="iris-lex-meta">
          <Show when={list.latest?.measured && list.latest.summary}>
            {(s) => (
              <>
                {language.t("iris.lexicon.summary", { awaiting: s().awaiting ?? 0, executed: s().executed ?? 0 })}
                <Show when={(s().expiringSoon ?? 0) > 0}>
                  {" · "}
                  <span data-tone="warn">{language.t("iris.lexicon.expiring", { count: s().expiringSoon ?? 0 })}</span>
                </Show>
              </>
            )}
          </Show>
        </span>
        <span class="iris-ui-spacer" />
        <Button
          type="button"
          variant="ghost"
          size="small"
          class="iris-lex-iconbtn"
          title={language.t("iris.lexicon.refresh")}
          aria-label={language.t("iris.lexicon.refresh")}
          disabled={list.loading}
          onClick={() => refetchList()}
        >
          <Show when={list.loading} fallback={<Icon name="refresh" size="small" />}>
            <Spinner class="iris-ui-spin" />
          </Show>
        </Button>
        <Button
          type="button"
          variant="primary"
          size="small"
          icon="plus-small"
          onClick={() => {
            setError(undefined)
            setNote(undefined)
            setConfirm(undefined)
            setRaising(emptyRaise(caseRef()))
          }}
        >
          {language.t("iris.lexicon.raise")}
        </Button>
      </form>

      {/* While a confirm is open its own copy of the error shows inside it: the dialog covers this one. */}
      <Show when={error() && !confirm()}>
        <Notice class="iris-lex-notice" tone="critical" role="alert" icon={<Icon name="warning" size="small" />}>
          {error()}
        </Notice>
      </Show>
      <Show when={note()}>
        <Notice class="iris-lex-notice" tone="success" role="status" icon={<Icon name="circle-check" size="small" />}>
          {note()}
        </Notice>
      </Show>

      <div class="iris-lex-filters">
        <Tabs
          variant="pill"
          size="small"
          value={bucket()}
          onChange={(v: string) => {
            setBucket(v as Bucket)
            setSelected(undefined)
          }}
        >
          <Tabs.List aria-label={language.t("iris.lexicon.filter.label")}>
            <For each={BUCKETS}>
              {(b) => (
                <Tabs.Trigger value={b}>
                  {BUCKET_WORD[b]}
                  <span class="n">{counts()[b]}</span>
                </Tabs.Trigger>
              )}
            </For>
          </Tabs.List>
        </Tabs>
      </div>

      <div class="iris-lex-body">
        <div class="iris-lex-list" role="listbox" aria-label={language.t("iris.lexicon.list.label")}>
          <Show
            when={list.latest?.measured !== false}
            fallback={
              <EmptyState
                size="small"
                icon={<Icon name="warning" size="small" />}
                title={language.t("iris.lexicon.error.list", { reason: list.latest?.reason ?? "" })}
              />
            }
          >
            <Show
              when={!(list.loading && !list.latest)}
              fallback={<SkeletonRows rows={5} label={language.t("iris.lexicon.loading")} />}
            >
              <For
                each={visible()}
                fallback={
                  <EmptyState
                    size="small"
                    title={
                      caseRef()
                        ? bucket() === "all"
                          ? language.t("iris.lexicon.empty.case", { case: caseRef() })
                          : language.t("iris.lexicon.empty.caseIn", { case: caseRef(), bucket: BUCKET_WORD[bucket()] })
                        : language.t("iris.lexicon.empty.none")
                    }
                  />
                }
              >
                {(a) => (
                  <button
                    type="button"
                    class="iris-lex-row"
                    role="option"
                    data-id={a.id}
                    aria-selected={!raising() && selected() === a.id}
                    onClick={() => {
                      setRaising(undefined)
                      setSelected(a.id)
                    }}
                  >
                    <div class="iris-lex-row-top">
                      <span class="iris-lex-row-name">{a.counterparty}</span>
                      <StatusBadge size="small" tone={statusTone(toneOf(a))}>
                        {stateWord(a)}
                      </StatusBadge>
                    </div>
                    <div class="iris-lex-row-sub">
                      {a.kind ?? a.type}
                      <Show when={caseOf(a.subjectRef)}>{(c) => <> · {language.t("iris.lexicon.row.case", { case: c() })}</>}</Show>
                      <Show when={waitLine(a)}>{(w) => <> · {w()}</>}</Show>
                    </div>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </div>

        <div class="iris-lex-detail">
          <Show when={!raising()} fallback={RaisePane()}>
            <Show when={current()} fallback={<EmptyState size="small" title={language.t("iris.lexicon.pick")} />}>
              {(a) => DetailPane(a)}
            </Show>
          </Show>
        </div>
      </div>

      <PaneDialog
        when={confirm()}
        onClose={() => setConfirm(undefined)}
        class="iris-lex-dialog"
        id="iris-lex-confirm"
        title={(c) =>
          c.kind === "issue"
            ? language.t("iris.lexicon.confirm.issue.title", { verb: issueVerb(c.a) })
            : language.t("iris.lexicon.confirm.revoke.title")
        }
      >
        {(c) => ConfirmBody(c)}
      </PaneDialog>
    </div>
  )

  function DetailPane(a: () => Agreement) {
    const d = () => (detail.latest?.agreement?.id === a().id ? detail.latest : undefined)
    const blocked = () => issueBlock(a())
    return (
      <>
        <div class="iris-lex-title">
          <div>
            <div class="iris-lex-name">{a().counterparty}</div>
            <div class="iris-lex-sub">{[a().kind ?? a().type, a().org].filter(Boolean).join(" · ")}</div>
          </div>
          <StatusBadge size="small" tone={statusTone(toneOf(a()))}>
            {stateWord(a())}
          </StatusBadge>
        </div>

        <Show when={waitLine(a())}>
          {(w) => (
            <Notice class="iris-lex-notice" tone={statusTone(toneOf(a()))} icon={<Icon name="clock" size="small" />}>
              {w()}
            </Notice>
          )}
        </Show>

        <dl class="iris-lex-fields">
          <Show when={caseOf(a().subjectRef)}>
            <dt>{language.t("iris.lexicon.field.case")}</dt>
            <dd>{caseOf(a().subjectRef)}</dd>
          </Show>
          <dt>{language.t("iris.lexicon.field.between")}</dt>
          <dd>{language.t("iris.lexicon.field.betweenValue", { from: a().disclosingParty ?? "—", to: a().counterparty })}</dd>
          <dt>{language.t("iris.lexicon.field.email")}</dt>
          <dd>{a().email ?? "—"}</dd>
          <Show when={a().issuedAt}>
            <dt>{language.t("iris.lexicon.field.issued")}</dt>
            <dd>{a().issuedAt}</dd>
          </Show>
          <Show when={a().executedAt}>
            <dt>{language.t("iris.lexicon.field.executed")}</dt>
            <dd>{a().executedAt}</dd>
          </Show>
          <Show when={a().revokedAt}>
            <dt>{language.t("iris.lexicon.field.revoked")}</dt>
            <dd>{a().revokedAt}</dd>
          </Show>
          <dt>{language.t("iris.lexicon.field.expires")}</dt>
          <dd>{a().expiryDate ?? language.t("iris.lexicon.field.noExpiry")}</dd>
          <dt>{language.t("iris.lexicon.field.seal")}</dt>
          <dd>
            <Show when={d()?.seal} fallback={shortHash(a().documentHash) ?? language.t("iris.lexicon.seal.unsealed")}>
              {(s) => (
                <span data-tone={s().status === "intact" ? "good" : s().status === "mismatch" ? "bad" : undefined}>
                  {s().status === "intact"
                    ? language.t("iris.lexicon.seal.intact", { hash: shortHash(s().chain) ?? "" })
                    : s().status === "mismatch"
                      ? language.t("iris.lexicon.seal.mismatch")
                      : (s().detail ?? language.t("iris.lexicon.seal.unsealed"))}
                </span>
              )}
            </Show>
          </dd>
        </dl>

        <Show when={a().partyLinks.length > 1}>
          <div class="iris-lex-section">
            {language.t("iris.lexicon.parties", { signed: a().partiesSigned, total: a().partiesTotal })}
          </div>
          <ul class="iris-lex-parties">
            <For each={a().partyLinks}>
              {(p) => (
                <li>
                  <span class="iris-ui-ic" aria-hidden="true">
                    <Icon name={p.status === "signed" ? "circle-check" : "clock"} size="small" />
                  </span>
                  <span class="iris-lex-party-name">{p.name ?? "—"}</span>
                  <span class="iris-lex-weak">{p.role}</span>
                  <span class="iris-lex-weak" data-tone={p.status === "signed" ? "good" : undefined}>
                    {p.status}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <Show when={detail.loading && !d()}>
          <div class="iris-ui-center">
            <Spinner class="iris-ui-spin" />
          </div>
        </Show>
        <Show when={detail.latest && !detail.latest.measured && selected() === a().id}>
          <Notice class="iris-lex-notice" tone="critical" icon={<Icon name="warning" size="small" />}>
            {language.t("iris.lexicon.error.document", { reason: detail.latest!.reason ?? "" })}
          </Notice>
        </Show>

        <Show when={d()?.document}>
          {(doc) => (
            <details class="iris-lex-doc">
              <summary>
                <span class="iris-ui-ic" aria-hidden="true">
                  <Icon name="open-file" size="small" />
                </span>
                {doc().reference ?? doc().title ?? language.t("iris.lexicon.document")}
              </summary>
              <Show when={doc().preamble}>
                <p class="iris-lex-doc-pre">{doc().preamble}</p>
              </Show>
              <ol>
                <For each={doc().clauses}>
                  {(c) => (
                    <li>
                      <Show when={c.heading}>
                        <strong>{c.heading}</strong>{" "}
                      </Show>
                      {c.body}
                    </li>
                  )}
                </For>
              </ol>
              <Show when={doc().recordNote}>
                <p class="iris-lex-weak">{doc().recordNote}</p>
              </Show>
            </details>
          )}
        </Show>

        <Show when={(d()?.trail.length ?? 0) > 0}>
          <div class="iris-lex-section">{language.t("iris.lexicon.trail")}</div>
          <ol class="iris-lex-trail">
            <For each={d()!.trail}>
              {(e) => (
                <li>
                  <span>{trailWord(e.action)}</span>
                  <span class="iris-lex-weak">{e.at ?? ""}</span>
                </li>
              )}
            </For>
          </ol>
        </Show>

        <div class="iris-lex-actions">
          <Button
            type="button"
            variant="primary"
            size="small"
            icon="send"
            disabled={busy() || !!blocked()}
            title={blocked() ?? language.t("iris.lexicon.issue.title", { name: a().counterparty })}
            onClick={() => openConfirm("issue", a())}
          >
            {issueVerb(a())}
          </Button>
          <Show when={canRevoke(a())}>
            <Button
              type="button"
              size="small"
              icon="circle-ban-sign"
              disabled={busy()}
              title={language.t("iris.lexicon.revoke.title")}
              onClick={() => openConfirm("revoke", a())}
            >
              {language.t("iris.lexicon.revoke")}
            </Button>
          </Show>
          <Show when={blocked() && a().status !== "executed"}>
            <span class="iris-lex-weak">{blocked()}</span>
          </Show>
        </div>
      </>
    )
  }

  function RaisePane() {
    const f = () => raising()!
    const t = () => AGREEMENT_TYPES.find((x) => x.id === f().type)
    return (
      <form class="iris-lex-form" onSubmit={submitRaise}>
        <div class="iris-lex-title">
          <div>
            <div class="iris-lex-name">{language.t("iris.lexicon.raise.title")}</div>
            <div class="iris-lex-sub">{language.t("iris.lexicon.raise.sub")}</div>
          </div>
          <IconButton
            type="button"
            icon="close"
            variant="ghost"
            size="small"
            title={language.t("common.cancel")}
            aria-label={language.t("common.cancel")}
            onClick={() => setRaising(undefined)}
          />
        </div>
        <div class="iris-lex-grid">
          <TextField
            required
            label={language.t("iris.lexicon.raise.case")}
            value={f().case}
            onChange={setField("case")}
            placeholder={language.t("iris.lexicon.raise.case.placeholder")}
          />
          <div class="iris-lex-select">
            <span>{language.t("iris.lexicon.raise.type")}</span>
            <Select
              size="small"
              options={TYPE_OPTIONS}
              current={t()}
              value={(x) => x.id}
              label={(x) => x.label}
              onSelect={(x) => x && setField("type")(x.id)}
              aria-label={language.t("iris.lexicon.raise.type")}
            />
          </div>
          <TextField
            required
            label={language.t("iris.lexicon.raise.signer")}
            value={f().name}
            onChange={setField("name")}
            placeholder={language.t("iris.lexicon.raise.asNamed")}
          />
          <TextField
            type="email"
            label={language.t("iris.lexicon.raise.email")}
            value={f().email}
            onChange={setField("email")}
            placeholder={language.t("iris.lexicon.raise.email.placeholder")}
          />
          <TextField
            label={language.t("iris.lexicon.raise.org")}
            value={f().org}
            onChange={setField("org")}
            placeholder={language.t("iris.lexicon.raise.optional")}
          />
          <TextField
            required
            label={language.t("iris.lexicon.raise.firm")}
            value={f().firm}
            onChange={setField("firm")}
            placeholder={language.t("iris.lexicon.raise.asNamed")}
          />
          <TextField
            label={language.t("iris.lexicon.raise.term")}
            value={f().term}
            onChange={setField("term")}
            placeholder={language.t("iris.lexicon.raise.term.placeholder")}
          />
          <TextField
            label={language.t("iris.lexicon.raise.expires")}
            value={f().expires}
            onChange={setField("expires")}
            placeholder={language.t("iris.lexicon.raise.expires.placeholder")}
          />
          <div class="iris-lex-wide">
            <TextField
              label={language.t("iris.lexicon.raise.template")}
              value={f().template}
              onChange={setField("template")}
              placeholder={language.t("iris.lexicon.raise.template.placeholder")}
            />
          </div>
          <div class="iris-lex-wide iris-lex-wording">
            <TextField
              multiline
              label={language.t("iris.lexicon.raise.wording")}
              value={f().body}
              onChange={setField("body")}
              placeholder={
                t()?.defaultWording
                  ? language.t("iris.lexicon.raise.wording.default")
                  : language.t("iris.lexicon.raise.wording.placeholder")
              }
            />
          </div>
        </div>
        <div class="iris-lex-actions">
          <Button type="submit" variant="primary" size="small" disabled={busy()}>
            <Show when={busy()} fallback={<Icon name="save" size="small" />}>
              <Spinner class="iris-ui-spin" />
            </Show>
            {language.t("iris.lexicon.raise.submit")}
          </Button>
          <Button type="button" size="small" onClick={() => setRaising(undefined)}>
            {language.t("common.cancel")}
          </Button>
          <Show when={raiseProblem(f())}>{(p) => <span class="iris-lex-weak">{p()}</span>}</Show>
        </div>
      </form>
    )
  }

  function ConfirmBody(c: () => Confirm) {
    const issue = () => c().kind === "issue"
    const who = () => recipients(c().a)
    const kind = () => c().a.kind ?? c().a.type
    return (
      <>
        <p class="iris-lex-sub">
          {issue()
            ? language.t("iris.lexicon.confirm.issue.body", { kind: kind(), id: c().a.id })
            : language.t("iris.lexicon.confirm.revoke.body", { kind: kind(), id: c().a.id })}
        </p>
        <ul class="iris-lex-recipients">
          <For each={issue() ? who() : who().slice(0, 1)}>
            {(r) => (
              <li>
                <span class="iris-ui-ic" aria-hidden="true">
                  <Icon name="at" size="small" />
                </span>
                <span class="iris-lex-party-name">{r.name}</span>
                <span class="iris-lex-weak">{r.email ?? r.role}</span>
              </li>
            )}
          </For>
        </ul>
        <Show
          when={issue()}
          fallback={
            <TextField
              multiline
              class="iris-lex-reason"
              label={language.t("iris.lexicon.confirm.revoke.why")}
              value={reason()}
              onChange={(v) => setReason(v)}
              placeholder={language.t("iris.lexicon.confirm.revoke.placeholder")}
              autofocus
            />
          }
        >
          <Notice tone="warning" icon={<Icon name="lock" size="small" />}>
            {language.t("iris.lexicon.confirm.issue.warning")}
          </Notice>
        </Show>
        <Show when={error()}>
          <Notice tone="critical" role="alert" icon={<Icon name="warning" size="small" />}>
            {error()}
          </Notice>
        </Show>
        <PaneDialogActions>
          <Button type="button" size="small" disabled={busy()} onClick={() => setConfirm(undefined)} autofocus={issue()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="small"
            disabled={busy() || (!issue() && !reason().trim())}
            onClick={runConfirm}
          >
            <Show when={busy()}>
              <Spinner class="iris-ui-spin" />
            </Show>
            {issue()
              ? language.t("iris.lexicon.confirm.issue.verb", { name: c().a.counterparty })
              : language.t("iris.lexicon.confirm.revoke.verb", { name: c().a.counterparty })}
          </Button>
        </PaneDialogActions>
      </>
    )
  }
}
